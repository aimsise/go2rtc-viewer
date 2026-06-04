---
name: verify-ui
description: Playwright regression check for the go2rtc-viewer go2rtc viewer/management UI. Drives a real browser against http://localhost:8000/web/{index,streams}.html and asserts the project's load-bearing invariants — header-actions parity across both pages, management tab switching (only the active panel visible), the [hidden]-overlay / [hidden]-add-form display:none guards, console-clean (no errors / favicon 404), every JS-"contract" data-role hook (pane + card), conn-status--ok, version-info, and HD label "画質HD". Use after editing web/ (HTML/CSS/JS) or before committing UI changes to catch a removed data-role hook, a re-introduced [hidden] bug, broken tabs, or a missing ?v= cache-bust.
---

# verify-ui — go2rtc-viewer viewer/management UI regression check

Runs the Playwright checks this project relies on (per the project README/CLAUDE.md and the
JS "contract"). Both the model and the user (`/verify-ui`) can invoke it. It is **read-only /
non-destructive**: it never saves go2rtc config and never deletes a stream. It only navigates,
reads the DOM, switches tabs, and toggles the add-form open/closed.

## What it checks

VIEWER (`web/index.html`, `app.js`) — `checks/viewer.js`:
- `header_order` — `.header-actions` children are exactly `[layout-group, conn-status, reload-btn, view-switch, lang-switch, help]`.
- `layout_buttons` — all four `#layout-switch .layout-btn[data-layout]` (1/2/4/6) exist.
- `pane_data_roles` — every pane hook present: `video-wrap, camera-select, addr, quality-badge, placeholder, placeholder-text, overlay, overlay-text, hd-toggle, snapshot, fullscreen`.
- `overlay_hidden_guard` — the capture overlay computes `display:none` when `hidden` (the [hidden] gotcha guard `.cam-overlay[hidden]{display:none}` is intact).
- `conn_status_ok` — `#conn-status` resolves to `conn-status--ok` (go2rtc reachable).
- `hd_label` — the HD toggle text is exactly `画質HD` (JA pinned via addInitScript `seccam.lang=ja`).
- `lang_toggle` — clicking `.lang-switch .lang-btn[data-lang=en]` switches the UI to English (`#reload-btn .btn-text` → `Reload`, `<html lang>` → `en`); clicking `ja` restores `更新`.
- `video_stream_firstchild` — when a pane is live, `<video-stream>` is the `firstElementChild` of `.pane-video-wrap` (SKIPped, counted as pass, if no camera is currently streaming).
- `console_clean` — no console errors or page errors (catches the favicon 404 regression, module load failures, etc.).

MANAGEMENT (`web/streams.html`, `streams.js`) — `checks/management.js`:
- `header_order` — `.header-actions` children are exactly `[conn-status, reload-btn, view-switch, lang-switch, help]` (NO layout-group here).
- `tab_switching` — clicking each `.tab[data-tab=streams|config|log|net]` leaves only that `panel-*` visible (`display!=none`, `hidden=false`) with all others `hidden`+`display:none`, and marks the tab `.is-active`. Restores the streams tab afterward.
- `add_form_hidden_guard` — `#add-form` computes `display:none` when `hidden` (guard `.add-form[hidden]{display:none}` intact), and is a `grid` box when shown.
- `card_data_roles` — every card hook present: `name, online, online-text, status, status-text, codecs, source, watch, info, probe, links, net, delete`.
- `conn_status_ok` — `#conn-status` resolves to `conn-status--ok`.
- `version_info` — `#version-info` is populated from go2rtc (not the `go2rtc に接続中…` placeholder).
- `console_clean` — no console / page errors.

## Procedure

### Step 1 — Prerequisites (both services must be up)

The checks need go2rtc on `:1984` AND the static server on `:8000`. Probe both:

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:1984/api/streams   # go2rtc
curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/web/index.html # static server
```

- A `2x`/`3xx`/`4xx` HTTP code means the service answered (up). A curl failure / empty output means it is **down**.
- If **go2rtc** is down: tell the user to start it with `./start.sh` (from the repo root). go2rtc reads `go2rtc.yaml` and needs `.env` loaded; `start.sh` handles `set -a; . ./.env; set +a`.
- If the **static server** is down: tell the user to run `python3 -m http.server 8000` from the repo root.
- Do NOT start services yourself unless the user asks — they are LAN-facing. Just report what is down and the command to run, then stop.

If both answer, continue.

### Step 2 — Run the checks via the playwright-cli skill

Use the `playwright-cli` skill. `run-code` runs an `async page => {...}` in NODE context, so the
bundled scripts are passed in directly. Run each check (absolute paths — agent cwd resets between bash calls):

```
playwright-cli run-code "$(cat .claude/skills/verify-ui/checks/viewer.js)"    # repo-root relative
playwright-cli run-code "$(cat ${CLAUDE_SKILL_DIR}/checks/viewer.js)"        # ${CLAUDE_SKILL_DIR} survives cwd changes
playwright-cli run-code "$(cat ${CLAUDE_SKILL_DIR}/checks/management.js)"
```

The scripts navigate to the right URL themselves, wait for app.js/streams.js to settle
(`page.waitForTimeout`, NOT `setTimeout`), read the DOM via `page.evaluate`, and each returns
a `JSON.stringify(...)` string.

### Step 3 — Read the JSON results and report PASS/FAIL

Each script returns:

```json
{
  "page": "viewer",            // or "management"
  "ok": true,                  // false if ANY check failed
  "failed": ["check_name"],    // names of failing checks (empty when ok)
  "checks": {
    "header_order": { "pass": true,  "detail": "order=layout-group > conn-status > ..." },
    "pane_data_roles": { "pass": false, "detail": "MISSING data-role: snapshot" }
  }
}
```

Report a per-check PASS/FAIL table for both pages, then an overall PASS only if **both**
`ok` are `true`.

## Interpreting failures (each FAIL is a real regression)

- `pane_data_roles` / `card_data_roles` FAIL → a `[data-role]` hook was renamed/removed in the HTML template; `app.js`/`streams.js` `querySelector('[data-role="…"]')` will return null and break. Restore the hook.
- `overlay_hidden_guard` / `add_form_hidden_guard` FAIL → the **[hidden] gotcha** is back: an element with an author `display:` rule lost its `SELECTOR[hidden]{display:none}` guard and stays visible. Re-add the guard (`.cam-overlay[hidden]{display:none}` in style.css / `.add-form[hidden]{display:none}` in streams.css).
- `header_order` FAIL → header cluster order drifted between the two pages (the parity convention). Reorder `.header-actions` children.
- `tab_switching` FAIL → tab → panel wiring broke (missing `data-tab`, `panel-*` id, the `.tabpanel[hidden]{display:none}` guard, or the `.is-active` toggle).
- `hd_label` FAIL → the HD toggle text is no longer exactly `画質HD`.
- `console_clean` FAIL → a console/page error appeared (favicon 404, a module that 404'd because a `?v=` bump was missed and a stale file is cached, a JS exception). If a CSS/JS edit isn't reflected, confirm the `?v=N` was bumped in index.html/streams.html.
- `conn_status_ok` / `version_info` FAIL → go2rtc was not reachable from the page during the run; re-check Step 1 (`:1984` up, `.env` loaded via `start.sh`).
- `video_stream_firstchild` reported as `SKIP` is expected when no camera is currently streaming; it only asserts when a live pane exists.
