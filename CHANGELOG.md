# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[semver](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-05-17

### Added
- **Anchor-aware Anthropic prompt-cache breakpoint optimization** — attaches a `cache_control` marker with 1-hour TTL to the last on-branch anchor's `tool_result` block via `before_provider_request` hook. Solves the cost regression caused by auto-truncation invalidating the rolling `last_user` marker.
- Two operating modes selected automatically:
  - **aggressive** (`system + tools ≤ 17` blocks): drops the built-in system marker, installs `mid_anchor` + `last_anchor` for two-tier cache hits.
  - **safe-shift** (`system + tools > 17` blocks): keeps the system marker, installs `last_anchor` only.
- Coexists with `@mcowger/pi-better-messages-cache`: 4-marker enforcement evicts foreign markers first, our anchor markers are protected.
- Recognizes OAuth (Claude Code) payloads by structural check; billing-header block stays intact.
- `PI_ANCHOR_CACHE_DEBUG=1` env var prints chosen mode and final marker layout per request.

### Internal
- New `extensions/anchor-cache/` sub-extension registered from the main `index.ts` factory.
- 14 unit tests for payload manipulation in `tests/anchor-cache/payload.test.mjs` (excluded from npm tarball).

## [0.1.1] — 2026-05-17

### Changed
- Add npm version and license badges to README.
- First release published via the GitHub Actions trusted-publisher workflow (provenance attestation included).

## [0.1.0] — 2026-05-17

Initial release. Trimmed-down fork of
[tshu-w/pi-control](https://github.com/tshu-w/pi-control) focused exclusively
on context discipline.

### Added
- `context` router tool with `view`, `recall`, `anchor`, `pivot` actions.
- Status-line injection appended after the last user message every turn:
  `[pi-auto-context] model=… | context=…% | tool=…% | anchor=… (-N)`.
- Auto-truncation of tool results older than the last on-branch anchor (~100 char clip).
- One-shot anchor reminder (`hint=no-anchors-yet`) after 10+ entries with no anchors.
- `context-management` skill that teaches the agent when and how to use the tool.

### Removed (vs. upstream pi-control)
- `sessions`, `tree`, `models` router tools (use pi's built-in `/resume`, `/tree`, `/model` slash commands instead).
- `grouped.ts` branch overview, `scanSessions`, `getEnabledModels`, `formatEntryPreview`, `getEntryText`.
- All unused `command-actions` action kinds — only the pivot path remains.

### Notes
- Still patches `ExtensionRunner.prototype.bindCommandContext` at runtime to
  drive `navigateTree` from a tool call. Goes away once pi exposes a public
  `runWhenIdle()` API (upstream tracking issue: earendil-works/pi#2023).

[Unreleased]: https://github.com/ersintarhan/pi-auto-context/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ersintarhan/pi-auto-context/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ersintarhan/pi-auto-context/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ersintarhan/pi-auto-context/releases/tag/v0.1.0
