#!/usr/bin/env node
'use strict';

/*
 * recordings/server.js
 *
 * Recording search / download / playback backend for IP video recorders.
 *
 * This is a thin, dependency-free Node service (standard library only) that
 * normalizes recording search/download/playback for a browser UI. It coexists
 * with the existing go2rtc live viewer: it listens on its own port and serves
 * its own static UI from recordings/public/.
 *
 * BACKEND SELECTOR (RECORDINGS_BACKEND, default 'onvif'):
 *   - 'onvif'  (DEFAULT): vendor-neutral ONVIF Profile G via recordings/onvif.js
 *     (Device Management + Recording Search + Replay Control). The handlers
 *     below delegate to that module and ffmpeg reads the replay RTSP directly.
 *   - 'netsdk' (LEGACY opt-in fallback): the original WTW/XVR netsdk JSON API +
 *     flv.cgi recording stream. Kept intact, gated behind RECORDINGS_BACKEND=
 *     netsdk, so other firmware/models retain a working-shaped client. All the
 *     netsdk-specific bodies (dvrApi, channelMask, flvUrl, openFlvStream,
 *     streamFlvRaw, normalizeSearch, toDvrDateTime usage) live behind that flag.
 *
 * The generic scaffolding (HTTP server/router, security headers, CORS preflight,
 * 405 guard, static serving + MIME, sendJson/sendError envelope, resolveFfmpeg,
 * the ffmpeg remux/streaming/teardown machinery, time-window parsing) is shared
 * by both backends.
 *
 * Design notes / known device behavior (netsdk path; see project recon for full detail):
 *   - Auth is HTTP Basic. Header: "Basic " + base64(user + ":" + pass).
 *     The DVR's default is user "admin" with an EMPTY password. Empty password
 *     is a serious security risk; change it on the DVR and override here via
 *     the DVR_USER / DVR_PASS environment variables. LAN use only.
 *   - Record search:  POST /netsdk/R.SearchRecord
 *       body {DEV,VER,API,Parameter:{Channel[],Type[],BeginTime,EndTime,...}}
 *       BeginTime/EndTime MUST be full "YYYY-MM-DD HH:MM:SS" strings, in the
 *       DVR's local time, or the search fails. Do NOT send Reload:"True".
 *       Result items carry TimeStart/TimeEnd as Unix seconds and a Type bitmask.
 *   - Channels are 0-based on the wire (UI shows Number(Channel)+1).
 *   - Recording playback/download:  GET /cgi-bin/flv.cgi?...&chn=<0based>&
 *       begin=<unixsec>&end=<unixsec>&...  -> time-ranged FLV stream.
 *
 * IMPORTANT firmware caveat: on the specific unit this was built against
 * (FW 3.2.2.6F), R.SearchRecord returns "Search Success!" but always with
 * ReadCnt:"0" and no items, and flv.cgi returns HTTP 404 -- i.e. the DVR does
 * not actually serve its recordings over HTTP on that firmware. This server is
 * written to the documented protocol so it works correctly against a DVR whose
 * firmware DOES implement it (or a different DVR_HOST), and to degrade clearly
 * (honest errors, never a hang) when the device refuses. The /api/health and
 * /api/recordings/search responses surface this state to the UI.
 *
 * No home-directory absolute paths or PII are written into this file: paths are
 * resolved relative to __dirname, and the ffmpeg binary is located on PATH.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');
const { spawn, spawnSync } = require('child_process');

// Load a sibling/repo-root .env (KEY=VALUE per line) with no npm dependency,
// so real DVR_* values come from the gitignored .env when run standalone
// (start.sh does NOT launch this server). Real environment variables always
// win; .env only fills the gaps.
(function loadDotEnv() {
  for (const envPath of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
    let txt;
    try { txt = fs.readFileSync(envPath, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const v = m[2].replace(/^(['"])(.*)\1$/, '$2'); // strip optional surrounding quotes
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
})();

// ---------------------------------------------------------------------------
// Backend selector. RECORDINGS_BACKEND=onvif (default) | netsdk.
//   - onvif:  vendor-neutral ONVIF Profile G via recordings/onvif.js.
//   - netsdk: legacy WTW/XVR netsdk JSON API + flv.cgi (opt-in fallback).
// The onvif module is required lazily so the netsdk fallback never loads it.
// ---------------------------------------------------------------------------
const BACKEND = (process.env.RECORDINGS_BACKEND || 'onvif').toLowerCase();
const onvif = BACKEND === 'onvif' ? require('./onvif') : null;

// ---------------------------------------------------------------------------
// Configuration (all overridable via environment variables).
//
// Host/user/pass/timeouts read ONVIF_* FIRST, then DVR_* as a backward-
// compatible fallback so existing .env files keep working. The DVR_PASS=''
// (empty-allowed) semantics are preserved via the explicit !== undefined chain.
// DVR_DEV / DVR_VER / DVR_MAX_CHN are netsdk-only concepts (XVR/1.0/9) and are
// read ONLY in the netsdk branch (handlers below).
// ---------------------------------------------------------------------------
function resolveConfigPass() {
  // Preserve empty-string-allowed: ONVIF_PASS ?? DVR_PASS ?? ''.
  if (process.env.ONVIF_PASS !== undefined) return process.env.ONVIF_PASS;
  if (process.env.DVR_PASS !== undefined) return process.env.DVR_PASS;
  return '';
}

const CONFIG = {
  host: process.env.ONVIF_HOST || process.env.DVR_HOST || '192.0.2.14',
  user: process.env.ONVIF_USER || process.env.DVR_USER || 'admin',
  // Empty password is the device default. Override with ONVIF_PASS/DVR_PASS.
  pass: resolveConfigPass(),
  port: parseInt(process.env.PORT || '3914', 10),
  // Bind address. Default to localhost only (safe default for a no-auth
  // backend); set BIND_ADDR=0.0.0.0 to reach it from other LAN hosts (firewall
  // it; never expose to the internet).
  bindAddr: process.env.BIND_ADDR || '127.0.0.1',
  // --- netsdk-only knobs (ignored in the onvif backend) ---
  dev: process.env.DVR_DEV || 'XVR',
  ver: process.env.DVR_VER || '1.0',
  // Max channels the netsdk DVR exposes (recon: MAX_CHN = 9). In the onvif
  // backend, channel count is derived from the RecordingToken map instead.
  maxChannels: parseInt(process.env.DVR_MAX_CHN || '9', 10),
  // Network timeout (ms) for requests to the device API (ONVIF_* then DVR_*).
  apiTimeoutMs: parseInt(
    process.env.ONVIF_API_TIMEOUT_MS || process.env.DVR_API_TIMEOUT_MS || '15000',
    10
  ),
  // Idle timeout (ms) for the (potentially long) media stream (netsdk flv.cgi):
  // time-to-first-byte must arrive within this window; the body itself may
  // stream for much longer.
  mediaConnectTimeoutMs: parseInt(process.env.DVR_MEDIA_TIMEOUT_MS || '20000', 10),
};

// Recording Type bitmask -> human label (from the DVR UI's decode logic).
const TYPE_BITS = [
  { bit: 1, name: 'Timing' },
  { bit: 2, name: 'Motion' },
  { bit: 4, name: 'Alarm' },
  { bit: 8, name: 'Manual' },
];

// Locate ffmpeg on PATH (used for FLV -> MP4 remux). Resolved once at startup.
const FFMPEG = resolveFfmpeg();

function resolveFfmpeg() {
  // Prefer an explicit override, else look it up on PATH via the platform's
  // resolver. We avoid hard-coding any absolute path so nothing machine- or
  // user-specific is baked in.
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const which = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? ['ffmpeg'] : ['-v', 'ffmpeg'];
  try {
    const r = spawnSync(which, args, { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).find(Boolean);
      if (first) return first.trim();
    }
  } catch (_) {
    /* fall through */
  }
  // Last resort: rely on PATH at spawn time.
  return 'ffmpeg';
}

