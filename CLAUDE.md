# go2rtc-viewer — Project Memory

LAN-only security-camera app. **No build tools, no package.json, no framework.**

## Architecture
- **Frontend** (`web/`): vanilla JS static files served by `python3 -m http.server 8000`.
  Two pages share `style.css`: viewer `index.html` (`app.js`) + management `streams.html` (`streams.js`, also loads `streams.css`).
- **go2rtc** Go binary (`bin/`, gitignored, downloaded by `start.sh`): reads `go2rtc.yaml`, serves `:1984` (WebRTC/MSE viewer + REST API).
- **recordings/**: Node helper, **standard-library only** (`server.js`, `download-cli.js`). No deps. Default backend is an **ONVIF Profile G client (`recordings/onvif.js`)** for vendor-neutral recording search + replay; the legacy **netsdk/flv.cgi** path is retained as an opt-in fallback via **`RECORDINGS_BACKEND=onvif|netsdk`** (default `onvif`). ONVIF times are UTC (`Z`) with measured clock-skew (NOT host-local like the legacy path); `chn` is a server-side stable index over RecordingTokens; the source-badge match includes `onvif`. Still **unverified against real Profile G hardware** (the on-hand unit 404s on `/onvif/*`) — best-effort.
- **bash**: `start.sh` (boots go2rtc), `stop.sh`, `gen-config.sh`.

## JS CONTRACT — never remove/rename these without updating the JS
`app.js`/`streams.js` query specific element `id`s, `[data-role]` hooks, and class/state toggles. Breaking them silently breaks the UI.
- **Viewer (`app.js`)** ids: `grid`, `empty-state`, `pane-template`, `conn-status`, `reload-btn`, `layout-switch`.
  `.layout-btn[data-layout in {1,2,4,6}]` ↔ `#grid.pane-grid[data-layout]`. `conn-status--{ok,warn,error,unknown}`.
  Pane `[data-role]`: `video-wrap`, `camera-select`, `addr`, `quality-badge`, `placeholder(-text)`, `overlay(-text)`, `hd-toggle`, `snapshot`, `fullscreen`.
  State: `.pane.is-empty/.is-unconfigured`, `.pane-video-wrap.is-live` (holds `<video-stream>` as firstElementChild), badge `SD`/`HD` + `.cam-badge--hd`.
- **Management (`streams.js`)** ids: `stream-grid`, `empty-state`, `card-template`, `modes`, `add-toggle/-form/-cancel`, `af-name/-src`, `add-msg`, `version-info`, `link-go2rtc/-add`,
  tabs `.tab[data-tab=streams|config|log|net]` ↔ panels `panel-{streams,config,log,net}`, `cfg-editor/-status/-dirty/-save/-reload/-download`, `log-{view,auto,newest,level,search,status,refresh,copy}`, `net-{frame,open,origin}`.
  Card `[data-role]`: `name`, `online(-text)`, `status-text`, `codecs`, `source`, `watch`, `info`, `probe`, `links`, `net`, `delete`.
- Both pages share header cluster order `[conn-status][reload-btn][view-switch][lang-switch][help]`; viewer adds `.layout-group` left. `.view-link.is-active` = current page. `.lang-switch .lang-btn[data-lang=ja|en]` = language toggle (see i18n).
- **Enforcement**: the `contract-guard` subagent reviews `web/` changes for broken hooks; the `verify-ui` skill runs the Playwright regression checks.

## The `[hidden]` + `display` gotcha (bit us twice)
An element JS hides via the `hidden` attribute but that ALSO has a CSS `display:` rule stays visible (author `display` beats UA `[hidden]{display:none}`).
**Fix:** add an explicit `SELECTOR[hidden]{display:none}` guard. Existing guards: `.cam-overlay`, `.cam-badge`, `.add-form`, `.tabpanel`. Add one for any new show/hide-via-`hidden` element with a `display:` rule.

## Cache-busting `?v=N`
`index.html`/`streams.html` load CSS/JS (incl. `i18n.js`) with `?v=N` (currently **all v=10**). **Bump N on every CSS/JS change** or reloads serve stale assets. (recordings/ pages have no `?v=` — plain reload.)

## Secrets / .env flow (enforced by `secret-guard` hook)
- Real LAN IPs (`192.168.x`) + RTSP/DVR creds live **ONLY in the gitignored `.env`**. `.env.example` is the committed template.
- Committed files use `${VAR}` or RFC5737 placeholders (`192.0.2.x`) — never real values.
- `cameras.json` is **generated** (gitignored) from `cameras.template.json` by `gen-config.sh`.
- `start.sh` sources `.env` (`set -a; . ./.env; set +a`) before launching go2rtc.
- The `secret-guard` PreToolUse hook blocks Write/Edit of real private IPs/creds into committed files (`.env` exempt).

## go2rtc specifics
- Env substitution: `${VAR}` and `${VAR:default}` — **SINGLE colon**, NOT shell `${VAR:-default}`. Resolves from process env via `os.LookupEnv`. go2rtc does NOT auto-read `.env` (start.sh exports it).
- Config API: `GET /api/config` returns raw YAML; **`POST /api/config` writes the body VERBATIM (preserves comments)** — the config editor uses POST ONLY. **Never `PATCH`** (reserializes, destroys comments). Apply changes with `POST /api/restart`.

## Client security defaults (publish hardening — don't regress)
- **CSP**: all 3 HTML pages ship a `<meta http-equiv="Content-Security-Policy">`. `script/img/media/connect-src` allow only `'self'` + `http://localhost:1984` + `http://127.0.0.1:1984` (streams.html adds `frame-src` for the net iframe; recordings.html is same-origin only). **Pointing the dashboard at another go2rtc host** (`?go2rtc=` / cameras.json `go2rtc`) **requires adding that origin to the meta CSP**, else video-stream.js/fetches are blocked. `style-src` keeps `'unsafe-inline'` (go2rtc's video-stream.js shadow styles).
- **`frame-ancestors` does NOT work in a `<meta>` CSP** (HTTP-header only — emits a console error if present, which fails verify-ui `console_clean`). Clickjacking guard lives as `X-Frame-Options: DENY` in `recordings/server.js` (the one server we control); the `python3 -m http.server` pages can't set it.
- **`?go2rtc=` / `?api=` are validated** by `sanitizeBase()` (in app.js, streams.js, recordings.js): http(s) scheme + host must be loopback or RFC1918 LAN, else falls back to the default. Keep this when editing `resolveGo2rtcBase`/`resolveBase`/`resolveApiBase`.
- **Shipped bind defaults are localhost-only**: `go2rtc.yaml` `api.listen: 127.0.0.1:1984`, `recordings/server.js` `BIND_ADDR` default `127.0.0.1`. Widen to `:1984` / `0.0.0.0` only for LAN-wide viewing (+firewall). `redactCredentials` (streams.js) masks userinfo (incl. `@`-in-password) AND sensitive query keys via regex (not `new URL()`, which breaks `ffmpeg:rtsp://…`).

## i18n (JA/EN — don't regress)
- Two dicts: `web/i18n.js` (viewer+management) and `recordings/public/i18n.js` (recordings), each a CLASSIC `<script>` loaded BEFORE the page's module script → exposes global `window.i18n = { t(key, vars), apply(rootEl), setLang, onChange, lang }`. Dicts are generated from a merged catalog; keep inline JA text and dict JA in sync.
- **Static text**: elements carry `data-i18n="KEY"` (textContent) / `data-i18n-title` / `-placeholder` / `-aria-label` (attrs). JA text stays inline as the fallback. `<html data-title-key="KEY">` sets the document title.
- **Dynamic JS strings**: `window.i18n.t('KEY', {var})` with `{var}` placeholders (NOT `${}`). After cloning a `<template>` (pane/card/row) call `window.i18n.apply(rootEl)`; on `window.i18n.onChange(...)` re-render dynamic content (JS-set text doesn't auto-retranslate).
- Do NOT put `data-i18n` on runtime-dynamic text (`version-info`, stream names, IPs, log lines, camera-select options) — `apply()` would clobber it; translate those in JS via `t()`.
- **Default lang**: `'en'` (English-first). Stored `localStorage['seccam.lang']` overrides; Japanese is opt-in via the header toggle. `verify-ui` pins `seccam.lang=ja` via `addInitScript` so JA assertions stay stable, and has a `lang_toggle` check (EN switches, JA restores).

## Run & verify
- Start: `./start.sh` (go2rtc on `:1984`) + `python3 -m http.server 8000`. Pages at `http://localhost:8000/web/{index,streams}.html`.
- Verify with the **`verify-ui`** skill (drives a real browser via `playwright-cli`).
- `playwright-cli run-code` runs `async page => {...}` in NODE context: use `page.evaluate(() => ...)` for DOM, and `page.waitForTimeout` (`setTimeout` is unavailable).
- Shell is **zsh with noclobber**: use `>!` or `rm` first to overwrite files.
