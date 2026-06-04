# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-04

First public release. LAN-only security-camera viewer that transcodes H.265 (HEVC) cameras to H.264 via go2rtc + ffmpeg and plays them in the browser over WebRTC. Works with any RTSP-capable IP camera. Vanilla JS, no build tools, no framework, no npm dependencies. Developed and tested on macOS (Apple Silicon / arm64).

### Added

- **go2rtc transcoding pipeline**: H.265 → H.264 via go2rtc's built-in `ffmpeg` module, delivered over WebRTC with MSE / HLS fallback. Per camera, a low-res sub stream (default; optional PCMA audio) and a high-res main stream (video only); a camera already streaming H.264 can be used without transcoding.
- **`start.sh` / `stop.sh` / `gen-config.sh`**: `start.sh` auto-downloads the Apple Silicon go2rtc binary on first run, sources `.env`, generates `cameras.json`, launches go2rtc, and opens the built-in viewer at `http://localhost:1984`.
- **Multi-pane viewer** (`web/index.html`, `app.js`): 1 / 2 / 4 / 6 split layouts; per-pane camera selection from `cameras.json`; per-pane SD / HD toggle, snapshot, and fullscreen; layout + per-pane camera assignments persisted in `localStorage`; teardown of hidden `<video-stream>` WebRTC/WebSocket connections to prevent leaks; in-app help legend.
- **Stream-management page** (`web/streams.html`, `streams.js`) with four tabs:
  - Streams: card list with viewer count, source-connection status, codecs, redacted source; ~8s auto-refresh; watch / info / probe / links / net / delete actions; add stream via `PUT /api/streams`; playback-mode selector (WebRTC / MSE / HLS / MJPEG) persisted in `localStorage`.
  - Config: in-browser `go2rtc.yaml` editor reading `GET /api/config` and saving verbatim via `POST /api/config` (comments preserved; never `PATCH`); restart-from-page with auto-poll; backup download.
  - Log: `GET /api/log` polling (~3s) with level coloring, filter, search, newest-first, and copy.
  - Network: embedded, lazy-loaded go2rtc connection-path diagram.
- **Recordings backend** (`recordings/`, `server.js` + `download-cli.js`): Node standard-library only (no npm deps) + `ffmpeg`, on `http://localhost:3914`, independent of and co-runnable with the live viewer. Best-effort DVR netsdk `R.SearchRecord` / `flv.cgi` client (CLI + Web UI) and DVR status retrieval (`/netsdk/Stat`). Configurable via `DVR_HOST` / `DVR_USER` / `DVR_PASS` / `BIND_ADDR` / `PORT`.
- **Bilingual EN / JA UI** across viewer, management, and recordings pages via a no-build i18n layer (`window.i18n`), with a header language toggle. **English by default** (`localStorage['seccam.lang']` overrides; Japanese is opt-in via the toggle).
- **Multi-camera support**: add cameras as `cam2` / `cam3` … in `go2rtc.yaml` + `cameras.json` (a disabled `cam2` example is included); vendor-specific RTSP paths documented (ONVIF / Hikvision / Dahua).
- **Documentation**: English-default `README.md` + Japanese `README.ja.md` (and `recordings/` equivalents), `SECURITY.md`, `LICENSE` (Apache-2.0), and `NOTICE`.

### Security

- **Localhost-only default binds**: `go2rtc.yaml` `api.listen: 127.0.0.1:1984`; `recordings/server.js` `BIND_ADDR` default `127.0.0.1`. Widen only for trusted LAN use behind a firewall — never port-forward.
- **Content-Security-Policy** `<meta>` on all three HTML pages, restricting script/img/media/connect sources to `'self'` + localhost go2rtc.
- **Input validation** of `?go2rtc=` / `?api=` overrides: http(s) scheme and loopback/RFC1918 host only, otherwise falls back to the default.
- **Credential redaction** of RTSP/DVR userinfo and sensitive query keys in the management UI.
- **`X-Frame-Options: DENY`** on the recordings server as a clickjacking guard.
- **Secret hygiene**: real IPs and RTSP/DVR credentials live only in the gitignored `.env`; committed files use `${VAR}` or RFC5737 (`192.0.2.x`) placeholders; `cameras.json` is generated from `cameras.template.json`. A `secret-guard` hook blocks committing real private IPs/credentials.
- **No authentication by design**: security relies on a trusted LAN. Do not expose ports to the internet; use a VPN for remote access. Private vulnerability reporting via GitHub Security Advisory (see `SECURITY.md`).

### Notes

- **The DVR recording HTTP API is non-functional on the tested firmware.** On the tested Tsukamoto OEM XVR (FW 3.2.2.6F), `R.SearchRecord` returns 0 items even on a "success" response, and `cgi-bin/flv.cgi` returns HTTP 404 for all parameters (confirmed against real hardware). The bundled netsdk / `flv.cgi` clients are spec-compliant best-effort implementations that may work on other models/firmware, but this unit returns no recording index. **No auto-recorder is bundled** — to keep recordings, manually segment-capture the source camera's RTSP with `ffmpeg`. See `recordings/README.md` for the full investigation.
- **Platform**: macOS (Apple Silicon / arm64) only. Requires `ffmpeg` on PATH and Node.js (for the recordings backend); go2rtc is downloaded at runtime and not bundled.
- go2rtc (MIT) and FFmpeg (LGPL/GPL) are used as external binaries — downloaded/invoked at runtime, not bundled or redistributed.

[1.0.0]: https://github.com/aimsise/go2rtc-viewer/releases/tag/v1.0.0