function authHeader() {
  const token = Buffer.from(`${CONFIG.user}:${CONFIG.pass}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Split CONFIG.host into { hostname, port }. DVR_HOST may be a bare host
 * ("192.0.2.14") or include a port ("192.0.2.14:8080"); the netsdk API
 * and flv.cgi must both target that same port. Default port is 80.
 */
function dvrTarget() {
  const h = String(CONFIG.host);
  const idx = h.lastIndexOf(':');
  if (idx > -1 && /^\d+$/.test(h.slice(idx + 1))) {
    return { hostname: h.slice(0, idx), port: Number(h.slice(idx + 1)) };
  }
  return { hostname: h, port: 80 };
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers to the DVR.
// ---------------------------------------------------------------------------

/**
 * POST a netsdk JSON API call to the DVR and return the parsed JSON body.
 * Wraps the given Parameter object in the {DEV,VER,API,Parameter} envelope.
 * Rejects on network error, timeout, or non-2xx status.
 */
function dvrApi(api, parameter) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      DEV: CONFIG.dev,
      VER: CONFIG.ver,
      API: api,
      Parameter: parameter || {},
    });
    const target = dvrTarget();
    const options = {
      host: target.hostname,
      port: target.port,
      path: `/netsdk/${api}`,
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) {
          return reject(httpError(401, 'DVR rejected credentials (401). Check DVR_USER/DVR_PASS.'));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(httpError(502, `DVR API ${api} returned HTTP ${res.statusCode}`, { body }));
        }
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          return reject(httpError(502, `DVR API ${api} returned non-JSON response`, { body }));
        }
        resolve({ json, raw: body, statusCode: res.statusCode });
      });
    });
    req.on('error', (e) => reject(httpError(502, `Cannot reach DVR at ${CONFIG.host}: ${e.code || e.message}`)));
    req.setTimeout(CONFIG.apiTimeoutMs, () => {
      req.destroy(httpError(504, `DVR API ${api} timed out after ${CONFIG.apiTimeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

function httpError(status, message, extra) {
  const e = new Error(message);
  e.statusCode = status;
  if (extra) Object.assign(e, extra);
  return e;
}

// ---------------------------------------------------------------------------
// Time helpers. The DVR speaks two time dialects:
//   - R.SearchRecord Begin/EndTime: "YYYY-MM-DD HH:MM:SS" in DVR-local time.
//   - flv.cgi begin/end and record item TimeStart/TimeEnd: Unix seconds.
// The recon confirmed the DVR's clock matches the host (no offset), so we
// format using the host's LOCAL time, which keeps the wire values aligned
// with what an operator sees on the DVR.
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Format a Date (or Unix-seconds number) as "YYYY-MM-DD HH:MM:SS" local time.
 *
 * NETSDK-ONLY: the legacy DVR speaks DVR-local "YYYY-MM-DD HH:MM:SS". The ONVIF
 * backend must NOT use this — ONVIF xs:dateTime is UTC ISO-8601 'Z' (handled by
 * onvif.js unixToIsoZ with measured clock-skew). Do not call this in the onvif
 * code path.
 */
function toDvrDateTime(input) {
  const d = typeof input === 'number' ? new Date(input * 1000) : input;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Parse "YYYY-MM-DD HH:MM:SS" (DVR local) into Unix seconds, or null. */
function dvrDateTimeToUnix(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), 0
  );
  return Math.floor(d.getTime() / 1000);
}

/**
 * Resolve the requested time window from query params into both dialects.
 * Accepts (in priority order):
 *   - date=YYYY-MM-DD + begin/end as time-of-day (HH:MM or HH:MM:SS)
 *       -> that day's local time range (the natural shape of a date+time form)
 *   - date=YYYY-MM-DD alone -> that whole local day (00:00:00..23:59:59)
 *   - begin & end as Unix seconds (integers)
 *   - begin & end as full "YYYY-MM-DD HH:MM:SS"
 * Returns {beginUnix, endUnix, beginStr, endStr} or throws a 400.
 */
function resolveWindow(q) {
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
  const timeOfDay = (s) => {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim());
    if (!m) return null;
    const hh = Number(m[1]), mm = Number(m[2]), ss = m[3] ? Number(m[3]) : 0;
    if (hh > 23 || mm > 59 || ss > 59) return null;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  };

  // date + time-of-day form (date picker + time inputs).
  if (isDate(q.date) && (q.begin || q.end)) {
    const bt = q.begin !== undefined ? timeOfDay(q.begin) : '00:00:00';
    const et = q.end !== undefined ? timeOfDay(q.end) : '23:59:59';
    if (bt !== null && et !== null) {
      const beginStr = `${q.date} ${bt}`;
      const endStr = `${q.date} ${et}`;
      const beginUnix = dvrDateTimeToUnix(beginStr);
      const endUnix = dvrDateTimeToUnix(endStr);
      if (endUnix <= beginUnix) throw httpError(400, 'end must be after begin');
      return { beginUnix, endUnix, beginStr, endStr };
    }
    // If begin/end were not time-of-day, fall through to the other forms.
  }

  // Whole-day form.
  if (q.date && !q.begin && !q.end) {
    if (!isDate(q.date)) throw httpError(400, 'Invalid "date"; expected YYYY-MM-DD');
    const beginStr = `${q.date} 00:00:00`;
    const endStr = `${q.date} 23:59:59`;
    return {
      beginUnix: dvrDateTimeToUnix(beginStr),
      endUnix: dvrDateTimeToUnix(endStr),
      beginStr,
      endStr,
    };
  }

  if (q.begin && q.end) {
    const beginUnix = normalizeToUnix(q.begin);
    const endUnix = normalizeToUnix(q.end);
    if (beginUnix == null || endUnix == null) {
      throw httpError(400, 'Invalid begin/end; use Unix seconds or "YYYY-MM-DD HH:MM:SS"');
    }
    if (endUnix <= beginUnix) throw httpError(400, 'end must be after begin');
    return {
      beginUnix,
      endUnix,
      beginStr: toDvrDateTime(beginUnix),
      endStr: toDvrDateTime(endUnix),
    };
  }

  throw httpError(400, 'Provide either "date=YYYY-MM-DD" or both "begin" and "end"');
}

/** Coerce a value that may be Unix seconds or a datetime string into Unix sec. */
function normalizeToUnix(v) {
  const s = String(v).trim();
  if (/^\d{9,11}$/.test(s)) return parseInt(s, 10); // Unix seconds
  return dvrDateTimeToUnix(s);
}

// ---------------------------------------------------------------------------
// Channel selection helpers.
// The DVR's R.SearchRecord wants a MAX_CHN-length boolean array as the
// strings "True"/"False"; index i selects 0-based channel i.
// ---------------------------------------------------------------------------

function channelMask(chn) {
  const arr = new Array(CONFIG.maxChannels).fill('False');
  if (chn === undefined || chn === null || chn === '' || String(chn).toLowerCase() === 'all') {
    return arr.fill('True');
  }
  // Accept a single index ("0") or a comma-separated list ("0,1,3") — the
  // browser UI sends a list (multi-channel select); the CLI/API a single one.
  const indices = String(chn)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length);
  if (!indices.length) return arr.fill('True');
  for (const tok of indices) {
    const idx = parseInt(tok, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= CONFIG.maxChannels) {
      throw httpError(400, `Invalid channel ${tok}; expected 0..${CONFIG.maxChannels - 1} or "all"`);
    }
    arr[idx] = 'True';
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Normalization of the DVR's search result into our stable JSON shape.
// ---------------------------------------------------------------------------

function typeBitsToLabels(typeVal) {
  const n = parseInt(typeVal, 10);
  if (Number.isNaN(n)) return [];
  return TYPE_BITS.filter((t) => (n & t.bit) !== 0).map((t) => t.name);
}

/** Build the flv.cgi playback URL the UI/clip endpoint will use for an item. */
function flvUrl(chn, beginUnix, endUnix) {
  const p = new URLSearchParams({
    u: CONFIG.user,
    p: CONFIG.pass,
    mode: 'time',
    chn: String(chn),
    begin: String(beginUnix),
    end: String(endUnix),
    audio: '54',
    mute: 'false',
  });
  return `http://${CONFIG.host}/cgi-bin/flv.cgi?${p.toString()}`;
}

/**
 * Convert the raw DVR R.SearchRecord JSON into:
 *   { ok, retCode, retDetail, readCnt, dataBasePath, window, items[] }
 * where each item is
 *   { chn, channelDisplay, begin, end, durationSec, sizeBytes, types, stream }
 * begin/end are Unix seconds; stream is a same-origin URL the UI can play.
 */
function normalizeSearch(json, win) {
  const items = Array.isArray(json.Item) ? json.Item : [];
  const out = items.map((it) => {
    const chn = parseInt(it.Channel, 10) || 0;
    const begin = parseInt(it.TimeStart, 10) || 0;
    const end = parseInt(it.TimeEnd, 10) || 0;
    // The DVR's search schema carries no byte size; expose null rather than 0
    // so the UI can distinguish "unknown" from "empty".
    const sizeBytes = it.Size !== undefined ? parseInt(it.Size, 10) : null;
    return {
      chn,
      channelDisplay: chn + 1, // DVR UI shows 1-based
      begin,
      end,
      durationSec: end > begin ? end - begin : 0,
      sizeBytes: Number.isNaN(sizeBytes) ? null : sizeBytes,
      types: typeBitsToLabels(it.Type),
      typeRaw: it.Type !== undefined ? String(it.Type) : null,
      // Same-origin playback (inline MP4) and download URLs for this clip.
      stream: `/api/recordings/clip.mp4?chn=${chn}&begin=${begin}&end=${end}`,
      downloadMp4: `/api/recordings/download?chn=${chn}&begin=${begin}&end=${end}&format=mp4`,
      downloadFlv: `/api/recordings/download?chn=${chn}&begin=${begin}&end=${end}&format=flv`,
      // The upstream DVR URL is included for transparency/debugging only.
      flvUpstream: flvUrl(chn, begin, end),
    };
  });

  const retCode = json.RetCode !== undefined ? String(json.RetCode) : null;
  const success = retCode === '0';
  const readCnt = json.ReadCnt !== undefined ? parseInt(json.ReadCnt, 10) : out.length;

  // Surface the documented firmware caveat so the UI can explain an empty list.
  let note = null;
  if (success && out.length === 0) {
    const dbp = json.DataBasePath;
    if (dbp === '$' || dbp === undefined || dbp === '') {
      note =
        'The DVR accepted the search ("Search Success!") but returned no recording index ' +
        '(ReadCnt 0, DataBasePath unresolved). On some firmware (e.g. 3.2.2.6F) the DVR does ' +
        'not expose its recordings over this HTTP API even though it is actively recording.';
    } else {
      note = 'No recordings match the requested window.';
    }
  }

  return {
    ok: success,
    retCode,
    retDetail: json.RetDetail || null,
    readCnt: Number.isNaN(readCnt) ? out.length : readCnt,
    dataBasePath: json.DataBasePath !== undefined ? String(json.DataBasePath) : null,
    window: {
      beginUnix: win.beginUnix,
      endUnix: win.endUnix,
      begin: win.beginStr,
      end: win.endStr,
    },
    note,
    items: out,
  };
}

// ---------------------------------------------------------------------------
// flv.cgi streaming + optional ffmpeg remux to MP4.
// ---------------------------------------------------------------------------

/**
 * Open the DVR's flv.cgi stream for a window and invoke onResponse(res) with
 * the upstream IncomingMessage on success. Handles 404 (firmware caveat) and
 * timeouts by calling onError(err). Returns the ClientRequest so the caller
 * can abort it if the client disconnects.
 */
function openFlvStream(chn, beginUnix, endUnix, onResponse, onError) {
  const target = flvUrl(chn, beginUnix, endUnix);
  const u = new URL(target);
  const options = {
    host: u.hostname,
    port: u.port || 80,
    path: u.pathname + u.search,
    method: 'GET',
    headers: { Authorization: authHeader(), Accept: '*/*' },
  };
  const req = http.request(options, (res) => {
    if (res.statusCode === 401) {
      res.resume();
      return onError(httpError(401, 'DVR rejected credentials for flv.cgi (401).'));
    }
    if (res.statusCode === 404) {
      res.resume();
      return onError(
        httpError(
          501,
          'DVR returned 404 for flv.cgi. This firmware does not serve recordings over ' +
            'flv.cgi (Flash-era endpoint absent). Recording download is unavailable on this device.'
        )
      );
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      return onError(httpError(502, `flv.cgi returned HTTP ${res.statusCode}`));
    }
    onResponse(res);
  });
  req.on('error', (e) =>
    onError(httpError(502, `Cannot reach DVR flv.cgi at ${CONFIG.host}: ${e.code || e.message}`))
  );
  req.setTimeout(CONFIG.mediaConnectTimeoutMs, () => {
    req.destroy(httpError(504, `flv.cgi did not respond within ${CONFIG.mediaConnectTimeoutMs}ms`));
  });
  req.end();
  return req;
}

/**
 * Pipe the FLV stream from the DVR through ffmpeg, remuxing to fragmented MP4
 * (no re-encode: -c copy), writing to the given writable HTTP response.
 * `disposition` is 'inline' (playback) or 'attachment' (download).
 */
function streamFlvAsMp4(chn, beginUnix, endUnix, res, disposition, downloadName) {
  let ff = null;
  let upstreamReq = null;
  let headersSent = false;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    try { if (upstreamReq) upstreamReq.destroy(); } catch (_) {}
    try { if (ff) ff.kill('SIGKILL'); } catch (_) {}
  };

  upstreamReq = openFlvStream(
    chn,
    beginUnix,
    endUnix,
    (flv) => {
      // Spawn ffmpeg: read FLV from stdin, remux to fMP4 on stdout.
      // -movflags frag_keyframe+empty_moov+faststart lets the MP4 stream
      // progressively without a seekable output (we pipe to a socket).
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', '+genpts',
        '-i', 'pipe:0',
        '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
        '-f', 'mp4',
        'pipe:1',
      ];
      ff = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let ffErr = '';
      ff.stderr.on('data', (d) => {
        if (ffErr.length < 4096) ffErr += d.toString();
      });

      ff.on('error', (e) => {
        if (!headersSent) {
          sendError(res, httpError(500, `Failed to launch ffmpeg: ${e.message}`));
        } else {
          res.destroy();
        }
        cleanup();
      });

      ff.on('close', (code) => {
        if (!headersSent && code !== 0) {
          sendError(res, httpError(502, `ffmpeg remux failed (exit ${code}). ${ffErr.trim()}`.trim()));
        }
        cleanup();
      });

      // Send headers and start streaming on first MP4 byte so that an
      // upstream/ffmpeg failure before any data still yields a clean JSON error.
      ff.stdout.once('data', (first) => {
        headersSent = true;
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition':
            disposition === 'attachment'
              ? `attachment; filename="${downloadName}"`
              : 'inline',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no',
        });
        res.write(first);
        ff.stdout.pipe(res);
      });

      // Wire upstream FLV -> ffmpeg stdin.
      flv.pipe(ff.stdin);
      flv.on('error', () => cleanup());
      ff.stdin.on('error', () => {/* ffmpeg may close stdin early; ignore */});
    },
    (err) => {
      if (!headersSent) sendError(res, err);
      else res.destroy();
      cleanup();
    }
  );

  // If the browser disconnects, tear everything down.
  res.on('close', cleanup);
}

