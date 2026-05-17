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
	type CacheControl,
} from "./anthropic-payload.js";
import { isAnchorEntry } from "../context/anchors.js";

// 5m matches what pi's core + better-cache use upstream. Mixing 1h into
// messages while tools/system stay 5m violates Anthropic's TTL-ordering rule.
const TTL_ANCHOR: CacheControl = { type: "ephemeral", ttl: "5m" };

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

		// Strategy: shift the rolling message-level marker onto the anchor block.
		// Drop ALL existing message-level markers first so our anchor replaces
		// (rather than adds to) the marker count. tools/system markers stay
		// untouched — they cover upstream prefix.
		const beforeMarkers = listMarkers(payload);
		const messageMarkers = beforeMarkers.filter(m => m.section === "messages");
		for (const m of messageMarkers) {
			dropMessageMarker(payload, m.idx, m.blockIdx!);
		}

		// Install our anchor marker (5m, owned by us).
		setMessageMarker(payload, anchorLoc.msgIdx, anchorLoc.blockIdx, TTL_ANCHOR, "last_anchor");

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
				`[anchor-cache] anchor=msg${anchorLoc.msgIdx}[${anchorLoc.blockIdx}] ` +
				`shifted=${messageMarkers.length} dropped-by-limit=${droppedByLimit} ` +
				`final=[${finalMarkers.join(", ")}]`
			);
		}

		return event.payload;
	});
}
