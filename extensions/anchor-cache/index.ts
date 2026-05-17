/**
 * anchor-cache — Anthropic prompt-cache breakpoint optimization for pi-auto-context.
 *
 * Problem
 * -------
 * pi-auto-context truncates tool results older than the most recent on-branch
 * anchor. On Anthropic, that mutation poisons the default rolling `last_user`
 * cache marker because the 20-block lookback window misses prior writes and
 * every turn pays full prefix cost.
 *
 * Approach (post-0.2.2 design — battle-tested layout)
 * ---------------------------------------------------
 * Rather than ADD markers (which collides with @mcowger/pi-better-messages-cache
 * and Anthropic's 4-marker hard limit), we **shift** the existing rolling
 * message-level marker onto the last on-branch anchor's tool_result block.
 *
 *   pi default       : [system, tools, last_user]                = 3 markers
 *   + better-cache   : [system, tools, last_user, last_tool_use] = 4 markers
 *   our shift        : [system, tools, LAST_ANCHOR, last_tool_use] (replaces last_user)
 *
 * Net marker count: unchanged. TTL: 5m everywhere — Anthropic requires
 * 1h-markers to come BEFORE 5m-markers in payload order (tools → system →
 * messages), and our anchor lives in `messages`, so it must match upstream
 * TTL. The cache win comes from the marker being on a STABLE block (the
 * anchor) instead of the moving `last_user` target.
 *
 * Idempotency
 * -----------
 * - Tagged ownership via WeakMap<block, owner> — never written to the
 *   payload, so Anthropic's strict schema validator can't reject it.
 * - `purgeLegacyOwnerFields()` strips any stale `_anchorCacheOwner` field
 *   left over from 0.2.0 / 0.2.1 on resumed sessions.
 * - `enforceMarkerLimit(4)` as a final safety net, protecting our anchor
 *   marker and evicting foreign markers oldest-first.
 *
 * Verification
 * ------------
 * Anthropic responses include `usage.cache_read_input_tokens` and
 * `usage.cache_creation_input_tokens`. After 2-3 anchored turns:
 *   - cache_read grows steadily (prefix served from cache)
 *   - cache_creation stays near zero on turns without new anchors
 *
 * Set PI_ANCHOR_CACHE_DEBUG=1 to log chosen layout per request.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isAnthropicPayload,
	findToolResultBlock,
	setMessageMarker,
	dropMessageMarker,
	listMarkers,
	enforceMarkerLimit,
	purgeLegacyOwnerFields,
	type AnthropicPayload,
	type CacheControl,
} from "./anthropic-payload.js";
import { isAnchorEntry } from "../context/anchors.js";

/**
 * Anchor TTL. Default 1h — anchors are semantic boundaries that persist by
 * definition, so a long TTL pays off even with the 2x write cost (1h cache
 * writes are 2x base, vs 1.25x for 5m, but reads stay at 0.1x). On idle gaps
 * >5min the 1h marker keeps the prefix alive where 5m would drop it.
 *
 * Override via env: `PI_ANCHOR_CACHE_TTL=5m` to force shorter TTL.
 *
 * Anthropic's TTL-ordering rule: longer TTLs must come first in payload order
 * (tools → system → messages). When we install a 1h anchor in `messages`, we
 * must also UPGRADE any pre-existing tools/system markers to 1h — leaving
 * them at 5m would produce 'ttl=1h must not come after ttl=5m'. We do not
 * touch message-level markers AFTER the anchor (rolling last_user /
 * last_tool_use); 5m markers after a 1h marker are valid.
 */