/**
 * ONVIF media leg: have ffmpeg read an ONVIF replay rtsp:// URI directly
 * (credentials + time window already embedded by onvif.replayUriForClip) and
 * remux to fragmented MP4 (no re-encode: -c copy), writing to the given HTTP
 * response. REUSES streamFlvAsMp4's deferred-headers-on-first-byte + ffmpeg
 * error/close handling + teardown/res.on('close') machinery VERBATIM; only the
 * input changes — ffmpeg pulls RTSP itself (no FLV-from-stdin pipe, no -f flv;
 * RTSP input lets ffmpeg auto-demux). `disposition` is 'inline' (playback) or
 * 'attachment' (download).
 */
function streamRtspAsMp4(rtspUrl, res, disposition, downloadName) {
  let ff = null;
  let headersSent = false;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    try { if (ff) ff.kill('SIGKILL'); } catch (_) {}
  };

  // ffmpeg reads rtsp:// directly. -rtsp_transport tcp for NAT/firewall
  // reliability; -c copy = no re-encode; fragmented-mp4 flags so the MP4 streams
  // progressively over the non-seekable socket.
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
    '-f', 'mp4',
    'pipe:1',
  ];
  ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let ffErr = '';
  ff.stderr.on('data', (d) => {
    if (ffErr.length < 4096) ffErr += d.toString();
  });

  ff.on('error', (e) => {
    if (!headersSent) {
      sendError(res, httpError(500, `Failed to launch ffmpeg: ${e.message}`));
    } else {
      res.destroy();
    }
    cleanup();
  });

  ff.on('close', (code) => {
    if (!headersSent && code !== 0) {
      sendError(res, httpError(502, `ffmpeg replay/remux failed (exit ${code}). ${ffErr.trim()}`.trim()));
    }
    cleanup();
  });

  // Send headers and start streaming on the first MP4 byte so an ffmpeg/RTSP
  // failure before any data still yields a clean JSON error.
  ff.stdout.once('data', (first) => {
    headersSent = true;
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition':
        disposition === 'attachment'
          ? `attachment; filename="${downloadName}"`
          : 'inline',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(first);
    ff.stdout.pipe(res);
  });

  // If the browser disconnects, tear ffmpeg down.
  res.on('close', cleanup);
}

