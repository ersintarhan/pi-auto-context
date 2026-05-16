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