function resolveAnchorTTL(): "5m" | "1h" {
	const env = process.env.PI_ANCHOR_CACHE_TTL;
	if (env === "5m" || env === "1h") return env;
	return "1h";
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event, ctx) => {
		const payload = event.payload as unknown;
		if (!isAnthropicPayload(payload)) return; // not Anthropic — no-op

		// Strip any stale _anchorCacheOwner fields stamped by 0.2.0 on resumed
		// sessions. Anthropic's API rejects unknown fields server-side.
		purgeLegacyOwnerFields(payload);

		// Find on-branch anchor toolResult entries; we want the last (newest) one.
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		let lastAnchorToolCallId: string | null = null;
		for (const entry of branch) {
			if (!isAnchorEntry(entry)) continue;
			const tcid = (entry as any)?.message?.toolCallId;
			if (typeof tcid === "string" && tcid.length > 0) lastAnchorToolCallId = tcid;
		}
		if (!lastAnchorToolCallId) {
			if (process.env.PI_ANCHOR_CACHE_DEBUG) console.error("[anchor-cache] no on-branch anchors — passthrough");
			return; // no anchors yet — nothing to do
		}

		const anchorLoc = findToolResultBlock(payload, lastAnchorToolCallId);
		if (!anchorLoc) {
			if (process.env.PI_ANCHOR_CACHE_DEBUG) console.error(`[anchor-cache] anchor ${lastAnchorToolCallId} not in payload — passthrough`);
			return; // anchor not in payload (truncated out?) — bail safely
		}

		const anchorTTL = resolveAnchorTTL();
		const anchorControl: CacheControl = { type: "ephemeral", ttl: anchorTTL };

		// Strategy: shift the rolling message-level marker onto the anchor block.
		// Drop existing message-level markers BEFORE the anchor (they'd violate
		// TTL ordering: 5m before 1h is invalid). Leave message markers AFTER the
		// anchor alone — 5m after 1h is valid, and those are rolling markers we
		// don't want to interfere with.
		const beforeMarkers = listMarkers(payload);
		let droppedPreAnchor = 0;
		for (const m of beforeMarkers) {
			if (m.section !== "messages") continue;
			if (m.idx > anchorLoc.msgIdx) continue; // post-anchor markers can stay (5m after our TTL is fine)
			if (m.idx === anchorLoc.msgIdx && m.blockIdx! >= anchorLoc.blockIdx) continue;
			dropMessageMarker(payload, m.idx, m.blockIdx!);
			droppedPreAnchor++;
		}

		// Upgrade tools+system markers to match anchor TTL when going 1h, otherwise
		// the ordering rule rejects the request (1h in messages cannot follow 5m
		// in tools/system). For 5m anchor this is a no-op since upstream is
		// already 5m (or longer).
		if (anchorTTL === "1h") {
			upgradePrefixMarkersTo1h(payload);
		}

		// Install our anchor marker (owned by us).
		setMessageMarker(payload, anchorLoc.msgIdx, anchorLoc.blockIdx, anchorControl, "last_anchor");

		// Safety net: 4-marker hard limit. If another extension runs after us
		// and pushes count over 4, this enforces; our anchor is protected,
		// foreign markers evict first (oldest → newest).
		const droppedByLimit = enforceMarkerLimit(payload, 4);

		if (process.env.PI_ANCHOR_CACHE_DEBUG) {
			const finalMarkers = listMarkers(payload).map(m =>
				`${m.section}#${m.idx}${m.blockIdx !== undefined ? `[${m.blockIdx}]` : ""}` +
				`${m.owner ? `=${m.owner}` : ""}` +
				`${m.control.ttl ? `(${m.control.ttl})` : "(5m)"}`
			);
			console.error(
				`[anchor-cache] ttl=${anchorTTL} anchor=msg${anchorLoc.msgIdx}[${anchorLoc.blockIdx}] ` +
				`dropped-pre=${droppedPreAnchor} dropped-by-limit=${droppedByLimit} ` +
				`final=[${finalMarkers.join(", ")}]`
			);
		}

		return event.payload;
	});
}

/**
 * Upgrade all tools+system cache_control markers to 1h. Required when we
 * install a 1h anchor marker in `messages`, because Anthropic rejects payloads
 * where a later block has longer TTL than an earlier one.
 *
 * Cost analysis: 1h writes are 2x base vs 1.25x for 5m. But tools/system are
 * STABLE across turns — they're written once per cache-key change and then
 * read 0.1x for every subsequent turn. 2x write amortizes after ~2 reads. In
 * a typical session we expect 10s-100s of reads per write, so net cost
 * decreases significantly while idle-tolerance jumps from 5min to 1h.
 */
function upgradePrefixMarkersTo1h(payload: AnthropicPayload): void {
	if (payload.tools) {
		for (const t of payload.tools) {
			if (t.cache_control) t.cache_control = { type: "ephemeral", ttl: "1h" };
		}
	}
	if (payload.system) {
		for (const s of payload.system) {
			if (s.cache_control) s.cache_control = { type: "ephemeral", ttl: "1h" };
		}
	}
}
