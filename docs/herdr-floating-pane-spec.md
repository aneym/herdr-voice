# Feature: `placement = "floating"` for plugin panes

Non-modal floating plugin pane, anchored to a screen corner, rendered above the
pane grid. Fork feature 7; designed to be upstreamable (see "Upstream case").

## Motivation

Plugin authors today choose between:

- `popup` — floats, but **session-modal**: it captures all terminal input until
  it closes. Unusable for a persistent HUD you glance at while typing into an
  agent pane.
- `split` / `tab` — non-modal, but consume the layout and don't follow you
  across workspaces. Wrong shape for ambient state.

There is no placement for the "heads-up display" class of plugin: voice
control transcripts, CI status, notification tickers, agent-fleet monitors,
token-usage badges. `floating` fills that gap.

## Behavior spec

1. **Rendering.** A floating pane renders above the pane grid (same layer
   discipline as the popup), sized by `width`/`height` (cells or `%`), anchored
   by `anchor` = `top_right` (default) | `top_left` | `bottom_right` |
   `bottom_left` (snake_case, matching herdr wire convention, e.g. `recent_unwrapped`), inset by 1 cell from each screen edge it anchors to. It
   renders above pane content and below any active modal popup.
2. **Session-global.** Like the sidebar, a floating pane is independent of the
   workspace tree: switching workspaces/tabs does not close or move it. It
   appears in `pane.list` with `"floating": true` and no `workspace_id`.
3. **Non-modal input.** Keyboard input continues to flow to the focused pane in
   the grid. The floating pane receives keyboard input ONLY while explicitly
   focused (below). Mouse events are hit-tested against the floating region
   FIRST (it is visually on top); clicks inside it go to its pty, clicks
   outside behave as today.
4. **Focus toggle.** `pane.focus {pane_id}` works on a floating pane: keyboard
   focus moves to it and the previously focused grid pane is remembered.
   Focusing any grid pane (or `pane.focus_direction`, which skips floating
   panes) returns keyboard flow to the grid. A focused floating pane gets the
   accent border; unfocused it gets the unfocused-border tone at reduced
   priority (it should read as chrome, not a peer pane).
5. **Lifecycle.** Opened via `plugin.pane.open {plugin_id, entrypoint}` exactly
   like other plugin panes; closes when its command exits or via `pane.close`.
   At most one instance per plugin pane id (re-open focuses the existing one).
   Server shutdown/restart does not persist floating panes (they are ephemeral
   by definition; the owning plugin/daemon reopens them).
6. **Size floor.** Minimum 20 cols × 4 rows after clamping; if the terminal is
   too small to honor width/height, clamp rather than refuse.

## Manifest surface

```toml
[[panes]]
id = "hud"
title = "voice"
placement = "floating"
anchor = "top_right"   # optional, floating-only, default top_right
width = "42%"          # cells or %
height = 12
command = ["node", "src/ui.js"]
```

`anchor` on a non-floating placement is a manifest validation error.

## Open-time override (compatibility path)

`plugin.pane.open` gains optional fields:

```json
{ "plugin_id": "herdr-voice", "entrypoint": "hud",
  "placement": "floating", "anchor": "top_right",
  "width": "42%", "height": 12 }
```

Any of `placement`/`anchor`/`width`/`height` override the manifest entry for
this open only. This matters for ecosystem compatibility: a plugin can keep a
stock-safe manifest (`placement = "popup"`) — installable on any herdr — while
a caller that KNOWS the server supports floating requests it at open time.
Older servers reject the unknown field with `invalid_request`, so callers can
fall back to a plain open. (Manifest-declared `placement = "floating"` remains
supported for plugins that set `min_herdr_version` accordingly.)

## Non-goals (v1)

- `pane.send_input` on floating ids (grid-only in v1; `pane.send_text`/`send_keys`
  cover the addressable-input need — verified ruling 2026-07-31).

- Dragging/resizing with the mouse.
- Multiple simultaneous floating panes per plugin pane id.
- Persistence across server restarts.
- Transparency/compositing effects.

## Acceptance tests

- Open floating pane → appears at anchor with configured size; grid layout is
  untouched (no reflow); `pane.list` shows it flagged, without workspace_id.
- Type while floating pane open and a grid pane focused → bytes reach the grid
  pane's pty, none reach the floating pty.
- Click inside the floating region → mouse event reaches the floating pty;
  click on a grid pane beneath/beside it → normal focus/click behavior.
- `pane.focus` on the floating pane → keyboard reaches its pty; focusing a grid
  pane returns keyboard to the grid; `pane.focus_direction` never lands on it.
- Switch workspace/tab → floating pane still visible and running.
- Command exits → pane disappears; `plugin.pane.open` again → fresh instance.
- Modal popup opened while floating pane visible → popup renders above it and
  captures input (existing popup semantics unchanged); on popup close the
  floating pane is intact.
- Terminal resize → floating pane re-anchors and clamps to the size floor.

## Upstream case (PR framing for herdrdev/herdr)

**Direct precedent — this is the deferred v2 of upstream's own feature.**
Issue #1125 ("Temporary floating popup panes for plugins", from discussion
#782) produced today's `popup` placement, shipped in v0.7.4. In that thread:

- maintainer (ogulcancelik): "it's quite hard to make floating panes proper
  and robust. **v1 gonna be session wide one floating pane for now** i'm
  afraid. depending on the request i can explore [more]" — i.e. richer
  floating panes were *deferred for effort*, not rejected.
- markjaquith: temporary plugin-owned floating panes "100% fit Herdr".
- danielo515: wants them for ad-hoc terminals and asks for end-user access
  without a plugin — both served by this placement (an ad-hoc-terminal plugin
  becomes trivial).
- jjuchara: built `herdr-flash` against the popup — the ambient-UI class keeps
  appearing.

This PR deliberately keeps the maintainer's v1 constraints — **still one
session-wide floating pane** (singleton), same render layer — and adds only
the deferred properties: non-modal input and corner anchoring. And it arrives
implemented with e2e tests, which removes the stated "hard to make proper and
robust" cost.

- **Ecosystem gap, not a niche want**: every "ambient status" plugin currently
  has no honest placement. Concrete shipped example: herdr-voice (marketplace
  plugin — voice control with a live transcript HUD) must choose between a
  modal popup and a docked split today. Monitors like llmtrim badges or
  agent-fleet status would use this immediately.
- **Additive and small**: one new placement variant reusing the popup's render
  layer; no API changes (`plugin.pane.open` unchanged); no behavior change for
  any existing placement; manifest validation rejects it on older versions via
  `min_herdr_version`, so plugin compatibility is explicit.
- **Input rules follow existing precedent**: mouse-first hit-testing mirrors
  the sidebar; keyboard-only-when-focused mirrors how the sidebar never steals
  typing. No new modality concepts.
- Ships with the acceptance tests above as e2e tests.
