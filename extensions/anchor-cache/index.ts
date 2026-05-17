/**
 * anchor-cache — Anthropic prompt-cache breakpoint optimization for pi-auto-context.
 *
 * Problem this solves
 * -------------------
 * pi-auto-context truncates tool results older than the most recent on-branch
 * anchor to keep the context window lean. On Anthropic, that mutation poisons
 * the prompt cache because the default cache_control marker layout
 * [system, tools, last_user] (3 markers) doesn't protect any point near the
 * anchor — the 20-block lookback window misses prior writes, every turn pays
 * full prefix cost.
 *
 * The fix: install a stable cache_control marker on the last on-branch anchor's
 * tool_result block. Anchor markers don't move turn-to-turn the way last_user
 * does, so the prefix from request boundary up to the anchor stays cache-hit
 * indefinitely (5m or 1h TTL). Cost goes from ~95% writes to ~5% writes per
 * turn.
 *
 * Mode auto-detection
 * -------------------
 * - aggressive (when system + tools ≤ 17 blocks): drop the built-in system
 *   cache_control marker. system is covered via tools-marker lookback. Now we
 *   have 2 free slots, and we can install BOTH a mid_anchor (1h) and a
 *   last_anchor (1h). This gives two-tier cache hits.
 * - safe-shift (when system + tools > 17): keep system marker, but shift the
 *   rolling last_user marker onto the last anchor's tool_result block.
 *   Sacrifices last_user cache (1 turn of churn) for anchor lock-in.
 *
 * Coexistence
 * -----------
 * - Runs in the before_provider_request hook AFTER pi's built-in marker
 *   placement and AFTER any provider override (e.g. pi-better-messages-cache).
 *   Hook chain iterates extensions in load order; pi-auto-context loads
 *   alphabetically after @mcowger/pi-better-messages-cache so we naturally
 *   get last-write-wins.
 * - Idempotent on the payload shape we produce: re-running detects our own
 *   markers (tagged with _anchorCacheOwner) and only adjusts what's missing.
 * - 4-marker enforcement evicts foreign markers first, our anchors last.
 *
 * Verification
 * ------------
 * Cache effectiveness shows up in response.usage.cache_read_input_tokens vs
 * cache_creation_input_tokens; we don't measure here, just enable the API to
 * do the right thing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isAnthropicPayload,
	countPrefixBlocks,
	findToolResultBlock,
	setMessageMarker,
	dropSystemMarker,
	dropMessageMarker,
	listMarkers,
	enforceMarkerLimit,
	purgeLegacyOwnerFields,
	type AnthropicPayload,
	type CacheControl,
} from "./anthropic-payload.js";
import { isAnchorEntry } from "../context/anchors.js";

const TTL_ANCHOR: CacheControl = { type: "ephemeral", ttl: "1h" };
const TTL_USER:   CacheControl = { type: "ephemeral", ttl: "5m" };

const AGGRESSIVE_PREFIX_BUDGET = 17; // leave 3 blocks of slack under Anthropic's 20-block lookback

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event, ctx) => {
		const payload = event.payload as unknown;
		if (!isAnthropicPayload(payload)) return; // not Anthropic — no-op

		// Strip any stray _anchorCacheOwner fields left over from 0.2.0. Anthropic's
		// API rejects unknown fields on tool_result / text / tool_use blocks.
		purgeLegacyOwnerFields(payload);

		// Find on-branch anchor toolResult entries (oldest → newest). We need
		// toolCallId from the AgentMessage to look up the tool_use_id inside
		// the Anthropic payload's tool_result blocks.
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		const anchorEntries: Array<{ toolCallId: string }> = [];
		for (const entry of branch) {
			if (!isAnchorEntry(entry)) continue;
			const tcid = (entry as any)?.message?.toolCallId;
			if (typeof tcid === "string" && tcid.length > 0) anchorEntries.push({ toolCallId: tcid });
		}
		if (anchorEntries.length === 0) return; // no anchors yet — nothing to do

		const lastAnchor = anchorEntries[anchorEntries.length - 1];
		const midAnchor  = anchorEntries.length >= 2 ? anchorEntries[anchorEntries.length - 2] : null;

		const { system, tools } = countPrefixBlocks(payload);
		const aggressive = system + tools <= AGGRESSIVE_PREFIX_BUDGET;

		const lastAnchorLoc = findToolResultBlock(payload, lastAnchor.toolCallId);
		if (!lastAnchorLoc) return; // anchor not in payload (truncated out?) — bail safely

		if (aggressive) {
			// AGGRESSIVE: drop ALL built-in system markers (covered via lookback from tools marker),
			// install last_anchor (1h) and, when present, mid_anchor (1h).
			if (payload.system) {
				for (let i = 0; i < payload.system.length; i++) dropSystemMarker(payload, i);
			}
			setMessageMarker(payload, lastAnchorLoc.msgIdx, lastAnchorLoc.blockIdx, TTL_ANCHOR, "last_anchor");
			if (midAnchor) {
				const midLoc = findToolResultBlock(payload, midAnchor.toolCallId);
				if (midLoc) setMessageMarker(payload, midLoc.msgIdx, midLoc.blockIdx, TTL_ANCHOR, "mid_anchor");
			}
		} else {
			// SAFE-SHIFT: keep system marker(s); install last_anchor only.
			// Rolling last_user marker (built-in or better-cache) will be evicted by enforceMarkerLimit.
			setMessageMarker(payload, lastAnchorLoc.msgIdx, lastAnchorLoc.blockIdx, TTL_ANCHOR, "last_anchor");
		}

		// Enforce the 4-marker hard limit. Our anchor markers are protected;
		// foreign rolling markers (last_user, etc.) drop first.
		enforceMarkerLimit(payload, 4);

		// Debug breadcrumb — surfaces in pi's debug log without spamming users.
		if (process.env.PI_ANCHOR_CACHE_DEBUG) {
			const finalMarkers = listMarkers(payload).map(m => `${m.section}#${m.idx}${m.blockIdx !== undefined ? `[${m.blockIdx}]` : ""}${m.owner ? `=${m.owner}` : ""}${m.control.ttl ? `(${m.control.ttl})` : ""}`);
			console.error(`[anchor-cache] mode=${aggressive ? "aggressive" : "safe-shift"} anchors=${anchorEntries.length} markers=[${finalMarkers.join(", ")}]`);
		}

		return event.payload;
	});
}