/** Stream raw FLV from the DVR straight to the client (passthrough). NETSDK-ONLY. */
function streamFlvRaw(chn, beginUnix, endUnix, res, downloadName) {
  let headersSent = false;
  const upstreamReq = openFlvStream(
    chn,
    beginUnix,
    endUnix,
    (flv) => {
      headersSent = true;
      res.writeHead(200, {
        'Content-Type': 'video/x-flv',
        'Content-Disposition': `attachment; filename="${downloadName}"`,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      flv.pipe(res);
      flv.on('error', () => res.destroy());
    },
    (err) => {
      if (!headersSent) sendError(res, err);
      else res.destroy();
    }
  );
  res.on('close', () => {
    try { upstreamReq.destroy(); } catch (_) {}
  });
}

// ---------------------------------------------------------------------------
// Static file serving for recordings/public/.
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  // Default document.
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/recordings.html';

  // Resolve safely inside PUBLIC_DIR; reject path traversal.
  const resolved = path.normalize(path.join(PUBLIC_DIR, rel));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, httpError(403, 'Forbidden'));
  }

  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      return sendError(res, httpError(404, 'Not found'));
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(resolved)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

// ---------------------------------------------------------------------------
// JSON / error response helpers.
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err && err.statusCode ? err.statusCode : 500;
  const payload = { ok: false, error: err && err.message ? err.message : 'Internal error', status };
  if (err && err.body) payload.upstream = String(err.body).slice(0, 500);
  // If headers already went out we cannot send JSON; just end.
  if (res.headersSent) {
    try { res.end(); } catch (_) {}
    return;
  }
  sendJson(res, status, payload);
}

