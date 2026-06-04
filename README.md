**English** | [日本語](README.ja.md)

# go2rtc-viewer — Local Security Camera Viewer

A LAN-only local viewer that delivers the video from any RTSP / ONVIF IP camera to the browser for playback. Many IP cameras stream **H.265 (HEVC)**, which browsers cannot play natively, so this project uses [go2rtc](https://github.com/AlexxIT/go2rtc) and `ffmpeg` to perform the `H.265 → H.264` conversion and deliver the stream to the browser over WebRTC with low latency.

If your camera already streams H.264, no transcode is needed and you can point go2rtc straight at `rtsp://` (lower CPU). It is intended for casually checking your home security cameras from a browser within the LAN.

> **⚠️ There are important security notes. Be sure to read the [Security Warnings](#security-warnings-must-read).**

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Setup (.env)](#setup-env)
- [Usage](#usage)
  - [Opening the Custom Dashboard (`web/index.html`) (Optional)](#opening-the-custom-dashboard-webindexhtml-optional)
  - [Screen Layouts (1 / 2 / 4 / 6 split)](#screen-layouts-1--2--4--6-split)
- [How It Works (Architecture)](#how-it-works-architecture)
  - [Switching Between Main / Sub Streams](#switching-between-main--sub-streams)
- [How to Add a Camera](#how-to-add-a-camera)
  - [1. Add a Stream to go2rtc.yaml](#1-add-a-stream-to-go2rtcyaml)
  - [2. Add the Camera to cameras.json](#2-add-the-camera-to-camerasjson)
- [Recording (Playback) Feature](#recording-playback-feature)
  - [Startup and Usage](#startup-and-usage)
  - [Summary of the DVR Recording API (Real-Device Investigation)](#summary-of-the-dvr-recording-api-real-device-investigation)
  - [Security Notes for the Recording Feature](#security-notes-for-the-recording-feature)
- [Troubleshooting](#troubleshooting)
  - [No Video Appears](#no-video-appears)
  - [High Latency](#high-latency)
  - [ffmpeg Not Found](#ffmpeg-not-found)
  - [Port Conflicts](#port-conflicts)
- [Security Warnings (Must Read)](#security-warnings-must-read)
- [File Structure](#file-structure)
- [License and Attribution](#license-and-attribution)
- [Contributions, Support, and Vulnerability Reports](#contributions-support-and-vulnerability-reports)

---

## Overview

| Item | Details |
| --- | --- |
| Target camera | Any RTSP / ONVIF IP camera |
| Video codec | H.264, or H.265 / HEVC transcoded to H.264 (typically a high-res main stream + a low-res sub stream) |
| Audio codec | Optional (e.g. PCMA / G.711 if your camera sends audio) |
| Delivery method | WebRTC via go2rtc (MSE / HLS also available as fallbacks) |
| Conversion | H.265 → H.264 transcoding via `ffmpeg` (skipped if the camera already streams H.264) |
| Viewing scope | **LAN only** (exposing it to the internet is not intended) |

Because the browser receives video as H.264 over WebRTC, no additional plugins or apps are required. Running `./start.sh` starts the go2rtc server and **automatically opens go2rtc's built-in viewer (`http://localhost:1984`) in your browser**. A polished custom dashboard (`web/index.html`) is also included and can be used optionally (see [Opening the Custom Dashboard](#opening-the-custom-dashboard-webindexhtml-optional)).

---

## Prerequisites

- **macOS (Apple Silicon / arm64)**
- **`ffmpeg` must be installed.** To verify:

  ```sh
  command -v ffmpeg
  ```

  If a path is displayed, you are good to go. If nothing is displayed, install it with [Homebrew](https://brew.sh/):

  ```sh
  brew install ffmpeg
  ```

- **No prior installation of go2rtc is required.** On the first run of `./start.sh`, the binary for Apple Silicon (`go2rtc_mac_arm64.zip`) is automatically fetched from the official releases and placed inside the repository.
- You must be connected to the same LAN as the camera (set the camera's actual IP in `CAM_IP` in `.env`; see "Setup (.env)" below).
- A WebRTC-capable browser (recent Safari / Chrome / Firefox / Edge).

---

## Setup (.env)

Actual IPs and RTSP/DVR credentials are placed **only** in the git-ignored `.env` (all committed configuration uses placeholders such as `${VAR}` or RFC5737 dummies like `192.0.2.x`).

1. `cp .env.example .env`
2. Edit `.env` and fill in the real values
   (`CAM_IP`, `RTSP_USER`/`RTSP_PASS`, `CAM_PATH_SUB`/`CAM_PATH_HD`, and — only if you use the optional recordings feature — `DVR_HOST`/`DVR_USER`/`DVR_PASS`)
3. `./gen-config.sh`              # Generate `cameras.json` from `.env` (git-ignored)
4. `./start.sh`                   # Load `.env` and start go2rtc (resolves `${VAR}` in `go2rtc.yaml`)
5. `python3 -m http.server 8000`  # If using the dashboard. Run step 3 first
                                  # (`start.sh` also runs step 3 automatically)

If using the recording feature (`recordings/server.js` is not started by `start.sh`):

```sh
node recordings/server.js     # server.js loads .env via its built-in loader
# or: set -a; . ./.env; set +a; node recordings/server.js
```

**Repository hygiene vs. runtime confidentiality** … This mechanism exists to "keep LAN configuration and credentials out of the shared commit history." Because the browser fetches `cameras.json`, the camera IPs are visible at runtime from DevTools on the LAN. Using `.env` does not hide the IPs from the local viewer.

**go2rtc substitution syntax (confirmed)** … go2rtc resolves `${VAR}` / `${VAR:default}` (**a single colon**) within `go2rtc.yaml` from **process environment variables** (it does not read `.env` directly, which is why `start.sh` exports it via `set -a; . ./.env; set +a`). The shell `${VAR:-x}` form cannot be used.

---

## Usage

Run the following from the repository root. **Paths are resolved automatically**, so it works no matter which directory you call it from.

**Start:**

```sh
./start.sh
```

- On the first run only, the go2rtc binary is automatically downloaded.
- The go2rtc server starts (management UI / viewer: `http://localhost:1984`).
- `http://localhost:1984` opens automatically in your default browser. From there, select a stream (`cam1` / `cam1_hd`) from the stream list and start watching right away.

**Stop:**

```sh
./stop.sh
```

- Stops the go2rtc process that was started.

> If the camera video does not appear in the browser after startup, see [Troubleshooting](#troubleshooting).

### Opening the Custom Dashboard (`web/index.html`) (Optional)

The bundled `web/` dashboard supports tiled display of multiple cameras, SD/HD switching, snapshot saving, and full-screen display. Because `web/index.html` loads `cameras.json` (located in the repository root), **serve the repository root as the document root** and open `web/index.html` (keep go2rtc running).

```sh
# Run from the repository root (a separate terminal is recommended)
python3 -m http.server 8000
# → Open http://localhost:8000/web/index.html in your browser
```

- The dashboard fetches video and snapshots from `http://localhost:1984` (go2rtc). If you run go2rtc on a different host/port, either append `?go2rtc=http://<host>:1984` to the URL or add `"go2rtc": "http://<host>:1984"` to `cameras.json`.
- For a quick trial, this custom dashboard is not necessary. You can watch using only the built-in viewer at `http://localhost:1984`.

### Screen Layouts (1 / 2 / 4 / 6 split)

The custom dashboard (`web/index.html`) lets you choose a **1 / 2 / 4 / 6 screen** tile layout using the **"Screen Split" segmented switch** in the header. Each button is shown as a "mini grid diagram representing the split + a number + 'screens'," so you can tell at a glance how many panes it splits into. Use them as appropriate for monitoring multiple cameras simultaneously or for viewing one camera in a larger size.

| Button | Number of splits | Grid arrangement | Suggested use |
| --- | --- | --- | --- |
| **1** | 1 screen | 1 × 1 | Display one camera large (e.g., the entrance only) |
| **2** | 2 screens | 2 × 1 (side by side) | Compare two cameras side by side |
| **4** | 4 screens | 2 × 2 | Standard multi-camera monitoring |
| **6** | 6 screens | 3 × 2 | View the maximum number at once (up to 6 panes) |

> **Operation guide (Help)** … Pressing the **"? Help"** button at the far right of the header opens a legend summarizing each button (Screen Split / HD quality / Capture / Full screen / Camera selection) and how to read the display (LIVE / SD・HD / connection status). Each operation is also explained with an icon, a Japanese label, and a tooltip.

**Per-pane camera selection**

- Each pane is **automatically assigned, in order, the enabled cameras** registered in `cameras.json`.
- Using the **dropdown** at the top of each pane, you can freely re-select which camera that pane displays from the camera list in `cameras.json`. You can also display the same camera in multiple panes (e.g., one pane in SD, another in HD).
- If the **number of cameras is fewer than the number of panes**, the leftover panes show an "unassigned camera" placeholder (you can assign one later from the dropdown).

**SD / HD, snapshots, full screen**

- Even when you change the layout, each pane can still use **SD / HD switching, snapshot saving, and full-screen display** as before.
- By default, the lighter-load **SD (sub stream)** is displayed, and the recommended approach is to switch only the panes you need to HD (main). Setting all panes to HD (4K) in a 6-split layout places a heavy load on CPU and bandwidth.

**Persistence of settings (localStorage)**

- The chosen **layout (1 / 2 / 4 / 6)** and **the camera assignment of each pane** are saved to the browser's `localStorage` and are **restored even after reloading the page**.
- Settings are saved per browser (origin). Opening in a different browser or on a different port results in separate settings. To reset, clear the browser's site data (localStorage).

**Stream leak prevention**

- When you switch a pane's camera or shrink the layout (e.g., 6 → 1), the WebRTC / WebSocket connections of any `<video-stream>` that is no longer displayed are **stopped and discarded**, and only the necessary panes reconnect. Connections will not stay open and leave a residual load on the cameras or go2rtc.

### Stream Management Page (`web/streams.html`)

This is a management page that redesigns go2rtc's standard management screen (`http://localhost:1984`) with the same design as the viewer. You can move between the viewer and management with the **"Viewer / Management" toggle** (header right) shared by both pages (the management page URL is `http://localhost:8000/web/streams.html`). Since it reads from and writes to the go2rtc API (`:1984`), **in normal operation you rarely need to open go2rtc's standard UI (`:1984`) at all**.

The operations on the right side of the header are unified into the same arrangement on both pages (**connection status → refresh → viewer/management toggle → help**). The viewer has "Screen Split" to its left.

The management page consists of **four tabs**.

- **Streams** … A list of streams (card display). For each stream it shows the **number of viewers**, **source connection status**, **codecs** (H264/PCMA, etc.), and **source (credentials are masked)**, auto-refreshing about every 8 seconds.
  - Each operation: `Watch` (play in the go2rtc player) / `Info` (status JSON) / `Probe` (media analysis) / `Links` (list of various URLs) / `Net` (connection path diagram) / `Delete`.
  - The selected **playback mode** (`WebRTC / MSE / HLS / MJPEG`) is reflected in the "Watch" link (saved to `localStorage`).
  - **Add stream**: Adds a stream to the running go2rtc instantly by name and source (`PUT /api/streams`). To make it permanent, use the "Config" tab below or append it to `go2rtc.yaml`.
- **Config** … Edit `go2rtc.yaml` directly in the browser (loaded via `GET /api/config`, saved via `POST /api/config`). **Comments are preserved.** Saving requires confirmation, and applying changes requires restarting go2rtc (you can restart from the page, and it automatically polls until it comes back). A **"Backup"** option (download the current configuration as a `.yaml`) is also provided in case of mistaken edits.
- **Log** … Polls `GET /api/log` about every 3 seconds and displays it with **level color-coding, timestamps, and context**. Supports level filtering, search, newest-first ordering, and copying.
- **Network** … Embeds go2rtc's connection path diagram (`net.html`) (lazy-loaded on first display). Note that in a fully offline environment, rendering the diagram requires a CDN.

> Note 1: Because this page calls the `:1984` API from a different origin (`:8000`) than go2rtc, `api.origin: "*"` (already included) in `go2rtc.yaml` is required.
> Note 2: Saving in "Config" is limited to `POST /api/config` (writes the raw text verbatim = comments preserved); `PATCH` (which reserializes and loses comments) is not used. The go2rtc core (`:1984`) UI and binary are unmodified.

---

## How It Works (Architecture)

Many cameras deliver only H.265, which browsers cannot play. So go2rtc sits in between, converting to H.264 in real time with `ffmpeg` before delivering to the browser over WebRTC. (If your camera already streams H.264, go2rtc passes it straight through, no transcode.)

```
┌────────────────────┐     RTSP / H.265 (HEVC)      ┌──────────────────────────────┐
│  IP camera          │ ───────────────────────────▶ │  go2rtc (localhost:1984)     │
│  <camera-ip>:554    │   main stream (high-res)      │  ┌────────────────────────┐  │
│                     │   sub stream  (low-res)       │  │ ffmpeg                 │  │
└────────────────────┘                              │  │ H.265 ──▶ H.264 convert │  │
                                                     │  └────────────────────────┘  │
                                                     └───────────────┬──────────────┘
                                                                     │ WebRTC / H.264
                                                                     │ (8555 TCP/UDP)
                                                                     ▼
                                                       ┌──────────────────────────┐
                                                       │  Browser                  │
                                                       │  localhost:1984 viewer     │
                                                       │  or web/index.html         │
                                                       │  plays H.264 in <video>    │
                                                       └──────────────────────────┘
```

- **Input**: `rtsp://${RTSP_USER}:${RTSP_PASS}@${CAM_IP}:554/${CAM_PATH_HD}` (main, high-res) / `.../${CAM_PATH_SUB}` (sub, low-res). The RTSP paths vary by vendor (see [How to Add a Camera](#how-to-add-a-camera)).
- **Conversion**: Using go2rtc's `ffmpeg:` source specification with the `#video=h264` template, H.265 is transcoded to H.264. Because **only H.264 sources are registered for both main and sub**, the browser is guaranteed to receive H.264 with any playback method (WebRTC / MSE / HLS) (raw H.265 sources are not registered; if they were, MSE would grab the H.265 and fail to play). If your camera already streams H.264, drop the `ffmpeg:` prefix and point go2rtc straight at `rtsp://...`.
- **Output**: WebRTC (low latency). If the browser cannot use WebRTC, go2rtc falls back to MSE / HLS. If your camera has audio (e.g. PCMA / G.711), it can be played over the WebRTC path.
- **Ports**: management UI / API = `1984`, WebRTC = `8555` (and RTSP = `8554` if needed).

### Switching Between Main / Sub Streams

You can switch between the **main (high-res)** and the **sub (low-load, low-res)** using a button in the viewer.

- **Main (high-res)**: High definition, but with higher CPU load, bandwidth, and latency. Use it when you want to see details.
- **Sub (low-res)**: Lightweight with low latency. Well suited for continuous monitoring or displaying multiple cameras at once.

On the go2rtc side, the sub and the main are each defined as separate streams. In this repository's defaults, these are **`cam1` (sub / default display)** and **`cam1_hd` (main / when switched to HD)**. Each camera in `cameras.json` has the corresponding stream names (`stream` = default, `stream_hd` = HD), and the viewer refers to these to switch. The sub is displayed by default in order to reduce the load of continuous display.

---

## How to Add a Camera

To add cameras, **(1) define the streams in go2rtc.yaml** and **(2) add the viewer entries to cameras.json**.
The following is an example of adding `cam2` and `cam3` (adjust the IPs, RTSP paths, and codecs to match your actual devices).

### 1. Add a Stream to go2rtc.yaml

Add two entries — sub (default) and main (HD) — to the `streams:` section of `go2rtc.yaml`. If the camera streams H.265, route it through `ffmpeg:...#video=h264` so the browser can play it; if it already streams H.264, drop the `ffmpeg:` prefix and use `rtsp://...` directly (no transcode, lower CPU). This repository's naming convention is **default (sub) = `camN`, HD (main) = `camN_hd`** (`cam1` / `cam1_hd`, `cam2` / `cam2_hd`, …). Audio (`#audio=pcma`) is added only on the sub side, and only if your camera has audio; the high-res main side omits audio to reduce load.

The RTSP sub/main paths differ by vendor. Set them in `.env` as `CAM_PATH_SUB` / `CAM_PATH_HD`, for example:

| Vendor | Sub (low-res) | Main (high-res) |
| --- | --- | --- |
| ONVIF / generic | `/stream2` | `/stream1` |
| Hikvision | `/Streaming/Channels/102` | `/Streaming/Channels/101` |
| Dahua | `/cam/realmonitor?channel=1&subtype=1` | `/cam/realmonitor?channel=1&subtype=0` |

```yaml
streams:
  # --- existing: cam1 (resolved from .env via ${VAR}) ---
  # Default display is sub (lightweight). Video H.264 + audio PCMA (if present).
  cam1: ffmpeg:rtsp://${RTSP_USER}:${RTSP_PASS}@${CAM_IP}:554/${CAM_PATH_SUB}#video=h264#audio=pcma
  # HD (main, high-res). Video only, H.264.
  cam1_hd: ffmpeg:rtsp://${RTSP_USER}:${RTSP_PASS}@${CAM_IP}:554/${CAM_PATH_HD}#video=h264

  # --- addition example: cam2 (replace <camera-ip> and the RTSP paths) ---
  cam2: ffmpeg:rtsp://${RTSP_USER}:${RTSP_PASS}@<camera-ip>:554/<sub-stream-path>#video=h264#audio=pcma
  cam2_hd: ffmpeg:rtsp://${RTSP_USER}:${RTSP_PASS}@<camera-ip>:554/<main-stream-path>#video=h264

  # --- addition example: cam3 ---
  cam3: ffmpeg:rtsp://${RTSP_USER}:${RTSP_PASS}@<camera-ip>:554/<sub-stream-path>#video=h264#audio=pcma
  cam3_hd: ffmpeg:rtsp://${RTSP_USER}:${RTSP_PASS}@<camera-ip>:554/<main-stream-path>#video=h264
```

> **Notes**
> - `#video=h264` is go2rtc's built-in transcoding template. It converts H.265 video to H.264. If the camera already streams H.264, omit it (and the `ffmpeg:` prefix).
> - `#audio=pcma` passes the original PCMA / G.711 through as-is, WebRTC-compatible. Add it only if your camera sends audio. If you do not need audio, omit `#audio` (the high-res main side omits it).
> - **Do not list raw H.265 (HEVC) RTSP alongside it in the same stream.** Because go2rtc uses the first source the consumer can accept, listing HEVC alongside it would cause MSE and others to grab HEVC and fail to play. Register only the H.264 transcode.
> - **If you do not want to write credentials inline**, see "Separating credentials" in the [Security Warnings](#security-warnings-must-read).

### 2. Add the Camera to cameras.json

Add the viewer entries to `cameras.json`. Specify the default (sub) go2rtc stream name in `stream` and the HD (main) one in `stream_hd`. Each entry has `id`, `name`, `ip`, `stream`, `stream_hd`, and `enabled` only. To add more cameras, define `cam2` / `cam3` … (with their `*_hd` counterparts) in `go2rtc.yaml`, add a matching entry here, set its `ip`, and switch `enabled` to `true`.

```json
{
  "cameras": [
    {
      "id": "cam1",
      "name": "Camera 1",
      "ip": "${CAM_IP}",
      "stream": "cam1",
      "stream_hd": "cam1_hd",
      "enabled": true
    },
    {
      "id": "cam2",
      "name": "Camera 2",
      "ip": "<camera-ip>",
      "stream": "cam2",
      "stream_hd": "cam2_hd",
      "enabled": false
    }
  ]
}
```

After making changes, restart go2rtc with `./stop.sh` → `./start.sh` to apply them (the custom dashboard applies the changes simply by reloading the browser). A newly enabled camera then appears in the per-pane dropdown of the custom dashboard, and you can select and display it in any pane of the layout.

---

## Recording (Playback) Feature

> **This section is specific to a Tsukamoto-OEM DVR (XVR) and is optional. The live viewer is manufacturer-agnostic and does NOT depend on it.** If you do not have this DVR, skip this section entirely — live viewing works with any RTSP/ONVIF camera as described above.

In addition to live viewing, **recording search, download, and viewing** features for the security DVR (**a Tsukamoto Musen OEM XVR**, IP `<dvr-ip>`) are bundled under `recordings/`. It is a **backend independent** of the go2rtc live viewer (port `1984`) (Node standard modules + `ffmpeg`), runs on a **separate port, `http://localhost:3914`**, and both can be started at the same time.

> **Important — this DVR's recording HTTP API is not practically usable on the current firmware (confirmed on the real device).**
> The DVR's netsdk search `R.SearchRecord` **always returns 0 items** even with a "success" response, and the recording-download `cgi-bin/flv.cgi` returns **HTTP 404 for all parameters**. The bundled netsdk / `flv.cgi`
> clients (`recordings/`) are a **spec-compliant best-effort implementation** and can be used for the recording list / download on other models or firmware, but **on this device the list does not return**.
> **This repository does not include an automatic recording feature.** If you want to keep recordings, manually capture the camera's RTSP stream (the same one used for the go2rtc live view) with `ffmpeg`.
> For a detailed breakdown, see [`recordings/README.md`](recordings/README.md).

### Startup and Usage

**Startup** (from the repository root; it can coexist since it is a separate process and port from go2rtc):

```sh
node recordings/server.js
# → Opens http://localhost:3914 in your default browser
```

- **Web UI**: At `http://localhost:3914`, specify a channel and a date/time range to search recordings →
  play MP4 in the browser's `<video>` → download (with thumbnails).
  Note: Because this device's DVR firmware always returns 0 search results, the list will be empty (see the note above).
- **CLI**: DVR recording search / download can be done with `recordings/download-cli.js`
  (treat `--help` as authoritative for the flags). Examples:

  ```sh
  node recordings/download-cli.js --help                 # usage
  node recordings/download-cli.js --list                 # today's recording list (0 items on this device)
  node recordings/download-cli.js --chn 1 \
    --begin "2026-06-02 00:00:00" --end "2026-06-02 23:59:59"   # attempt a download for a specified range
  ```
  > `server.js` is the server for the Web UI and has no subcommands.

- **Stop**: For a foreground start, `Ctrl+C`.
- **Configuration (environment variables)**: `DVR_HOST` (the DVR's IP / host, `<dvr-ip>`), `DVR_USER` (default `admin`),
  `DVR_PASS` (default empty), `BIND_ADDR` (listen address; default `127.0.0.1` = localhost only),
  `PORT` (default `3914`). The password is passed **via an environment variable, not written in the source**.

  ```sh
  DVR_PASS='********' PORT=4000 node recordings/server.js
  ```

### Summary of the DVR Recording API (Real-Device Investigation)

These are the key points of the spec confirmed on the DVR (`<dvr-ip>`, XVR, FW 3.2.2.6F) (for the full text and the basis for the port, see
[`recordings/README.md`](recordings/README.md)).

- **Authentication**: Fixed HTTP Basic. `Authorization: Basic <base64("admin:")>` (empty PW).
  A wrong PW / no PW returns **401**; only an empty `admin:` returns **200**. `POST /login` also succeeds but
  no token is issued (Basic only).
- **Recording search**: `POST http://<dvr-ip>/netsdk/R.SearchRecord`
  (`Content-Type: application/json`, Basic). The body is
  `{DEV:"XVR",VER:"1.0",API:"R.SearchRecord",Parameter:{...}}`.
  - `BeginTime`/`EndTime` require **a full date-time `"YYYY-MM-DD HH:MM:SS"`**. Time only,
    Unix seconds, or an empty `Parameter` returns `Search Failed!`. **Do not** add `Reload:"True"`.
  - `Channel` is a boolean array of `MAX_CHN` (=9) elements (`"True"` = search target). `Type` is
    `{Timing,Motion,Alarm,Manual}`. The time of a recording Item is in **Unix seconds**, and ch is **0-based**.
  - **On this device, even a success response has `ReadCnt:"0"` and no Items** (0 items even with a 2TB HDD at 100% usage and recording in progress).
- **Recording download**: `GET http://<dvr-ip>/cgi-bin/flv.cgi?...&chn=<ch>&begin=<UnixSec>&end=<UnixSec>...`
  → by design, FLV for a time range. **On this device, 404 for all parameters** (`gw.cgi` is also 404).
- **Same-family APIs usable for retrieving configuration**: `/netsdk/Stat` (device/HDD/IPC/recording status as real data — most important),
  `/netsdk/GetChannelDetail` (9ch resolutions), `/netsdk/Record` (recording schedule),
  `/netsdk/R.SEARCH.Ipc` (connected IPC = ch0 = `<camera-ip>`), `/netsdk/LogSearch`,
  `POST /login`. `/netsdk/Channel`, `/netsdk/General`, etc. are SET-family templates that return an echo and
  cannot be used to retrieve configuration.
- **Channels**: A 9ch configuration. The only real camera is **connected on ch0 (ch1 in the UI display)** = `<camera-ip>`
  WTW-IPC (main 4K HEVC / sub 800×448 HEVC). The ch for recording / `flv.cgi` is 0-based.

### Security Notes for the Recording Feature

The same notes as for live viewing apply directly ([Security Warnings](#security-warnings-must-read)).
Points especially important for the recording feature:

- **An `admin` / empty password on the DVR / camera is dangerous.** Always set a strong password and
  pass it to this feature via the `DVR_PASS` environment variable. **Do not write it inline in the source.**
- **The recording output (clips, thumbnails) contains video.** The runtime
  output of `recordings/` is already in `.gitignore`, but be careful not to accidentally include it in a public repository.
- **Do not expose the recording server (`3914`), the DVR (`80`), or the camera (`554`) to the internet.**
  We recommend restricting operation to `127.0.0.1:3914`, and accessing it from outside via VPN.

---

## Troubleshooting

### No Video Appears

1. **Check the delivery status in the management UI**: Open `http://localhost:1984` in your browser and verify that the relevant stream appears under `streams` and can be played.
2. **Check whether the camera is reachable**:

   ```sh
   ping <camera-ip>
   ffprobe "rtsp://${RTSP_USER}:${RTSP_PASS}@${CAM_IP}:554/${CAM_PATH_HD}"
   ```

   If `ffprobe` displays stream information (codec / resolution), the camera itself is delivering.
3. **Check whether you are on the same LAN**: You cannot reach it if you are connected to a VPN or a different segment.
4. **Credentials / RTSP path**: Verify that the user, password, port `554`, and RTSP path (`CAM_PATH_SUB` / `CAM_PATH_HD`) match your camera's actual settings.

### High Latency

- **Switch to the sub stream**: The high-res main has a higher load and is prone to latency. Select the sub (low resolution) in the viewer.
- **Check whether WebRTC is being used**: If WebRTC cannot be established, it falls back to MSE / HLS and latency increases. Verify that the WebRTC port `8555 (TCP/UDP)` is reachable locally.
- **Hardware acceleration (optional)**: To reduce the transcoding load, appending `#hardware=videotoolbox` (or `#hardware` for auto-detection) to the end of each source in go2rtc.yaml uses VideoToolbox hardware assist on macOS. However, according to the official go2rtc, **CPU transcoding is often faster on Apple Silicon**, so first try without it and enable it only when CPU load is high. If it becomes unstable, remove it.

  ```yaml
  # Example: add hardware assist to HD (main, high-res)
  cam1_hd: ffmpeg:rtsp://${RTSP_USER}:${RTSP_PASS}@${CAM_IP}:554/${CAM_PATH_HD}#video=h264#hardware=videotoolbox
  ```

### ffmpeg Not Found

- Check whether `command -v ffmpeg` displays a path.
- If nothing is displayed, install it with `brew install ffmpeg`.
- go2rtc resolves `ffmpeg` from PATH. Verify that the Homebrew bin (usually `/opt/homebrew/bin` on Apple Silicon) is included in PATH.

### Port Conflicts

By default, go2rtc uses `1984` (API/UI), `8555` (WebRTC), and `8554` (RTSP). If these are already in use:

1. **Identify the process in use**:

   ```sh
   lsof -i :1984
   lsof -i :8555
   ```

2. **Change the ports**: Change the ports in the `api` / `webrtc` / `rtsp` sections of `go2rtc.yaml`.

   ```yaml
   api:
     listen: "127.0.0.1:1985"
   webrtc:
     listen: ":8556"
   ```

   If you change the ports, also update the API port referenced by the viewer (`web/app.js`, etc.) accordingly.

---

## Security Warnings (Must Read)

This project assumes **personal use within a LAN**. Be sure to observe the following.

### 1. Cameras with no password set are dangerous

Many IP cameras ship with a weak default such as **user `admin` / an empty (or trivial) password**. If left as-is:

- **Anyone** from the same LAN (and, if misconfigured and exposed externally, the internet) **can peek at the video and change settings**.
- There is a serious risk that household privacy is leaked to third parties.

👉 **Be sure to set a strong, hard-to-guess password from the camera's management screen (strongly recommended).** Set the credentials in `.env` (`RTSP_USER` / `RTSP_PASS`); the authentication portion of the RTSP URL in `go2rtc.yaml` (the `${RTSP_USER}:${RTSP_PASS}@` part) is resolved from them.

### 2. Do not expose it to the internet

- This viewer and go2rtc are intended for **access only from within the LAN**.
- **Do not expose `1984` / `8554` / `8555`, etc., externally via your router's port forwarding or UPnP.**
- We recommend a configuration that limits the go2rtc API to localhost (`127.0.0.1:1984`) by default. Even if you want to view it from other devices on the LAN, limit it to a trusted network and protect it with a firewall.
- If you want to view it from outside, use a **VPN (a secure tunnel into your home LAN)** rather than exposing ports.

### 3. Separating credentials (recommended)

Writing RTSP passwords directly into `go2rtc.yaml` risks leakage when the repository is managed.

- We recommend **managing credentials with environment variables or a separate file (already in .gitignore)**. In go2rtc.yaml, you can use environment variable expansion such as `${RTSP_PASSWORD}`.
- **Do not commit** files containing sensitive values (verify that they are excluded in `.gitignore`).

### 4. Checking for P2P / cloud transmission

- Many IP cameras have a **P2P / cloud feature**, and depending on the settings, video or connection information may be sent to the manufacturer's servers.
- We strongly recommend **disabling the P2P / cloud / remote access features in the camera's management screen** to cut off unnecessary external communication.
- If possible, block the camera's internet-bound communication at the router and **isolate it within the LAN**.

---

## File Structure

| File / Directory | Role |
| --- | --- |
| `.env.example` | Configuration template (committed). `cp .env.example .env` and fill in the real values |
| `.env` | Real IPs / credentials (**git-ignored**). Referenced by go2rtc / recordings / generation scripts |
| `go2rtc.yaml` | go2rtc configuration (stream definitions resolved from `.env` via `${VAR}`) |
| `cameras.template.json` | Template for the camera list (committed; `ip` is `${CAM_IP}`, etc.) |
| `cameras.json` | The camera list generated from the above (**git-ignored**; generated by `gen-config.sh`) |
| `gen-config.sh` | Reads `.env` and generates `cameras.template.json` → `cameras.json` |
| `start.sh` | Load `.env` → generate `cameras.json` → auto-fetch and start go2rtc |
| `stop.sh` | Stop the go2rtc process |
| `web/index.html` | The viewer's HTML |
| `web/app.js` | Loading the camera list, WebRTC playback, main/sub switching, layout (1/2/4/6) and pane assignment (localStorage persistence) |
| `web/style.css` | Design tokens and base components shared by the viewer / management page |
| `web/streams.html` | The HTML of the stream management page (uses the go2rtc API) |
| `web/streams.js` | Reading/writing the go2rtc API (list, add, delete, auto-refresh, playback mode) |
| `web/streams.css` | Styles specific to the stream management page |
| `README.md` / `README.ja.md` | This document (English / Japanese) |
| `.gitignore` | Excludes the downloaded go2rtc binary and sensitive files |

---

## License and Attribution

- **This project (the source of go2rtc-viewer itself) is provided under the [Apache License 2.0](LICENSE).** See the bundled [`LICENSE`](LICENSE) for the full text and [`NOTICE`](NOTICE) for third-party attributions.
- It uses [go2rtc](https://github.com/AlexxIT/go2rtc) (author: AlexxIT, MIT) as the delivery engine. The go2rtc core is fetched at runtime as an external binary and is not bundled in this repository. See that repository for its license.
- It uses [FFmpeg](https://ffmpeg.org/) (LGPL / GPL) for transcoding. It is only invoked as an external binary and is not bundled in this repository.
- This project is intended for personal local use. Use it at your own risk, and the security management of each device and each network is the user's responsibility.

## Contributions, Support, and Vulnerability Reports

- This is a **personal project**. It is provided **as-is**, and there is no guarantee that Issues / Pull Requests will be addressed. Feel free to fork and use it as you like.
- If you find a **security vulnerability**, please report it through **GitHub's Security Advisory (private reporting)** rather than a public Issue. Given the nature of a tool for LAN security cameras, please refrain from sharing details including reproduction steps publicly before disclosure (see [`SECURITY.md`](SECURITY.md)).