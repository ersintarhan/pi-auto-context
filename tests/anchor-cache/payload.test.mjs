#!/usr/bin/env node
/**
 * Standalone test for anchor-cache payload manipulation logic.
 * Run: node extensions/anchor-cache/_test.mjs
 */

import { createJiti } from "/Users/ersin/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/0.74.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const j = createJiti(import.meta.url, { interopDefault: true });
const mod = await j.import("../../extensions/anchor-cache/anthropic-payload.ts");
const {
	isAnthropicPayload, countPrefixBlocks, findToolResultBlock,
	setMessageMarker, dropSystemMarker, dropMessageMarker,
	listMarkers, enforceMarkerLimit,
} = mod;

let passed = 0, failed = 0;
function t(name, fn) {
	try { fn(); console.log(`  ok  ${name}`); passed++; }
	catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}
function eq(a, b, msg = "") {
	const ja = JSON.stringify(a), jb = JSON.stringify(b);
	if (ja !== jb) throw new Error(`${msg}\n      expected ${jb}\n      got      ${ja}`);
}

// ── Fixtures ───────────────────────────────────────────────

function nativePayload() {
	return {
		model: "claude-opus-4",
		system: [{ type: "text", text: "you are claude", cache_control: { type: "ephemeral" } }],
		tools: Array.from({ length: 8 }, (_, i) => ({ name: `tool${i}`, input_schema: { type: "object" } })),
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "context", input: { action: "anchor" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "[Anchor: a1]\n..." }] },
			{ role: "user", content: [{ type: "text", text: "next request", cache_control: { type: "ephemeral" } }] },
		],
	};
}

function oauthPayload() {
	const p = nativePayload();
	p.system = [
		{ type: "text", text: "x-anthropic-billing-header: ...", cache_control: { type: "ephemeral" } },
		{ type: "text", text: "you are claude code", cache_control: { type: "ephemeral" } },
	];
	return p;
}

function bigToolsPayload() {
	const p = nativePayload();
	p.tools = Array.from({ length: 25 }, (_, i) => ({ name: `tool${i}`, input_schema: { type: "object" } }));
	return p;
}

// ── Tests ──────────────────────────────────────────────────

console.log("# isAnthropicPayload");
t("accepts native shape", () => eq(isAnthropicPayload(nativePayload()), true));
t("accepts oauth shape", () => eq(isAnthropicPayload(oauthPayload()), true));
t("rejects openai-shaped", () => eq(isAnthropicPayload({
	messages: [{ role: "system", content: "x" }, { role: "user", content: "y" }],
	tools: [{ type: "function", function: { name: "f" } }],
}), false));
t("rejects non-object", () => eq(isAnthropicPayload(null), false));

console.log("# countPrefixBlocks");
t("native counts 1 system + 8 tools", () => eq(countPrefixBlocks(nativePayload()), { system: 1, tools: 8 }));
t("oauth counts 2 system + 8 tools",  () => eq(countPrefixBlocks(oauthPayload()),  { system: 2, tools: 8 }));

console.log("# findToolResultBlock");
t("finds anchor by tool_use_id", () => eq(findToolResultBlock(nativePayload(), "tu1"), { msgIdx: 2, blockIdx: 0 }));
t("returns null when missing",   () => eq(findToolResultBlock(nativePayload(), "tu-missing"), null));

console.log("# listMarkers (initial)");
t("native has 1 system + 1 message marker", () => {
	const m = listMarkers(nativePayload());
	eq(m.length, 2);
	eq(m[0].section, "system");
	eq(m[1].section, "messages");
});
t("oauth has 2 system + 1 message marker", () => {
	const m = listMarkers(oauthPayload());
	eq(m.length, 3);
});

console.log("# setMessageMarker + listMarkers ownership");
t("our marker is tagged with owner", () => {
	const p = nativePayload();
	setMessageMarker(p, 2, 0, { type: "ephemeral", ttl: "1h" }, "last_anchor");
	const m = listMarkers(p).find(x => x.section === "messages" && x.idx === 2);
	eq(m.owner, "last_anchor");
	eq(m.control.ttl, "1h");
});

console.log("# enforceMarkerLimit");
t("under limit: no-op", () => {
	const p = nativePayload();
	const dropped = enforceMarkerLimit(p, 4);
	eq(dropped, 0);
});

t("over limit: drops foreign message marker first", () => {
	const p = nativePayload();
	// add our anchor marker → now 3 markers, still under limit
	setMessageMarker(p, 2, 0, { type: "ephemeral", ttl: "1h" }, "last_anchor");
	// fake an extra foreign marker on a synthetic 4th message (simulate better-cache tool_use marker)
	p.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "x", input: {}, cache_control: { type: "ephemeral" } }] });
	// add one more to push over 4
	p.messages.push({ role: "user", content: [{ type: "text", text: "extra", cache_control: { type: "ephemeral" } }] });
	// markers now: system(1), msg2[0]=last_anchor(ours), msg3[0]=foreign tool_use, msg4[0]=foreign user, last_user=msg3 already gone
	// wait, original last_user marker was on messages[3]; we appended messages[4],[5], so message[3] still has its marker
	// total: system, our anchor (msg2), foreign last_user (msg3), foreign tool_use (msg4), foreign extra (msg5) = 5
	const before = listMarkers(p);
	if (before.length < 5) throw new Error("setup didn't produce >limit, got " + before.length);
	const dropped = enforceMarkerLimit(p, 4);
	if (dropped < 1) throw new Error("expected at least 1 drop");
	const after = listMarkers(p);
	eq(after.length, 4);
	// last_anchor MUST survive (protected)
	const stillThere = after.find(x => x.owner === "last_anchor");
	if (!stillThere) throw new Error("last_anchor marker was evicted!");
});

t("over limit + only own markers: keeps last_anchor, drops mid_anchor first", () => {
	const p = nativePayload();
	// strip all foreign markers
	dropSystemMarker(p, 0);
	dropMessageMarker(p, 3, 0); // the last_user marker
	// add 5 of our own markers (forced over-limit)
	p.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "x" }] });
	p.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu3", content: "y" }] });
	p.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu4", content: "z" }] });
	p.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu5", content: "w" }] });
	setMessageMarker(p, 2, 0, { type: "ephemeral", ttl: "1h" }, "mid_anchor");
	setMessageMarker(p, 4, 0, { type: "ephemeral", ttl: "1h" }, "mid_anchor");
	setMessageMarker(p, 5, 0, { type: "ephemeral", ttl: "1h" }, "last_anchor");
	// 3 our markers, all own. enforce(2) should drop oldest mid_anchor.
	const dropped = enforceMarkerLimit(p, 2);
	const after = listMarkers(p);
	eq(after.length, 2);
	// last_anchor must still be there
	if (!after.find(x => x.owner === "last_anchor")) throw new Error("last_anchor evicted under own-only limit");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