// ---------------------------------------------------------------------------
// Route handlers.
// ---------------------------------------------------------------------------

/**
 * GET /api/health -- liveness of this service + reachability of the recorder.
 * ALWAYS returns HTTP 200 (the frontend reads only res.ok); errors are captured
 * into the body. Dispatches on RECORDINGS_BACKEND.
 */
async function handleHealth(req, res) {
  const result = {
    ok: true,
    service: 'go2rtc-viewer recordings backend',
    backend: BACKEND,
    time: new Date().toISOString(),
    config: {
      host: CONFIG.host,
      user: CONFIG.user,
      passwordSet: CONFIG.pass.length > 0,
      port: CONFIG.port,
      ffmpeg: FFMPEG,
    },
    dvr: { reachable: false },
  };

  if (BACKEND === 'onvif') {
    try {
      const p = await onvif.probe();
      result.dvr.reachable = !!p.reachable;
      result.dvr.authScheme = p.authScheme || null;
      result.dvr.deviceTime = p.deviceTime || null;
      result.dvr.skewMs = p.skewMs || 0;
      result.dvr.searchXAddr = p.searchXAddr || null;
      result.dvr.replayXAddr = p.replayXAddr || null;
      if (p.numRecordings !== undefined) {
        result.dvr.numRecordings = p.numRecordings;
        // maxChannels derives from the RecordingToken map for ONVIF.
        result.config.maxChannels = p.numRecordings;
      }
      if (p.error) {
        result.dvr.error = p.error;
        result.dvr.errorStatus = p.errorStatus || 502;
      }
      if (p.recordingsError) result.dvr.recordingsError = p.recordingsError;
    } catch (e) {
      // probe() is designed never to throw, but stay defensive: still 200.
      result.dvr.reachable = false;
      result.dvr.error = e.message;
      result.dvr.errorStatus = e.statusCode || 502;
    }
    return sendJson(res, 200, result);
  }

  // --- netsdk backend ---
  result.config.maxChannels = CONFIG.maxChannels;
  try {
    // /netsdk/Stat with empty Parameter is cheap and confirms auth+reachability
    // (it returns a SET-template echo, but a 200 means we are talking to it).
    const { json } = await dvrApi('Stat', {});
    result.dvr.reachable = true;
    result.dvr.statusCode = json.StatusCode || json.RetDetail || 'ok';
  } catch (e) {
    result.dvr.reachable = false;
    result.dvr.error = e.message;
    result.dvr.errorStatus = e.statusCode || 502;
  }
  sendJson(res, 200, result);
}

