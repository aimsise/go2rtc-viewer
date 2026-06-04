**English** | [日本語](README.ja.md)

# Recordings (Playback) Feature — DVR Recording Viewer

This directory provides **search, download, and playback** features for the security DVR (**Tsukamoto Musen OEM XVR**, IP `192.0.2.14`). It runs as a backend (Node standard modules + `ffmpeg`) that is **independent of the root go2rtc live viewer**, listens on a separate port `http://localhost:3914`, and accumulates recording data under this `recordings/` directory.

> **Important — On-device testing has confirmed that this DVR's recording HTTP API is non-functional on the current firmware.**
> `R.SearchRecord` (the netsdk search API) **always returns 0 items** even when it responds with "success", and
> `cgi-bin/flv.cgi` (recording download) returns **HTTP 404 for every parameter combination** (see [Why You Can't Download Directly from the DVR](#why-you-cant-download-directly-from-the-dvr-conclusions-from-on-device-testing)).
> Therefore, **the recording feature that actually works captures the RTSP stream of the DVR's source camera `192.0.2.146` and segment-records it yourself**. The DVR netsdk / flv.cgi clients are bundled "in case they come back to life on a future firmware or different model," but on this unit (FW 3.2.2.6F), use them with the understanding that no index is returned.

> **⚠️ Security Warning (must read)**: The target devices run with **`admin` / empty password**.
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
- [DVR Recording API Specification (On-Device Testing Summary)](#dvr-recording-api-specification-on-device-testing-summary)
  - [Authentication](#authentication)
  - [Recording Search `R.SearchRecord`](#recording-search-rsearchrecord)
  - [Recording Playback / Download `flv.cgi`](#recording-playback--download-flvcgi)
  - [Related Endpoints Usable for Configuration Retrieval](#related-endpoints-usable-for-configuration-retrieval)
  - [Channel Configuration](#channel-configuration)
- [Why You Can't Download Directly from the DVR (Conclusions from On-Device Testing)](#why-you-cant-download-directly-from-the-dvr-conclusions-from-on-device-testing)
- [Troubleshooting](#troubleshooting)
- [Security Warning (must read)](#security-warning-must-read)
- [File Structure](#file-structure)

---

## Overview

| Item | Details |
| --- | --- |
| Target DVR | Tsukamoto Musen OEM XVR (`192.0.2.14`, FW 3.2.2.6F / 2022) |
| Authentication | HTTP Basic, `admin` / empty password (overridable via environment variables) |
| Backend | Node.js (standard modules only) + `ffmpeg`. No additional npm dependencies |
| Port | `http://localhost:3914` (separate from go2rtc's `1984`; can coexist) |
| Actual recording source | The source camera of DVR ch0 = **WTW-IPC `192.0.2.146`** RTSP |
| Storage location | Under this `recordings/` directory (outputs such as `data/` are `.gitignore`-d) |
| Viewing scope | **LAN only** (internet exposure is not intended) |

What this backend can do:

1. **DVR netsdk search / flv.cgi download client + Web UI (best-effort / 0 items & 404 on this unit)**
   It bundles a thin client that calls `R.SearchRecord` with the correct request format (full date-time, correct `Channel`/`Type`), plus a Web UI to search → play → download MP4 in the browser. **On this unit, even a success response yields 0 items**, and `flv.cgi` returns **404**, but in environments (other models/firmware) where the index is returned, it can be used to list/download recordings (see [API Specification](#dvr-recording-api-specification-on-device-testing-summary)).
2. **DVR status retrieval** (displays HDD / connected IPC / recording state via `/netsdk/Stat`, etc.).

> **This repository does not include an automatic recording feature (recorder).** If you want to retain recordings in an environment like this unit where the DVR's HTTP recording API does not work, manually capture the RTSP of the same camera `192.0.2.146` used by the go2rtc live view, using `ffmpeg` (e.g.,
> `ffmpeg -i rtsp://<cam>/ch0_0.264 -c copy -f segment -segment_time 600 out_%Y%m%d_%H%M%S.mp4`).
> To extract "the actual recording files inside the DVR," you need the **vendor's native client on a real Windows machine / IE + ActiveX OCX** (this unit's Web UI uses a legacy Flash + OCX design that cannot be reproduced with `curl`/`ffmpeg`).

---

## Prerequisites

- **macOS (Apple Silicon / arm64)**
- **Node.js** installed (no additional npm packages required):

  ```sh
  command -v node
  ```

- **`ffmpeg`** installed (required for recording, MP4 conversion, and thumbnail generation):

  ```sh
  command -v ffmpeg
  ```

  If nothing is displayed, install it via [Homebrew](https://brew.sh/):

  ```sh
  brew install ffmpeg
  ```

- Connected to the **same LAN** as the DVR (`192.0.2.14`) and the source camera (`192.0.2.146`).
- A modern browser capable of playing MP4 (H.264) (Safari / Chrome / Firefox / Edge).

---

## Starting and Stopping

The server in this directory is independent of the root go2rtc. **You may run both at the same time** (different ports: recording = `3914`, live = `1984`).

**Start:**

```sh
# From the repository root
node recordings/server.js
# → opens http://localhost:3914 in your default browser
```

- Once started, the recording UI / API listens at `http://localhost:3914`.
- To change the port, override it with the `PORT` environment variable (see [Configuration](#configuration-environment-variables)).

**Stop:**

- If started in the foreground, press `Ctrl+C` in that terminal.
- If started in the background, terminate the process from the terminal where you launched it
  (e.g., if you started with `node recordings/server.js &`, run `kill %1`).

> To start/stop live viewing (go2rtc), use the root `./start.sh` / `./stop.sh`.
> Because it is independent of the recording server, starting/stopping only one of them is fine.

---

## Usage (Web UI)

Open `http://localhost:3914` in your browser.

1. Specify a **channel** and a **date-time range (start / end)**, then **search**.
   - Self-hosted recordings (clips already accumulated in `recordings/`) are listed.
   - Each clip shows its **start time, duration, size, and thumbnail**.
2. Selecting a clip from the list plays it in the in-browser `<video>` element
   (self-hosted recordings are MP4 / H.264, so no additional plugin is required).
3. Use the **Download** button to save the MP4 locally.

> **About direct DVR search**: The UI also has a mode that calls the DVR's `R.SearchRecord` directly, but on this unit it **always returns 0 items** for the [reasons described above](#why-you-cant-download-directly-from-the-dvr-conclusions-from-on-device-testing). Check actual data on the self-hosted recording side.

---

## Usage (CLI)

You can try DVR recording search and download from the terminal without a browser. The CLI is
`recordings/download-cli.js` (`server.js` is the server for the Web UI and has no subcommands). Treat `--help` as the source of truth for flags. Typical operations:

```sh
# Usage
node recordings/download-cli.js --help

# DVR recording search (today; always 0 items on this unit)
node recordings/download-cli.js --list

# Specify a range to attempt search and download
#   Date-time must be a full date-time "YYYY-MM-DD HH:MM:SS" (time-only results in Search Failed!)
#   --chn is 1-based, same as the UI display (--chn 1 = UI's ch1)
node recordings/download-cli.js --chn 1 \
  --begin "2026-06-02 00:00:00" --end "2026-06-02 23:59:59"
```

> Note: The key points are the DVR specifications that "**date-time must be a full date-time string**" and "**`--chn` is 1-based, same as the UI display**" (see [API Specification](#dvr-recording-api-specification-on-device-testing-summary)). DVR status (connectivity, authentication, HDD/IPC/recording state) can also be checked from the Web UI (`server.js`) side.

---

## Configuration (Environment Variables)

Credentials and connection targets can be **overridden via environment variables**. **Do not write secrets other than defaults into the source** (once you set a password, pass it via an environment variable).

| Environment Variable | Default | Description |
| --- | --- | --- |
| `DVR_HOST` | `192.0.2.14` | DVR IP / hostname |
| `DVR_USER` | `admin` | DVR Basic auth user |
| `DVR_PASS` | (empty) | DVR Basic auth password |
| `BIND_ADDR` | `127.0.0.1` | Listen address. Defaults to localhost-only. Use `0.0.0.0` only when exposing to the LAN |
| `PORT` | `3914` | Recording server listen port |

Example usage:

```sh
# Example of starting on a different port in an environment with a password set
DVR_PASS='********' PORT=4000 node recordings/server.js
```

> **Strongly recommended**: Always set a password for the DVR / camera and pass it via environment variables such as `DVR_PASS`. For the dangers of operating with an empty password, see the [Security Warning](#security-warning-must-read).

---

## How It Works (Architecture)

Because the DVR's own recording HTTP API does not work on this unit ([see below](#why-you-cant-download-directly-from-the-dvr-conclusions-from-on-device-testing)), **the actual recording is done by capturing the RTSP of the source camera `192.0.2.146` behind DVR ch0** yourself. It shares the same camera and the same RTSP as the go2rtc live viewer.

```
                         (best-effort / 0 items & 404 on this unit)
        ┌───────────── HTTP Basic ─────────────┐
        │  netsdk R.SearchRecord / flv.cgi      │
        ▼                                       │
┌──────────────────┐                            │
│  DVR (XVR)        │  ch0 source = same camera  │
│  192.0.2.14     │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
└──────────────────┘
                                  RTSP / H.265 (working path)
┌──────────────────┐ ───────────────────────────▶ ┌──────────────────────────────┐
│  WTW-IPC camera   │   ch0_0.264 (main 4K)         │  Recording server (localhost:3914) │
│  192.0.2.146    │   ch0_1.264 (sub 800x448)      │  ┌────────────────────────┐  │
│  admin / empty     │                               │  │ ffmpeg                 │  │
└──────────────────┘                               │  │ - time-segment recording│  │
                                                    │  │ - FLV/HEVC → MP4(H.264) │  │
                                                    │  │ - thumbnail (JPEG) gen  │  │
                                                    │  └───────────┬────────────┘  │
                                                    │  stored & indexed in recordings/ │
                                                    └──────────────┬───────────────┘
                                                                   │ HTTP (MP4 / JSON)
                                                                   ▼
                                                     ┌──────────────────────────┐
                                                     │  Browser                   │
                                                     │  recording UI at localhost:3914 │
                                                     │  MP4 playback / DL via <video> │
                                                     └──────────────────────────┘
```

- **Input (working)**: `rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_0.264` (main 4K, HEVC) /
  `.../ch0_1.264` (sub 800×448, HEVC).
- **Conversion**: `ffmpeg` performs time-segment recording, generates H.264 MP4 for browser playback, and also creates thumbnails (JPEG). The server maintains the index (time, duration, size).
- **Input (best-effort)**: DVR `192.0.2.14` netsdk `R.SearchRecord` (recording list) / `flv.cgi` (download). **On this unit it returns 0 items / 404**, but it is designed so that on a supported-firmware unit you can list and download from here.
- **Output**: Recording clips (MP4) and JSON metadata are placed under `recordings/` and served from `http://localhost:3914`.

---

## DVR Recording API Specification (On-Device Testing Summary)

The following is **the specification confirmed on the real device `192.0.2.14` (XVR, FW 3.2.2.6F)**. It is kept as a basis for using the direct DVR search client and for porting to other models. Note that **on this unit, search returns 0 items and `flv.cgi` returns 404** (see [Conclusions](#why-you-cant-download-directly-from-the-dvr-conclusions-from-on-device-testing)).

### Authentication

- **HTTP Basic** only. User `admin`, password **empty**.
- Header: `Authorization: Basic <base64("admin:")>` (colon after `admin`, empty PW).
- Authentication is enforced in practice (wrong PW / no PW → **401**, `admin:` empty → **200**).
- `POST /login` (`{DEV:"XVR",VER:"1.0",Parameter:{username:"admin",passwd:""}}`) also
  succeeds, but **no separate token is issued** (Basic only; the UI merely saves credentials in the cookies `xvr_usr` / `xvr_pwd`).
- The connection target and credentials can be overridden via the environment variables `DVR_HOST` / `DVR_USER` / `DVR_PASS`.

### Recording Search `R.SearchRecord`

```
POST http://192.0.2.14/netsdk/R.SearchRecord
Content-Type: application/json;charset=utf-8
Authorization: Basic <base64("admin:")>
```

Request body (**this form is "success"**; returns 0 items on this unit):

```json
{
  "DEV": "XVR",
  "VER": "1.0",
  "API": "R.SearchRecord",
  "Parameter": {
    "Channel": ["True","True","True","True","True","True","True","True","True"],
    "Type": ["Timing","Motion","Alarm","Manual"],
    "BeginTime": "2026-06-02 00:00:00",
    "EndTime": "2026-06-03 23:59:59",
    "PageSize": "100",
    "CurrentPage": "1"
  }
}
```

Confirmed key points:

- **`BeginTime` / `EndTime` must be "full date-time strings `YYYY-MM-DD HH:MM:SS`"**, otherwise they will not succeed.
  - OK example: `"2026-06-02 00:00:00"` / `"2026-06-03 23:59:59"` → `RetDetail:"Search Success!"` (`RetCode:"0"`).
  - **NG example**: time only `"00:00:00"` / `"23:59:59"`, Unix-second integers, empty `Parameter` →
    all result in `RetDetail:"Search Failed!"` (`RetCode:"-1"`, though HTTP is 200).
  - **Do not include `Reload:"True"`** (including it actually causes `Search Failed!`).
- **`Channel`** is a boolean array of `MAX_CHN` (=9) elements. `True` means "include that channel in the search" (not a channel name or index). To search ch0 only, use
  `["True","False","False","False","False","False","False","False","False"]`.
- **`Type`** is a name array of bit categories `{Timing, Motion, Alarm, Manual}` (the integer `15` or `[1,2,4,8]` also succeeds).
- The DVR's built-in clock matches the host (measured `SystemState.DateTime = "2026/06/03 ..."`) = **no offset correction needed**.

Success response schema (**determined from the decoding logic of the Web UI's own JS; no Item on this unit**):

```json
{
  "DEV": "XVR", "VER": "1.0", "API": "R.SearchRecord",
  "RetCode": "0", "RetDetail": "Search Success!",
  "ReadCnt": "<count>",
  "DataBasePath": "<path>",
  "Item": [
    { "Channel": "0", "TimeStart": 1717286400, "TimeEnd": 1717290000, "Type": 1 }
  ]
}
```

- `Channel` is a **0-based number string** (the UI displays `Number(Channel)+1`).
- `TimeStart` / `TimeEnd` are **Unix seconds (integers)**. The UI restores them with `new Date(1000*TimeStart)`. `Duration = TimeEnd - TimeStart`.
- `Type` is a **bitmask** `{1:Timing, 2:Motion, 4:Alarm, 8:Manual}`.
- **Measured on this unit**: For the entire 2024–2026 period and all `Channel`/`Type` values, it always returns `ReadCnt:"0"`, no `Item`, and `DataBasePath:"$"` (an unresolved placeholder). Even with the 2TB HDD 100% used and recording in progress (`RecordingState:"1"`), it returns 0 items.

### Recording Playback / Download `flv.cgi`

The format the UI generates (**HTTP 404 on this unit**):

```
GET http://192.0.2.14/cgi-bin/flv.cgi?u=${DVR_USER}&p=${DVR_PASS}&mode=time&chn=<ch>&begin=<UnixSec>&end=<UnixSec>&audio=54&mute=false&rnd=<random>
```

- `chn` is **0-based**, `begin`/`end` are the recording Item's `TimeStart`/`TimeEnd` (**Unix seconds**), and `p=` is the empty password. On success it is designed to return an **FLV stream** for the time range.
- **On this unit (FW 3.2.2.6F), `mode=time` / `real` / `playback` and all parameters return 404.**
  `cgi-bin/gw.cgi` also returns 404. It is a relic of the Flash era and is not included in this build.

### Related Endpoints Usable for Configuration Retrieval

All use `{DEV,VER,API,Parameter}` + Basic. **Use the following for configuration retrieval** (do not use the "SET-type templates" below):

| Endpoint | Purpose |
| --- | --- |
| `POST /netsdk/Stat` | **Most important.** Returns device/HDD/IPC/recording state as real data |
| `POST /netsdk/GetChannelDetail` | Resolution and details for 9 channels |
| `POST /netsdk/Record` | Recording schedule |
| `POST /netsdk/R.SEARCH.Ipc` | List of connected IPCs (ch0 = `192.0.2.146`) |
| `POST /netsdk/LogSearch` | Log search (`SearchCnt:0` on this unit) |
| `POST /login` | Authentication check |

> **Unusable endpoints (caution)**: `/netsdk/Channel`, `/netsdk/General`,
> `/netsdk/Stat/Storage`, etc. are **SET-type templates** that, for both GET/POST, merely echo `"$.<API>"` and return `"StatusCode":"ok"` / `"Save success"`; they cannot be used for configuration retrieval. For configuration retrieval, use `/netsdk/Stat` and `/netsdk/GetChannelDetail`.

### Channel Configuration

- **9-channel configuration (`MAX_CHN` = 9)**. Confirmed via `/netsdk/Stat` / `/netsdk/GetChannelDetail`.
- **Only ch0 (UI display ch1) has a real camera connected**:
  `Status:"Connect success"`, `BcamOnline:"True"`, `RecordingState:"1"`. The actual device is
  **`192.0.2.146` WTW-IPC** (main 3840×2160 HEVC / 4Mbps, sub 800×448 HEVC / 512kbps). ch1–8 are not connected.
- The **ch number for recording Items / `flv.cgi` is 0-based** (the UI adds 1 for display).

---

## Why You Can't Download Directly from the DVR (Conclusions from On-Device Testing)

On the `.14` DVR (WTW-EG2 series, FW 3.2.2.6F / 2022), **there is currently no path to reproduce "recording search → download" over HTTP**. Diagnostic results:

1. **Connectivity and authentication are OK.** 200 with Basic `admin:` (empty PW) (wrong PW gives 401).
2. **`R.SearchRecord` always returns 0 items even with a success response.** Setting `BeginTime`/`EndTime` to full date-times yields `Search Success!`, but for the entire period and all `Channel`/`Type` values it returns `ReadCnt:"0"`, no `Item`, and `DataBasePath:"$"` (unresolved). **0 items despite the 2TB HDD being 100% used and recording in progress** = this netsdk search API does not return the recording index (most likely a firmware implementation constraint/bug). `LogSearch` also returns `SearchCnt:0`.
3. **`cgi-bin/flv.cgi` returns 404 for every parameter.** The top of the Web UI uses a legacy design that plays via `swfobject.js` (Flash) + ActiveX OCX (`dvr_ocx.OpenStream`), and the actual recording playback/download is a **Windows / IE-only OCX binary-over-HTTP protocol** (not reproducible with `curl`/`ffmpeg`).
4. **The only open ports are 80 and UDP 3702 (WS-Discovery).** RTSP(554) / SDK(37777, etc.) / RTMP(1935) / ONVIF HTTP are all closed or 404.
   - ONVIF (Profile G) is a possibility since UDP 3702 is open, but there is no response to unicast WS-Discovery Probe, and `/onvif/*` all return 404 on port 80. Making it practical requires additional investigation such as obtaining XAddrs via multicast 3702, and it is not yet established.

**→ Adopted alternative (proven)**: The **source camera `192.0.2.146` (WTW-IPC)** behind DVR ch0 has **RTSP operation confirmed by actual retrieval via ffprobe** on ports 80 + 554:

- `rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_0.264` (main HEVC 3840×2160 + PCM_alaw audio)
- `rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_1.264` (sub HEVC 800×448)

The existing go2rtc-viewer go2rtc live viewer also uses the same `.146` RTSP. This recording feature **segment-records this `.146` RTSP with `ffmpeg`, accumulates it in `recordings/`, and provides its own search/playback UI**. If you want to extract **the actual recording files inside the DVR**, use the **vendor's native client on a real Windows machine / IE + OCX** (because this firmware's netsdk search / `flv.cgi` download do not work).

---

## Troubleshooting

### The recording list is empty (direct DVR search returns 0 items)

- **This is the (known) behavior of this unit.** `R.SearchRecord` always returns 0 items even with a success response
  (see [Conclusions](#why-you-cant-download-directly-from-the-dvr-conclusions-from-on-device-testing)). There is no way to extract recordings from this unit over HTTP. If you want to retain recordings, manually capture the camera's RTSP with `ffmpeg` as described in the Overview (this repository does not include a recorder).
- If you only want to check DVR status, use `/netsdk/Stat` (Web UI / `download-cli.js`) and see whether HDD/IPC/recording state is returned as real data.

### `Search Failed!` (RetCode: -1) is returned

- Check the **date-time format**: `BeginTime`/`EndTime` must be a **full date-time `YYYY-MM-DD HH:MM:SS`**.
  Time-only, Unix seconds, and an empty `Parameter` all fail.
- Check that you are **not including** `Reload:"True"` (it fails if included).

### `flv.cgi` returns 404 (direct DVR download is not possible)

- **This is also the (known) behavior of this unit.** `flv.cgi` returns 404 for all modes and all parameters.
  On this unit, recordings cannot be extracted from the DVR over HTTP.

### Manual ffmpeg capture does not work

This repository has no automatic recording feature. Diagnostics for manual `ffmpeg` capture as described in the Overview:

- Check that `ffmpeg` is on the PATH with `command -v ffmpeg` (if not, run `brew install ffmpeg`).
- Check that the source camera is reachable:

  ```sh
  ping 192.0.2.146
  ffprobe "rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_0.264"
  ```

  If stream information (HEVC / resolution) appears, the recording source is delivering.
- Check that you are on the same LAN (a VPN / different segment makes it unreachable), and that the authentication (`admin` / empty / port 554) matches the real device.
- Check write permissions and free space for the output destination `recordings/`.

### 401 Unauthorized (DVR)

- Check that `DVR_USER` / `DVR_PASS` match the real device. **Once you set a password**, pass it via the `DVR_PASS` environment variable (wrong PW / no PW gives 401; only `admin:` empty gives 200).

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

### 1. DVRs / cameras with no password set are dangerous

The DVR (`192.0.2.14`) and the source camera (`192.0.2.146`) run with **`admin` / empty password**. This means:

- From the same LAN (and, if misconfigured to be externally exposed, from the internet), **anyone can peek at the video/recordings and change settings**.
- There is a serious risk of leaking your home's privacy to third parties.

👉 **Be sure to set a strong, hard-to-guess password from the DVR / camera management screen (strongly recommended).** After setting it, update this feature's `DVR_PASS` environment variable (and the RTSP URL on the go2rtc side). **Do not hard-code the password into the source code.**

### 2. Manage credentials via environment variables

- Pass the connection target and credentials via the **environment variables** `DVR_HOST` / `DVR_USER` / `DVR_PASS` (plus `BIND_ADDR` / `PORT`). **Do not commit** files containing secret values.
- The **recording outputs (clips, thumbnails, cache) in this directory are `.gitignore`-d**. Since recordings contain video, be careful not to accidentally include them in a public repository.

### 3. Do not expose to the internet

- The recording server (`3914`) and the DVR / camera are intended **for LAN-only access**.
- **Do not expose `3914` / `80` / `554`, etc. externally via router port forwarding or UPnP.**
- It is recommended to run the recording server limited to localhost (`127.0.0.1:3914`). Even when you want to view it from other devices on the LAN, limit it to a trusted network and protect it with a firewall. When away from home, use a VPN.

### 4. Verify P2P / cloud transmission

- Many Chinese-made DVRs / IP cameras (including WTW-IPC / XVR) come with **P2P / cloud features** that, depending on settings, may transmit video and connection information to the manufacturer's servers.
- It is strongly recommended to **disable P2P / cloud / remote access features from the management screen** and block unnecessary external communication. If possible, block the device's internet-bound traffic at the router and **isolate it within the LAN**.

---

## File Structure

| File / Directory | Role |
| --- | --- |
| `recordings/server.js` | Recording backend (DVR API client + static-serving server). Node standard only |
| `recordings/download-cli.js` | CLI for searching/downloading DVR recordings (`--help` / `--list` / `--chn`) |
| `recordings/public/` | Recording UI (search form, list, player: `recordings.html` / `.css` / `.js`) |
| `recordings/data/` | Runtime output for recordings/clips, etc. (MP4 / thumbnails / index). `.gitignore`-d |
| `recordings/README.md` | This document |

> The output directory name (`data/`, etc.) follows the implementation of `server.js`. **Runtime outputs** such as recording clips, thumbnails, cache, and PID/logs are **`.gitignore`-d**, and only the source (`server.js` / `web/` / this README) is tracked.

---

> This feature operates independently of live viewing (go2rtc). For how to use live viewing and the overall security policy, refer to the root `README.md` of the repository.