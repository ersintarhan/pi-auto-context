# pi-auto-context

[![npm](https://img.shields.io/npm/v/@ersintarhan/pi-auto-context.svg)](https://www.npmjs.com/package/@ersintarhan/pi-auto-context)
[![license](https://img.shields.io/npm/l/@ersintarhan/pi-auto-context.svg)](./LICENSE)

A [pi](https://pi.dev) package that gives the agent **automatic context management** — anchors, pivots, cross-session recall — through tool calls.

Trimmed-down fork of [tshu-w/pi-control](https://github.com/tshu-w/pi-control) focused purely on context discipline. The session/tree/model routers from upstream are intentionally removed; the agent uses pi's built-in slash commands for those.

## What's in the box

**Tool** (extension)

| Tool | Actions |
|---|---|
| `context` | `view`, `recall`, `anchor`, `pivot` |

**Skill**

`context-management` — teaches the agent when and how to use the tool: anchor at task boundaries, pivot before changing direction, recall prior sessions.

**Automatic behaviors**

- **Status line** — appended after the last user message every turn:
  ```
  [pi-auto-context] model=<provider/id> | context=<n>% | tool=<n>% | anchor=<name> (-<dist>)
  ```
  `tool=` is the share of active context occupied by tool results. `anchor=` shows the most recent on-branch anchor and how many entries back it lives.
- **Auto-truncation** — tool results older than the last anchor are clipped to ~100 chars to keep the window lean. Anchors themselves stay verbatim.
- **Anchor reminder** — once per session, after 10+ entries with no anchors, the status line gets a `hint=no-anchors-yet` flag.
- **Anchor-aware prompt cache** (Anthropic only) — attaches a `cache_control` marker with 1-hour TTL to the last on-branch anchor's `tool_result` block so the prefix from the request boundary up to the anchor stays cache-hit indefinitely. Without this, auto-truncation between anchors invalidates the rolling `last_user` marker and every turn pays full prefix cost.

## How the anchor-aware cache works

Anthropic's Messages API allows at most 4 `cache_control` breakpoints per request, with a 20-block lookback window per breakpoint (counted across `tools` + `system` + `messages`). pi's default layout uses 3 — system, tools, last_user — none of which are anchored to a stable point in the conversation, so heavy auto-context truncation between anchors causes the lookback window to miss prior writes and full re-process the prefix every turn.

pi-auto-context inspects every outgoing Anthropic-shaped payload in `before_provider_request` and rewrites the markers:

| Mode | Trigger | Marker layout |
|---|---|---|
| **aggressive** | `system + tools ≤ 17` blocks | `[tools (covers system via lookback, 5m), mid_anchor (1h), last_anchor (1h), last_tool_use (5m)]` |
| **safe-shift** | `system + tools > 17` blocks | `[system (5m), tools (5m), last_anchor (1h), last_tool_use (5m)]` |

The rolling `last_user` marker that pi adds by default is sacrificed in both modes — it overlaps with `last_tool_use` from the same turn, so cache value is duplicate.

Detection of OAuth mode (Claude Code) is automatic. The OAuth adapter's billing-header block stays in the payload even when its marker is dropped, so billing claims still work.

### Coexistence with pi-better-messages-cache

[`@mcowger/pi-better-messages-cache`](https://www.npmjs.com/package/@mcowger/pi-better-messages-cache) is a sibling extension that adds an extra rolling marker on the last assistant `tool_use` block. It also fixes a streaming JSON parse bug in the Anthropic SDK that is valuable on its own. Both extensions coexist:

- better-cache loads alphabetically first (`@mcowger/...` < `pi-auto-context`), so its `before_provider_request` handler runs before ours.
- We inspect the payload it produces, add the anchor marker, and let our 4-marker enforcement evict the oldest **foreign** message marker first — our anchor markers are protected.
- Net 4-marker layout with both installed (native Anthropic): `[system, tools, last_anchor, last_tool_use]`.

Keep both installed. Removing better-cache costs you the streaming JSON parse fix and dual-cache wins on MiniMax/Kimi-style Anthropic-compatible APIs.

### Verifying it works

Anthropic responses include `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`. After 2-3 anchored turns:

- `cache_read_input_tokens` should grow steadily (prefix is being read from cache).
- `cache_creation_input_tokens` should stay near zero on turns without new anchors.

Set `PI_ANCHOR_CACHE_DEBUG=1` in your environment to print the chosen mode and final marker layout to stderr on every request.

## Install

```bash
pi install @ersintarhan/pi-auto-context
```

## Heads-up: private API hack

To execute `pivot` from a tool call, pi-auto-context patches `ExtensionRunner.prototype.bindCommandContext` at runtime — pi does not yet expose `navigateTree` as a public API.

The patch is idempotent and applied once on activation. If it fails (pi internal drift, version mismatch), `pivot` falls back to printing the equivalent slash command and the rest of the tool surface keeps working. Compatibility is therefore tighter than a normal extension; tested against `@earendil-works/pi-coding-agent` 0.74.x.

When pi adds a first-class API, the hack goes away. Tracking upstream at [earendil-works/pi#2023](https://github.com/earendil-works/pi/issues/2023).

## License

MIT. Originally based on [tshu-w/pi-control](https://github.com/tshu-w/pi-control).