/**
 * GET /api/recordings/channels -- channel configuration for the picker.
 * Channel index is 0-based; display is +1. Dispatches on RECORDINGS_BACKEND.
 *
 * The onvif branch emits per-channel { channel, channelDisplay, online, name,
 * recording, recordingToken } — note 'channel' (NOT 'chn') so the frontend's
 * normalizeChannel reads the correct 0-based index.
 */
async function handleChannels(req, res) {
  if (BACKEND === 'onvif') {
    try {
      const channels = await onvif.listChannels();
      return sendJson(res, 200, {
        ok: true,
        maxChannels: channels.length,
        channels,
      });
    } catch (e) {
      return sendError(res, e);
    }
  }

  // --- netsdk backend: /netsdk/GetChannelDetail (per-channel stream specs) ---
  try {
    const { json } = await dvrApi('GetChannelDetail', {});
    const items = Array.isArray(json.Item) ? json.Item : [];
    const camCnt = json.CamCnt !== undefined ? parseInt(json.CamCnt, 10) : CONFIG.maxChannels;
    const channels = items.map((it, i) => {
      const main = (it.MainStream || '').trim();
      const sub = (it.SubStream || '').trim();
      const connected = main.length > 0 || sub.length > 0;
      return {
        chn: i,
        channelDisplay: i + 1,
        connected,
        mainStream: main || null,
        subStream: sub || null,
        swVersion: (it.SWVersion || '').trim() || null,
      };
    });
    sendJson(res, 200, {
      ok: true,
      maxChannels: Number.isNaN(camCnt) ? CONFIG.maxChannels : camCnt,
      channels,
    });
  } catch (e) {
    sendError(res, e);
  }
}

