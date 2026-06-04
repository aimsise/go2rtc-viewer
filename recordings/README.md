**English** | [日本語](README.ja.md)

# Recordings (Playback) Feature — ONVIF Profile G Recording Viewer

This directory provides **recording search, replay, and download** for an NVR/DVR over **ONVIF Profile G** — a vendor-neutral standard (Recording Search + Replay Control + Device Management). It runs as a backend (Node standard modules + `ffmpeg`) that is **independent of the root go2rtc live viewer**, listens on a separate port `http://localhost:3914`, and stores exported clips under this `recordings/` directory.

The default backend (`RECORDINGS_BACKEND=onvif`) speaks ONVIF Profile G to any conformant NVR/DVR. A **legacy, vendor-specific netsdk/`flv.cgi` client** (for the Tsukamoto Musen OEM XVR and similar) is retained behind `RECORDINGS_BACKEND=netsdk` as an opt-in fallback — see [Legacy netsdk/flv.cgi Fallback](#legacy-netsdkflvcgi-fallback).

> **Important — best-effort, unverified against real Profile G hardware.**
> This is a spec-compliant ONVIF Profile G client, but it has **not** been validated end-to-end against a real Profile G NVR/DVR: the only on-hand unit **404s on every `/onvif/*` path** and does not answer unicast WS-Discovery Probe (see [Why the On-Hand Unit Cannot Be Used](#why-the-on-hand-unit-cannot-be-used-conclusions-from-on-device-testing)). The protocol logic (WS-Security PasswordDigest, SOAP envelopes, response parsing, Fault handling) is mechanically unit-tested, but treat live operation on your device as untested until you confirm it. The legacy netsdk path is likewise unverified on this unit (search returns 0 items, `flv.cgi` 404s).

> **⚠️ Security Warning (must read)**: The target devices may run with **`admin` / empty password**.
> Be sure to read the [Security Warning](#security-warning-must-read) for details, risks, and countermeasures.

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Starting and Stopping](#starting-and-stopping)
- [Usage (Web UI)](#usage-web-ui)
- [Usage (CLI)](#usage-cli)
- [Configuration (Environment Variables)](#configuration-environment-variables)
- [How It Works (Architecture)](#how-it-works-architecture)
  - [ONVIF Profile G flow](#onvif-profile-g-flow)
  - [Authentication & clock skew](#authentication--clock-skew)
  - [Channel ↔ RecordingToken mapping & UTC time](#channel--recordingtoken-mapping--utc-time)
  - [Replay window export — approach (A) and fallback (B)](#replay-window-export--approach-a-and-fallback-b)
- [Legacy netsdk/flv.cgi Fallback](#legacy-netsdkflvcgi-fallback)
- [Why the On-Hand Unit Cannot Be Used (Conclusions from On-Device Testing)](#why-the-on-hand-unit-cannot-be-used-conclusions-from-on-device-testing)
- [Troubleshooting](#troubleshooting)
- [Security Warning (must read)](#security-warning-must-read)
- [File Structure](#file-structure)

---

## Overview

| Item | Details |
| --- | --- |
| Default backend | **ONVIF Profile G** (Recording Search `tse` + Replay Control `trp` + Device Management `tds`) — vendor-neutral |
| Legacy backend | netsdk `R.SearchRecord` / `flv.cgi` (Tsukamoto Musen OEM XVR etc.), opt-in via `RECORDINGS_BACKEND=netsdk` |
| Authentication | WS-Security UsernameToken (PasswordDigest) → HTTP-Digest → Basic ladder (ONVIF); HTTP Basic (legacy netsdk) |
| Backend runtime | Node.js (standard modules only — `node:http`/`https`/`crypto`/`url`/`fs`/`path`/`child_process`) + `ffmpeg`. No npm dependencies |
| Port | `http://localhost:3914` (separate from go2rtc's `1984`; can coexist) |
| Export pipeline | ONVIF `GetReplayUri` → RTSP → `ffmpeg -c copy` → browser-playable MP4 |
| Storage location | Under this `recordings/` directory (outputs such as `data/` are `.gitignore`-d) |
| Viewing scope | **LAN only** (internet exposure is not intended) |

What this backend can do:

1. **Search recordings on a Profile G NVR/DVR** via `FindRecordings` / `GetRecordingSearchResults`, presenting them in the existing Web UI (search → play → download MP4 in the browser).
2. **Replay/export a time window** by resolving an RTSP replay URI (`GetReplayUri`) and remuxing it to MP4 with `ffmpeg -c copy`.
3. **Report device status** via `probe()` (reachability, chosen auth scheme, device time/skew, discovered service XAddrs, recording count).

> **This repository does not include an automatic recording feature (recorder).** It is a *viewer/exporter*: it pulls recordings that already exist on the NVR/DVR. If your device's ONVIF Profile G implementation does not expose recordings (or you are on the legacy unit where nothing works — see below), you can instead manually segment-capture the source camera's RTSP with `ffmpeg`, e.g.
> `ffmpeg -i rtsp://<cam>/ch0_0.264 -c copy -f segment -segment_time 600 out_%Y%m%d_%H%M%S.mp4`.

---

## Prerequisites

- **macOS (Apple Silicon / arm64)**
- **Node.js** installed (no additional npm packages required):

  ```sh
  command -v node
  ```

- **`ffmpeg`** installed (required for the RTSP → MP4 remux on export):

  ```sh
  command -v ffmpeg
  ```

  If nothing is displayed, install it via [Homebrew](https://brew.sh/):

  ```sh
  brew install ffmpeg
  ```

- Connected to the **same LAN** as the NVR/DVR (`ONVIF_HOST`).
- A modern browser capable of playing MP4 (H.264/H.265) (Safari / Chrome / Firefox / Edge).

---

## Starting and Stopping

The server in this directory is independent of the root go2rtc. **You may run both at the same time** (different ports: recordings = `3914`, live = `1984`).

**Start:**

```sh
# From the repository root
node recordings/server.js
# → opens http://localhost:3914 in your default browser
```

- Once started, the recordings UI / API listens at `http://localhost:3914`.
- To change the port, override it with the `PORT` environment variable (see [Configuration](#configuration-environment-variables)).
- The startup log prints the active backend (`onvif` by default) and, in ONVIF mode, the discovered service XAddrs and chosen auth scheme.

**Stop:**

- If started in the foreground, press `Ctrl+C` in that terminal.
- If started in the background, terminate the process from the terminal where you launched it
  (e.g., if you started with `node recordings/server.js &`, run `kill %1`).

> To start/stop live viewing (go2rtc), use the root `./start.sh` / `./stop.sh`.
> Because it is independent of the recordings server, starting/stopping only one of them is fine.

---

## Usage (Web UI)

Open `http://localhost:3914` in your browser.

1. Specify a **channel** and a **date-time range (start / end)**, then **search**.
   - Recordings on the NVR/DVR whose coverage overlaps the window are listed.
   - Each item shows its **start time, duration, and type chips** (ONVIF coverage is per-recording, not per-event — see the note below).
2. Selecting an item from the list plays it in the in-browser `<video>` element (the backend remuxes the ONVIF RTSP replay to MP4 on the fly).
3. Use the **Download** button to save the MP4 locally.

> **Recording types on ONVIF**: ONVIF Profile G exposes recording *coverage* (earliest/latest, tracks), not a Timing/Motion/Alarm/Manual event bitmask. Each item therefore defaults to the **`Timing`** type so the type chips/timeline still render. This is per-recording coverage, not per-event metadata.

---

## Usage (CLI)

You can try recording search and download from the terminal without a browser. The CLI is
`recordings/download-cli.js` (`server.js` is the server for the Web UI and has no subcommands). Treat `--help` as the source of truth for flags. Typical operations:

```sh
# Usage
node recordings/download-cli.js --help

# List recordings (today)
node recordings/download-cli.js --list

# Specify a range to search and download
#   --chn is 1-based, same as the UI display (--chn 1 = UI's ch1)
node recordings/download-cli.js --chn 1 \
  --begin "2026-06-02 00:00:00" --end "2026-06-02 23:59:59"
```

> The CLI honors the same `RECORDINGS_BACKEND` switch as the server. In ONVIF mode it lists/searches via the Profile G client and downloads via the replay RTSP URI → `ffmpeg` (seekable file output, `-movflags +faststart`).

---

## Configuration (Environment Variables)

Credentials and connection targets are **provided via environment variables** (read from the gitignored `.env`; see the repo-root `.env.example`). **Do not write secrets into the source.**

The backend reads `ONVIF_*` first and **falls back to the legacy `DVR_*`** if the ONVIF equivalent is unset (so an existing `.env` keeps working with no migration). `ONVIF_PASS ?? DVR_PASS ?? ''` preserves the intentional empty-password semantics.

### Backend selector

| Environment Variable | Default | Description |
| --- | --- | --- |
| `RECORDINGS_BACKEND` | `onvif` | `onvif` (default — ONVIF Profile G) or `netsdk` (legacy `flv.cgi` fallback) |

### ONVIF Profile G (default backend)

| Environment Variable | Default | Fallback | Description |
| --- | --- | --- | --- |
| `ONVIF_HOST` | (empty) | `DVR_HOST` | NVR/DVR IP / hostname (may include `:port`; default port 80) |
| `ONVIF_USER` | `admin` | `DVR_USER` | Username (WS-Security / HTTP-Digest / Basic) |
| `ONVIF_PASS` | (empty) | `DVR_PASS` | Password (empty string allowed) |
| `ONVIF_DEVICE_PATH` | `/onvif/device_service` | — | Device service entry path (override for non-standard units) — *optional* |
| `ONVIF_PORT` | from host or `80` | — | Explicit ONVIF port when not given as `host:port` — *optional* |
| `ONVIF_HONOR_XADDR` | `false` | — | `true` = POST to advertised `GetServices` XAddrs as-is; default rewrites them onto the configured `host:port` (XAddr-rewrite mitigation) — *optional* |
| `ONVIF_API_TIMEOUT_MS` | `15000` | `DVR_API_TIMEOUT_MS` | SOAP request timeout (→504 on miss) |

### Legacy / shared

| Environment Variable | Default | Description |
| --- | --- | --- |
| `DVR_HOST` / `DVR_USER` / `DVR_PASS` | `192.0.2.x` (placeholder) / `admin` / (empty) | **Legacy** netsdk credentials; also the fallback for the `ONVIF_*` equivalents above |
| `DVR_DEV` / `DVR_VER` / `DVR_MAX_CHN` | `XVR` / `1.0` / `9` | **Legacy, netsdk-only.** Unused in ONVIF mode (channel count is derived from the RecordingToken map) |
| `BIND_ADDR` | `127.0.0.1` | Listen address. Defaults to localhost-only. Use `0.0.0.0` only when exposing to the LAN |
| `PORT` | `3914` | Recordings server listen port |
| `FFMPEG_PATH` | (PATH) | `ffmpeg` location if not on `PATH` |

Example usage:

```sh
# ONVIF backend, password set, custom port
ONVIF_HOST=192.0.2.20 ONVIF_PASS='********' PORT=4000 node recordings/server.js

# Opt into the legacy netsdk/flv.cgi fallback
RECORDINGS_BACKEND=netsdk DVR_HOST=192.0.2.14 node recordings/server.js
```

> **Strongly recommended**: Always set a password on the NVR/DVR / camera and pass it via `ONVIF_PASS` (or `DVR_PASS`). For the dangers of operating with an empty password, see the [Security Warning](#security-warning-must-read).

---

## How It Works (Architecture)

In the default ONVIF Profile G mode, the backend speaks SOAP-over-HTTP to the NVR/DVR to discover services, search recordings, and resolve an RTSP replay URI, then remuxes that RTSP to a browser-playable MP4 with `ffmpeg -c copy`. The browser only ever talks to this backend's own origin (`localhost:3914`); all ONVIF/SOAP/RTSP traffic is server-side.

### ONVIF Profile G flow

```
                              recordings backend (localhost:3914)
                              ┌──────────────────────────────────────────┐
  ONVIF NVR/DVR               │  recordings/onvif.js (Profile G client)   │
  (ONVIF_HOST)                │                                           │
  ┌──────────────┐  SOAP/HTTP │  1. GetSystemDateAndTime  (unauth → skew) │
  │  tds device  │◀──────────▶│  2. GetServices           (→ XAddrs)      │
  │  tse search  │            │  3. FindRecordings +                      │
  │  trp replay  │            │     GetRecordingSearchResults (→ tokens)  │
  └──────┬───────┘            │  4. GetReplayUri          (→ rtsp:// URI) │
         │ RTSP replay        └───────────────────┬───────────────────────┘
         │ (Range/window)                         │ rtsp:// (+window+creds)
         ▼                                         ▼
                              ┌──────────────────────────────────────────┐
                              │  ffmpeg -rtsp_transport tcp -i <uri>      │
                              │         -c copy → fragmented/seekable MP4 │
                              └───────────────────┬───────────────────────┘
                                                  │ HTTP (MP4 / JSON)
                                                  ▼
                                        ┌──────────────────────┐
                                        │  Browser              │
                                        │  recordings UI @3914  │
                                        │  <video> MP4 play/DL  │
                                        └──────────────────────┘
```

1. **`GetSystemDateAndTime`** (unauthenticated, `tds`): read the device UTC clock and compute the skew used to stamp the WS-Security `Created` timestamp and every search/replay window.
2. **`GetServices`** (`tds`): discover the Search (`tse`) / Replay (`trp`) / Recording (`trc`) service XAddrs (falls back to `GetCapabilities`, then to the fixed `/onvif/search`, `/onvif/replay` paths).
3. **`FindRecordings`** + poll **`GetRecordingSearchResults`** (`tse`) until `Completed`: collect `RecordingInformation[]` (RecordingToken, Source, EarliestRecording, LatestRecording, tracks). Falls back to `trc GetRecordings` if Search is unsupported.
4. **`GetReplayUri`** (`trp`): resolve the RTSP replay URI for the selected RecordingToken.
5. **`ffmpeg -c copy`**: feed the replay RTSP (with the time window applied — see below) to `ffmpeg`, which remuxes (no re-encode) to a browser-playable MP4 streamed to the client.

### Authentication & clock skew

ONVIF auth varies by firmware, so the client uses a ladder: **WS-Security UsernameToken (PasswordDigest)** first, then **HTTP-Digest** (RFC 2617, recomputed on a `401 WWW-Authenticate: Digest`), then **Basic**. The chosen scheme is remembered for subsequent calls and surfaced via `probe()`/`/api/health`. PasswordDigest is `Base64(SHA1(base64decode(Nonce) + Created_utf8 + Password_utf8))` computed with `node:crypto`.

Wrong/skewed clocks are the #1 cause of `NotAuthorized` faults, so `GetSystemDateAndTime` is called **first** (unauthenticated) to measure `deviceUTC − now`; that skew is added to the `Created` header and to all search/replay windows.

### Channel ↔ RecordingToken mapping & UTC time

ONVIF identifies streams by opaque **RecordingToken**, not a 0-based channel number. The backend enumerates recordings once, sorts them by Source name then EarliestRecording, and assigns each a **stable 0-based `chn`** (cached server-side with a short TTL). The frontend keeps speaking `chn`/`channel` + Unix-second `begin`/`end`; the backend translates.

ONVIF `xs:dateTime` is **UTC** (`...Z`). All scope/replay times are formatted as UTC ISO-8601 with the measured skew applied — the legacy host-local `toDvrDateTime()` is **never** used for ONVIF.

### Replay window export — approach (A) and fallback (B)

`GetReplayUri` returns an RTSP URI that replays the *whole* recording; the requested `[start,end]` window must be applied at the RTSP layer. ffmpeg's RTSP demuxer does **not** emit the ONVIF replay headers (`Require: onvif-replay`, `Range: clock=`, `Rate-Control: no`) by itself, so:

- **Approach (A) — implemented default.** Append vendor time-range query params to the replay URI (`…?token=…&starttime=20260604T080000Z&endtime=20260604T090000Z`, compact ISO-8601 basic `YYYYMMDDThhmmssZ`) and let `ffmpeg -rtsp_transport tcp -i <uri> -c copy` pull it. Works on common Hikvision/Dahua/Axis variants and reuses the existing ffmpeg remux/teardown leg with no new media code.
  - **Limitation — real-time pacing.** If the device ignores a speed param and paces at 1× (`Rate-Control: yes` default), exporting a 1-hour clip takes ~1 hour. Clip windows for timeline scrubbing are usually short, so 1× is acceptable for the common case; for long/fast exports, use (B).
- **Approach (B) — documented fallback (not built by default).** Hand-roll the RTSP control channel (OPTIONS/DESCRIBE/SETUP/PLAY) emitting `Require: onvif-replay` + `Range: clock=<start>-<end>` + `Rate-Control: no`, demux interleaved RTP, and depacketize H.264 to Annex-B for ffmpeg. Gives precise windows **and** fast (`Rate-Control: no`) export, at the cost of substantial RTP/H.264 code. Use only for devices that ignore the query-param window or strictly require the `Range: clock` header.

> **go2rtc is deliberately not used** for replay: it cannot inject the ONVIF replay RTSP headers (`Require:` / `Range: clock` / `Rate-Control`), which is a maintainer-rejected feature (go2rtc issues #952 / #1104).

---

## Legacy netsdk/flv.cgi Fallback

Setting `RECORDINGS_BACKEND=netsdk` selects the original vendor-specific path: netsdk `R.SearchRecord` (recording list) + `cgi-bin/flv.cgi` (FLV download) over HTTP Basic, with `ffmpeg` remuxing FLV → MP4. It targets the **Tsukamoto Musen OEM XVR** (`DVR_HOST`, FW 3.2.2.6F / 2022) and similar units.

This path is **retained, not deleted**, so other firmware/models keep a working-shaped client. It is **unverified on the on-hand unit**: `R.SearchRecord` returns a "success" response with **0 items**, and `flv.cgi` returns **HTTP 404** for every parameter combination (see [below](#why-the-on-hand-unit-cannot-be-used-conclusions-from-on-device-testing)). Key netsdk specifics if you use it:

- **Auth**: HTTP Basic only, `admin` / empty password (`Authorization: Basic <base64("admin:")>`).
- **`R.SearchRecord`** body must use **full date-time strings** `YYYY-MM-DD HH:MM:SS` for `BeginTime`/`EndTime` (time-only / Unix-second / empty `Parameter` → `Search Failed!`). Do **not** include `Reload:"True"`. `Channel` is a 9-element boolean array (`MAX_CHN`); `Type` is `{Timing,Motion,Alarm,Manual}`. The DVR clock matches the host (no offset correction).
- **Success item shape**: `{ Channel:"0"(0-based string), TimeStart, TimeEnd (Unix sec), Type (bitmask 1/2/4/8) }`.
- **`flv.cgi`**: `GET /cgi-bin/flv.cgi?u=&p=&mode=time&chn=<0-based>&begin=<UnixSec>&end=<UnixSec>&…` → FLV stream on success.
- **Status endpoints**: `POST /netsdk/Stat` (HDD/IPC/recording state), `/netsdk/GetChannelDetail`, `/netsdk/R.SEARCH.Ipc`, `/login`. The legacy `DVR_DEV` / `DVR_VER` / `DVR_MAX_CHN` env vars apply only here.

---

## Why the On-Hand Unit Cannot Be Used (Conclusions from On-Device Testing)

Neither backend is proven on the only physically available device — the `.14` DVR (Tsukamoto Musen OEM, WTW-EG2 series, FW 3.2.2.6F / 2022). Diagnostic results:

1. **Connectivity and auth are OK.** 200 with Basic `admin:` (empty PW) (wrong PW → 401).
2. **netsdk `R.SearchRecord` always returns 0 items** even on a `Search Success!` response — `ReadCnt:"0"`, no `Item`, `DataBasePath:"$"` (unresolved) — across the entire period and all `Channel`/`Type`, despite a 2TB HDD 100% used and recording in progress. `LogSearch` also returns `SearchCnt:0`. Likely a firmware implementation constraint/bug.
3. **`cgi-bin/flv.cgi` returns 404 for every parameter.** Recording playback/download on this unit is a Windows / IE-only OCX (`dvr_ocx.OpenStream`) binary-over-HTTP protocol, not reproducible with `curl`/`ffmpeg`.
4. **Only ports 80 and UDP 3702 (WS-Discovery) are open.** RTSP(554) / SDK(37777) / RTMP(1935) are closed. **Crucially, ONVIF over HTTP does not work here either: `/onvif/*` returns 404 on port 80, and the unit does not answer unicast WS-Discovery Probe** — so the ONVIF Profile G client cannot reach it. Making it practical would require obtaining XAddrs via multicast 3702, which is not established.

**→ This is why the ONVIF client ships as documented best-effort.** It is a spec-compliant implementation with mechanical unit tests (PasswordDigest test vector, SOAP envelope render, response parser on canned ONVIF XML, Fault→typed-error), but it has not been validated against a real Profile G NVR/DVR. If your device is a conformant Profile G recorder, point `ONVIF_HOST` at it and it should work; if it 404s on `/onvif/*` like the on-hand unit, fall back to manually segment-capturing the source camera's RTSP with `ffmpeg` (this repository does not include a recorder), or use the vendor's native client.

---

## Troubleshooting

### The recording list is empty (ONVIF)

- Confirm `RECORDINGS_BACKEND=onvif` and that `ONVIF_HOST` points at a real Profile G NVR/DVR.
- Check `/api/health` (Web UI or `download-cli.js`): it reports reachability, the chosen auth scheme, device time/skew, and discovered XAddrs. A reachable device with 0 recordings vs. an unreachable/unrecognized response are distinguished (the backend surfaces a diagnostic rather than a phantom empty list).
- A `404` on `/onvif/*` means the device does not implement ONVIF over HTTP (like the on-hand unit) — see [above](#why-the-on-hand-unit-cannot-be-used-conclusions-from-on-device-testing).

### `NotAuthorized` / `Sender not authorized` (ONVIF)

- Almost always **clock skew** or a wrong password. The client measures skew via `GetSystemDateAndTime` and tries the WS-Security → HTTP-Digest → Basic ladder, but verify `ONVIF_USER` / `ONVIF_PASS` match the device.

### Wrong host/port in discovered service URLs

- Some devices advertise their own/NAT-wrong host in `GetServices` XAddrs. By default the client rewrites advertised XAddrs onto the configured `host:port`. Set `ONVIF_HONOR_XADDR=true` only if your deployment needs the advertised host as-is.

### Export is slow / takes as long as the clip duration

- This is the **real-time pacing** limitation of approach (A): if the device paces at 1× the export runs in real time. Keep windows short for scrubbing; for fast long exports, the hand-rolled `Rate-Control: no` approach (B) is documented but not built by default.

### Legacy netsdk: `Search Failed!` / `flv.cgi` 404

- See [Legacy netsdk/flv.cgi Fallback](#legacy-netsdkflvcgi-fallback): `BeginTime`/`EndTime` must be full date-times, don't include `Reload:"True"`. On the on-hand unit both symptoms are the known, unfixable behavior.

### Port 3914 conflicts

```sh
lsof -i :3914
```

- If in use, start it on a different port using the `PORT` environment variable
  (e.g., `PORT=4000 node recordings/server.js`).
- Since it is a different port from live go2rtc (`1984` / `8555` / `8554`), it normally does not conflict.

---

## Security Warning (must read)

This project assumes **personal use within a LAN**. Be sure to observe the following.

### 1. NVR/DVRs / cameras with no password set are dangerous

If the NVR/DVR or source camera runs with **`admin` / empty password**:

- From the same LAN (and, if misconfigured to be externally exposed, from the internet), **anyone can peek at the video/recordings and change settings**.
- There is a serious risk of leaking your home's privacy to third parties.

👉 **Be sure to set a strong, hard-to-guess password from the device's management screen (strongly recommended).** After setting it, update this feature's `ONVIF_PASS` (or `DVR_PASS`) environment variable (and the RTSP URL on the go2rtc side). **Do not hard-code the password into the source code.**

### 2. Manage credentials via environment variables

- Pass the connection target and credentials via the **environment variables** `ONVIF_HOST` / `ONVIF_USER` / `ONVIF_PASS` (legacy `DVR_*` still honored), plus `BIND_ADDR` / `PORT`. **Do not commit** files containing secret values — they live only in the gitignored `.env`.
- The **recording outputs (clips, thumbnails, cache) in this directory are `.gitignore`-d**. Since recordings contain video, be careful not to accidentally include them in a public repository.

### 3. Do not expose to the internet

- The recordings server (`3914`) and the NVR/DVR / camera are intended **for LAN-only access**.
- **Do not expose `3914` / `80` / `554`, etc. externally via router port forwarding or UPnP.**
- It is recommended to run the recordings server limited to localhost (`127.0.0.1:3914`). Even when you want to view it from other devices on the LAN, limit it to a trusted network and protect it with a firewall. When away from home, use a VPN.

### 4. Verify P2P / cloud transmission

- Many consumer NVR/DVRs / IP cameras come with **P2P / cloud features** that, depending on settings, may transmit video and connection information to the manufacturer's servers.
- It is strongly recommended to **disable P2P / cloud / remote access features from the management screen** and block unnecessary external communication. If possible, block the device's internet-bound traffic at the router and **isolate it within the LAN**.

---

## File Structure

| File / Directory | Role |
| --- | --- |
| `recordings/server.js` | Recordings backend (backend selector + ffmpeg remux + static-serving server). Node standard only |
| `recordings/onvif.js` | ONVIF Profile G client (SOAP / WS-Security / Recording-Search / Replay-Control / Device-Management). Standard-library only, no deps |
| `recordings/download-cli.js` | CLI for searching/downloading recordings (`--help` / `--list` / `--chn`) |
| `recordings/public/` | Recordings UI (search form, list, player: `recordings.html` / `.css` / `.js` / `i18n.js`) |
| `recordings/data/` | Runtime output for exported clips, etc. (MP4 / cache / index). `.gitignore`-d |
| `recordings/README.md` | This document |

> The output directory name (`data/`, etc.) follows the implementation of `server.js`. **Runtime outputs** such as recording clips, thumbnails, cache, and PID/logs are **`.gitignore`-d**, and only the source (`server.js` / `onvif.js` / `public/` / this README) is tracked.

---

> This feature operates independently of live viewing (go2rtc). For how to use live viewing and the overall security policy, refer to the root `README.md` of the repository.