/**
 * GET /api/recordings/search?chn=&date=YYYY-MM-DD  (or &begin=&end=)
 * Returns the normalized search envelope { ok, source, window, note, items[] }.
 * Optional: &type=Timing,Motion,Alarm,Manual (defaults to all in netsdk),
 *           &pageSize= &page=. Dispatches on RECORDINGS_BACKEND:
 *   - onvif:  onvif.search(window, chnSel, typeSel) (window fed as UTC bounds).
 *   - netsdk: /netsdk/R.SearchRecord (DVR-local time strings).
 */
async function handleSearch(req, res, q) {
  // `channels` (comma list) is the browser UI's param; `chn` (single) is the
  // CLI/API param. Either selects which 0-based channels to search.
  const chnParam = q.channels !== undefined && q.channels !== '' ? q.channels : q.chn;
  // Type filter: accept `types` (UI, comma list) or `type` (API).
  const typeParam = q.types !== undefined && q.types !== '' ? q.types : q.type;

  if (BACKEND === 'onvif') {
    let win;
    try {
      // Reuse the generic window parser, but feed ONVIF only the Unix bounds:
      // do NOT pass the local-time beginStr/endStr (toDvrDateTime). onvif.search
      // builds its own UTC display strings (skew-corrected) from the Unix bounds.
      const parsed = resolveWindow(q);
      win = { beginUnix: parsed.beginUnix, endUnix: parsed.endUnix };
    } catch (e) {
      return sendError(res, e);
    }
    try {
      const normalized = await onvif.search(win, chnParam, typeParam);
      if (!normalized.ok) {
        return sendJson(res, 502, {
          ...normalized,
          error: normalized.error || 'ONVIF search failed',
        });
      }
      return sendJson(res, 200, normalized);
    } catch (e) {
      return sendError(res, e);
    }
  }

  // --- netsdk backend ---
  let win, channels;
  try {
    win = resolveWindow(q);
    channels = channelMask(chnParam);
  } catch (e) {
    return sendError(res, e);
  }

  // Type filter: default to all four recording types.
  let types = ['Timing', 'Motion', 'Alarm', 'Manual'];
  if (typeParam) {
    const requested = String(typeParam)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const valid = requested.filter((t) => TYPE_BITS.some((b) => b.name === t));
    if (valid.length) types = valid;
  }

  const parameter = {
    Channel: channels,
    Type: types,
    BeginTime: win.beginStr, // MUST be "YYYY-MM-DD HH:MM:SS"
    EndTime: win.endStr,
    PageSize: String(q.pageSize || '200'),
    CurrentPage: String(q.page || '1'),
    // NOTE: deliberately NOT sending Reload:"True" -- it makes the DVR fail.
  };

  try {
    const { json } = await dvrApi('R.SearchRecord', parameter);
    const normalized = normalizeSearch(json, win);
    // If the DVR explicitly failed the search, reflect that as a 502 with detail
    // so the UI does not silently show an empty list for a malformed query.
    if (!normalized.ok) {
      return sendJson(res, 502, {
        ...normalized,
        error: `DVR search failed: ${normalized.retDetail || normalized.retCode || 'unknown'}`,
      });
    }
    sendJson(res, 200, normalized);
  } catch (e) {
    sendError(res, e);
  }
}

/**
 * GET /api/recordings/download?chn=&begin=&end=&format=mp4|flv
 * Streams the recording. format=mp4 remuxes via ffmpeg (faststart) and sends
 * as an attachment; format=flv passes the DVR's FLV through unchanged.
 */
function handleDownload(req, res, q) {
  let chn, beginUnix, endUnix;
  try {
    ({ chn, beginUnix, endUnix } = parseClipParams(q));
  } catch (e) {
    return sendError(res, e);
  }
  const format = (q.format || 'mp4').toLowerCase();
  const base = `ch${chn + 1}_${beginUnix}_${endUnix}`;

  if (BACKEND === 'onvif') {
    // ONVIF replay is RTSP -> MP4 only; FLV is a netsdk/flv.cgi concept.
    if (format === 'flv') {
      return sendError(res, httpError(400, 'FLV is not available for the ONVIF backend; use format=mp4.'));
    }
    if (format !== 'mp4') {
      return sendError(res, httpError(400, 'format must be mp4'));
    }
    onvif
      .replayUriForClip({ chn, beginUnix, endUnix })
      .then((rtspUrl) => streamRtspAsMp4(rtspUrl, res, 'attachment', `${base}.mp4`))
      .catch((e) => sendError(res, e));
    return;
  }

  // --- netsdk backend ---
  if (format === 'flv') {
    streamFlvRaw(chn, beginUnix, endUnix, res, `${base}.flv`);
  } else if (format === 'mp4') {
    streamFlvAsMp4(chn, beginUnix, endUnix, res, 'attachment', `${base}.mp4`);
  } else {
    sendError(res, httpError(400, 'format must be mp4 or flv'));
  }
}

/**
 * GET /api/recordings/clip.mp4?chn=&begin=&end=
 * Inline MP4 for browser <video> playback (remuxed via ffmpeg).
 */
function handleClip(req, res, q) {
  let chn, beginUnix, endUnix;
  try {
    ({ chn, beginUnix, endUnix } = parseClipParams(q));
  } catch (e) {
    return sendError(res, e);
  }
  const name = `ch${chn + 1}_${beginUnix}_${endUnix}.mp4`;

  if (BACKEND === 'onvif') {
    onvif
      .replayUriForClip({ chn, beginUnix, endUnix })
      .then((rtspUrl) => streamRtspAsMp4(rtspUrl, res, 'inline', name))
      .catch((e) => sendError(res, e));
    return;
  }

  // --- netsdk backend ---
  streamFlvAsMp4(chn, beginUnix, endUnix, res, 'inline', name);
}

/** Shared parse for clip/download: chn (0-based) + begin/end (Unix or datetime).
 *  Accepts either `chn` (CLI/API style) or `channel` (the browser UI's name);
 *  both are the 0-based channel index. */
function parseClipParams(q) {
  const chnRaw = q.chn !== undefined && q.chn !== '' ? q.chn : q.channel;
  if (chnRaw === undefined || chnRaw === '') throw httpError(400, 'Missing chn/channel');
  const chn = parseInt(chnRaw, 10);
  // The netsdk backend has a fixed maxChannels (DVR_MAX_CHN); the onvif backend
  // derives channels from the RecordingToken map, so the upper bound is checked
  // server-side by onvif.chnToToken (valid 0..n-1) — only reject negatives here.
  if (Number.isNaN(chn) || chn < 0) {
    throw httpError(400, `Invalid channel ${chnRaw}; expected a 0-based index`);
  }
  if (BACKEND !== 'onvif' && chn >= CONFIG.maxChannels) {
    throw httpError(400, `Invalid channel ${chnRaw}; expected 0..${CONFIG.maxChannels - 1}`);
  }
  if (!q.begin || !q.end) throw httpError(400, 'Missing begin/end');
  const beginUnix = normalizeToUnix(q.begin);
  const endUnix = normalizeToUnix(q.end);
  if (beginUnix == null || endUnix == null) {
    throw httpError(400, 'Invalid begin/end; use Unix seconds or "YYYY-MM-DD HH:MM:SS"');
  }
  if (endUnix <= beginUnix) throw httpError(400, 'end must be after begin');
  return { chn, beginUnix, endUnix };
}

// ---------------------------------------------------------------------------
// HTTP server / router.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Parse with the WHATWG URL API. A dummy base lets us parse the path-only
  // request target; only pathname + query are used.
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (_) {
    return sendError(res, httpError(400, 'Bad request URL'));
  }
  const pathname = parsed.pathname;
  // Flatten searchParams into a plain object (last value wins) to match the
  // previous query-handling shape used by the route handlers.
  const q = {};
  for (const [k, v] of parsed.searchParams.entries()) q[k] = v;

  // Security headers on every response (defense-in-depth for the LAN-only UI).
  // X-Frame-Options is the HTTP-header equivalent of CSP frame-ancestors, which
  // a <meta>-delivered CSP cannot set — so the clickjacking guard lives here.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // CORS preflight (the UI may be served from a different origin, e.g. go2rtc).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method !== 'GET') {
    return sendError(res, httpError(405, 'Method not allowed'));
  }

  try {
    switch (pathname) {
      case '/api/health':
      // Alias: the browser UI polls /api/recordings/health for its
      // connection badge. Keep both so the UI and ad-hoc callers agree.
      case '/api/recordings/health':
        return void handleHealth(req, res);
      case '/api/recordings/channels':
        return void handleChannels(req, res);
      case '/api/recordings/search':
        return void handleSearch(req, res, q);
      case '/api/recordings/download':
        return handleDownload(req, res, q);
      case '/api/recordings/clip.mp4':
        return handleClip(req, res, q);
      default:
        // Anything else is a static asset request.
        return serveStatic(req, res, pathname);
    }
  } catch (e) {
    sendError(res, e);
  }
});

// Guard against unexpected stream errors crashing the process.
server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});
process.on('uncaughtException', (e) => {
  // Log and keep serving; a single bad request must not take the server down.
  console.error('[recordings] uncaughtException:', e && e.stack ? e.stack : e);
});

server.listen(CONFIG.port, CONFIG.bindAddr, () => {
  const backendLabel =
    BACKEND === 'onvif' ? 'ONVIF Profile G (default)' : 'netsdk/flv.cgi (legacy fallback)';
  console.error(
    `[recordings] backend listening on http://${CONFIG.bindAddr}:${CONFIG.port}  ` +
      `[RECORDINGS_BACKEND=${BACKEND}: ${backendLabel}]  ` +
      `-> recorder ${CONFIG.host} (user "${CONFIG.user}", password ${CONFIG.pass ? 'set' : 'EMPTY'})`
  );
  if (!CONFIG.pass) {
    const passVar = BACKEND === 'onvif' ? 'ONVIF_PASS' : 'DVR_PASS';
    console.error(
      `[recordings] WARNING: recorder password is empty. This is insecure. Set ${passVar} ` +
        'and change the recorder password. LAN use only.'
    );
  }
  console.error(`[recordings] ffmpeg: ${FFMPEG}`);
  console.error(`[recordings] UI: http://localhost:${CONFIG.port}/  (static: recordings/public/)`);
});

module.exports = { server, CONFIG, normalizeSearch, toDvrDateTime, dvrDateTimeToUnix, channelMask };
