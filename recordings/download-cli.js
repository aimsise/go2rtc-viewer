#!/usr/bin/env node
/*
 * download-cli.js - Search and download recordings from the security DVR
 *                   (Tsukamoto WTW OEM, model XVR) over HTTP.
 *
 * Node standard library only (http, child_process, fs, path, os). No npm deps.
 * ffmpeg is resolved at runtime via PATH (`command -v ffmpeg`) and is only
 * required when converting a downloaded stream to MP4.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *   node download-cli.js --list [--chn N] [--begin "YYYY-MM-DD HH:MM:SS"] \
 *                                [--end "YYYY-MM-DD HH:MM:SS"]
 *   node download-cli.js --chn N --begin "YYYY-MM-DD HH:MM:SS" \
 *                               --end "YYYY-MM-DD HH:MM:SS" \
 *                               [--out PATH] [--format mp4|flv]
 *
 *   --list                 List recordings via R.SearchRecord for the given
 *                          range (defaults to "today" when --begin/--end are
 *                          omitted). Does not download anything.
 *   --chn N                Channel number, 1-based (matches the DVR Web UI,
 *                          e.g. camera "ch1"). Internally converted to the
 *                          0-based index the DVR API/flv.cgi expect. Default 1.
 *   --begin "..."          Range start, full datetime "YYYY-MM-DD HH:MM:SS".
 *   --end   "..."          Range end,   full datetime "YYYY-MM-DD HH:MM:SS".
 *   --out PATH             Output file path. Default: ./<chN>_<begin>-<end>.<ext>
 *                          (written next to this script, under recordings/).
 *   --format mp4|flv       Output container. mp4 (default) runs the FLV stream
 *                          through ffmpeg (-c copy) into MP4; flv saves the raw
 *                          stream as-is (no ffmpeg needed).
 *   --host / --user / --pass   Override DVR connection (see env vars below).
 *   -h, --help             Show this help.
 *
 * ENVIRONMENT
 *   DVR_HOST   DVR host or host:port      (default 192.0.2.14)
 *   DVR_USER   DVR username               (default admin)
 *   DVR_PASS   DVR password               (default "" / empty)
 *
 * SECURITY
 *   The DVR ships with user "admin" and an EMPTY password, and this tool keeps
 *   that as the default so it works out of the box on the LAN. An empty
 *   password means anyone on the network can view your recordings. Set a real
 *   password on the DVR and pass it via DVR_PASS. Use on a trusted LAN only;
 *   never expose the DVR to the internet. See README.md.
 *
 * TIME FORMAT (important, determined against the real device)
 *   R.SearchRecord requires BeginTime/EndTime as FULL datetime strings
 *   "YYYY-MM-DD HH:MM:SS". Time-only values, Unix integers, or an empty
 *   Parameter all return "Search Failed!". Recording items carry TimeStart/
 *   TimeEnd as Unix seconds; flv.cgi's begin/end are those same Unix seconds.
 *   The DVR clock matches the host clock (no offset correction needed), so we
 *   build Unix timestamps from the local datetime strings directly.
 *
 * KNOWN FIRMWARE LIMITATION
 *   On the unit this was built for (WTW EG2 series, FW 3.2.2.6F), the netsdk
 *   search API answers "Search Success!" but always with ReadCnt 0 and no
 *   items, and /cgi-bin/flv.cgi returns HTTP 404 for every parameter set --
 *   even though a 2 TB disk is 100% full and the camera is actively recording.
 *   So this HTTP search/download path may legitimately return nothing on that
 *   firmware. When that happens the tool says so. There is no bundled recorder;
 *   if you need footage from such a unit, capture the camera's RTSP stream
 *   directly with ffmpeg (e.g. ffmpeg -i rtsp://<cam>/ch0_0.264 ...). This CLI
 *   is still the correct, spec-compliant client for any unit/firmware where the
 *   API does return items and flv.cgi serves a stream.
 */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load a sibling/repo-root .env (KEY=VALUE per line) with no npm dependency.
// Real environment variables always win; .env only fills the gaps.
(function loadDotEnv() {
  for (const envPath of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
    let txt;
    try { txt = fs.readFileSync(envPath, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
})();

// ---------------------------------------------------------------------------
// Defaults & configuration (overridable by env vars and flags).
// ---------------------------------------------------------------------------
const DEFAULTS = {
  host: process.env.DVR_HOST || '192.0.2.14',
  user: process.env.DVR_USER || 'admin',
  // Empty default password is intentional (factory default). See SECURITY.
  pass: process.env.DVR_PASS !== undefined ? process.env.DVR_PASS : '',
};

const DEV = 'XVR';
const VER = '1.0';
const MAX_CHN = 9;             // device channel count (0..8)
const RECORD_TYPES = ['Timing', 'Motion', 'Alarm', 'Manual'];
// Type bitmask -> human label, per the DVR Web UI decode logic.
const TYPE_BITS = [
  [1, 'Timing'],
  [2, 'Motion'],
  [4, 'Alarm'],
  [8, 'Manual'],
];

const SELF_DIR = __dirname; // recordings/ — outputs land here by default.

// ---------------------------------------------------------------------------
// Tiny argv parser (no deps). Supports "--key value" and "--flag".
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  const wantsValue = new Set([
    'chn', 'begin', 'end', 'out', 'format', 'host', 'user', 'pass',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '--list') {
      args.list = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (wantsValue.has(key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`Option --${key} requires a value.`);
        }
        args[key] = next;
        i++;
      } else {
        // Unknown boolean-ish flag; record it so we can warn.
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node download-cli.js --list [--chn N] [--begin "YYYY-MM-DD HH:MM:SS"] [--end "..."]',
    '  node download-cli.js --chn N --begin "YYYY-MM-DD HH:MM:SS" --end "YYYY-MM-DD HH:MM:SS"',
    '                              [--out PATH] [--format mp4|flv]',
    '',
    'Options:',
    '  --list              List recordings for the range (default: today). No download.',
    '  --chn N             Channel, 1-based like the DVR UI (default 1).',
    '  --begin "..."       Range start, full datetime "YYYY-MM-DD HH:MM:SS".',
    '  --end   "..."       Range end,   full datetime "YYYY-MM-DD HH:MM:SS".',
    '  --out PATH          Output file (default: ./chN_<begin>-<end>.<ext>).',
    '  --format mp4|flv    Container; mp4 (default, via ffmpeg -c copy) or raw flv.',
    '  --host/--user/--pass  Override DVR target (env: DVR_HOST/DVR_USER/DVR_PASS).',
    '  -h, --help          Show this help.',
    '',
    'Env: DVR_HOST (default 192.0.2.14)  DVR_USER (admin)  DVR_PASS (empty).',
    'Security: factory admin/empty-password is the default; set a real password',
    '          via DVR_PASS and use on a trusted LAN only. See README.md.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Host helpers.
// ---------------------------------------------------------------------------
function splitHostPort(host) {
  const idx = host.lastIndexOf(':');
  if (idx > -1 && /^\d+$/.test(host.slice(idx + 1))) {
    return { hostname: host.slice(0, idx), port: Number(host.slice(idx + 1)) };
  }
  return { hostname: host, port: 80 };
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Time helpers. The DVR uses local wall-clock time matching the host.
// ---------------------------------------------------------------------------
const DT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function validateDateTime(s, label) {
  if (typeof s !== 'string' || !DT_RE.test(s)) {
    throw new Error(
      `${label} must be a full datetime "YYYY-MM-DD HH:MM:SS" (got: ${JSON.stringify(s)}).`
    );
  }
  return s;
}

// Parse "YYYY-MM-DD HH:MM:SS" (DVR/host local time) to Unix seconds.
function dateTimeToUnix(s) {
  const m = DT_RE.exec(s);
  if (!m) throw new Error(`Invalid datetime: ${s}`);
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  // Date(year, monthIndex, ...) interprets args in the host's local zone,
  // which is what the DVR expects (clocks verified equal, no offset).
  return Math.floor(new Date(Y, Mo - 1, D, H, Mi, S).getTime() / 1000);
}

function unixToDateTime(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function todayRange() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { begin: `${day} 00:00:00`, end: `${day} 23:59:59` };
}

function typeLabels(bits) {
  const n = Number(bits);
  if (!Number.isFinite(n)) return String(bits);
  const out = [];
  for (const [bit, label] of TYPE_BITS) if (n & bit) out.push(label);
  return out.length ? out.join('+') : String(bits);
}

function humanDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// HTTP: POST JSON to a netsdk API and parse the JSON reply.
// ---------------------------------------------------------------------------
function postJson(cfg, apiPath, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const { hostname, port } = splitHostPort(cfg.host);
    const req = http.request(
      {
        hostname,
        port,
        method: 'POST',
        path: apiPath,
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'Content-Length': body.length,
          Authorization: basicAuthHeader(cfg.user, cfg.pass),
          Accept: 'application/json',
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 401) {
            return reject(
              new Error(
                'DVR rejected credentials (HTTP 401). Check DVR_USER/DVR_PASS ' +
                  '(factory default is user "admin" with an empty password).'
              )
            );
          }
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            return reject(
              new Error(
                `Non-JSON reply from ${apiPath} (HTTP ${res.statusCode}): ` +
                  text.slice(0, 200)
              )
            );
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Build the R.SearchRecord request body per the device's expectations.
//   - Channel: MAX_CHN-length array of "True"/"False" (which channels to
//     search). channelIndex0 is the 0-based channel to enable, or null = all.
//   - Type: name array (all four types by default).
//   - BeginTime/EndTime: full datetime strings (validated by caller).
//   - No "Reload" key (adding it makes the device fail the search).
// ---------------------------------------------------------------------------
function buildSearchBody(beginStr, endStr, channelIndex0) {
  const channel = new Array(MAX_CHN).fill('False');
  if (channelIndex0 === null || channelIndex0 === undefined) {
    channel.fill('True');
  } else {
    channel[channelIndex0] = 'True';
  }
  return {
    DEV,
    VER,
    API: 'R.SearchRecord',
    Parameter: {
      Channel: channel,
      Type: RECORD_TYPES.slice(),
      BeginTime: beginStr,
      EndTime: endStr,
      PageSize: '1000',
      CurrentPage: '1',
    },
  };
}

// Normalize a search reply into a flat list of record items.
function parseSearchItems(json) {
  const items = Array.isArray(json && json.Item) ? json.Item : [];
  return items
    .map((it) => {
      const ch0 = Number(it.Channel);
      const start = Number(it.TimeStart);
      const end = Number(it.TimeEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return {
        channel0: Number.isFinite(ch0) ? ch0 : null,
        channel1: Number.isFinite(ch0) ? ch0 + 1 : null, // UI-style 1-based
        start,
        end,
        duration: Math.max(0, end - start),
        type: it.Type,
        raw: it,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Search command (--list).
// ---------------------------------------------------------------------------
async function runSearch(cfg, opts) {
  const channelIndex0 = opts.chn1 === null ? null : opts.chn1 - 1;
  const body = buildSearchBody(opts.begin, opts.end, channelIndex0);

  const target = channelIndex0 === null ? 'all channels' : `ch${opts.chn1}`;
  process.stderr.write(
    `Searching ${cfg.host} (${target}) ${opts.begin} .. ${opts.end} ...\n`
  );

  const { json } = await postJson(cfg, '/netsdk/R.SearchRecord', body);
  const detail = (json && json.RetDetail) || '';
  const code = (json && json.RetCode) || '';

  if (code !== '0' && !/success/i.test(detail)) {
    throw new Error(
      `DVR search failed (RetCode ${code}): ${detail || JSON.stringify(json)}`
    );
  }

  const items = parseSearchItems(json);
  const readCnt = json && json.ReadCnt;

  if (items.length === 0) {
    process.stdout.write(
      `No recordings returned (RetDetail: "${detail}", ReadCnt: ${
        readCnt === undefined ? 'n/a' : readCnt
      }).\n`
    );
    process.stdout.write(
      'Note: on some firmware (e.g. WTW EG2 FW 3.2.2.6F) the DVR reports\n' +
        '"Search Success!" with zero items even while actively recording, and\n' +
        '/cgi-bin/flv.cgi returns 404 -- the recording index is simply not\n' +
        'reachable over this HTTP API. If that is your unit, capture the camera\n' +
        'RTSP stream directly with ffmpeg instead (no recorder is bundled).\n'
    );
    return;
  }

  process.stdout.write(
    `Found ${items.length} recording(s)` +
      (readCnt !== undefined ? ` (ReadCnt ${readCnt})` : '') +
      ':\n\n'
  );
  process.stdout.write(
    'CH  BEGIN                END                  DUR       TYPE\n'
  );
  process.stdout.write(
    '--  -------------------  -------------------  --------  ----------\n'
  );
  for (const it of items) {
    const ch = it.channel1 === null ? '?' : String(it.channel1);
    process.stdout.write(
      `${ch.padEnd(2)}  ${unixToDateTime(it.start)}  ${unixToDateTime(
        it.end
      )}  ${humanDuration(it.duration).padEnd(8)}  ${typeLabels(it.type)}\n`
    );
  }
  process.stdout.write(
    '\nDownload one with:\n' +
      `  node download-cli.js --chn <CH> --begin "<BEGIN>" --end "<END>"\n`
  );
}

// ---------------------------------------------------------------------------
// flv.cgi URL + a HEAD-ish probe so we fail fast with a clear message on the
// firmware where flv.cgi is 404.
// ---------------------------------------------------------------------------
function buildFlvPath(cfg, channelIndex0, beginUnix, endUnix) {
  const q = new URLSearchParams({
    u: cfg.user,
    p: cfg.pass,
    mode: 'time',
    chn: String(channelIndex0),
    begin: String(beginUnix),
    end: String(endUnix),
    audio: '54',
    mute: 'false',
    rnd: String(Math.floor(Math.random() * 1e9)),
  });
  return `/cgi-bin/flv.cgi?${q.toString()}`;
}

// Open the FLV stream. Resolves with the live IncomingMessage on HTTP 200 so
// the caller can pipe it; rejects with a helpful error otherwise.
function openFlvStream(cfg, flvPath) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = splitHostPort(cfg.host);
    const req = http.request(
      {
        hostname,
        port,
        method: 'GET',
        path: flvPath,
        headers: { Authorization: basicAuthHeader(cfg.user, cfg.pass) },
        timeout: 20000,
      },
      (res) => {
        if (res.statusCode === 200) {
          resolve(res);
          return;
        }
        // Drain and reject with context.
        res.resume();
        if (res.statusCode === 404) {
          reject(
            new Error(
              'flv.cgi returned HTTP 404. On this DVR firmware the FLV\n' +
                'playback/download CGI is not implemented (it is a Flash-era\n' +
                'endpoint absent from the current build), so direct HTTP\n' +
                'download is not possible. Capture the camera RTSP stream\n' +
                'directly with ffmpeg instead (no recorder is bundled).'
            )
          );
        } else if (res.statusCode === 401) {
          reject(
            new Error(
              'flv.cgi returned HTTP 401 (auth). Check DVR_USER/DVR_PASS.'
            )
          );
        } else {
          reject(new Error(`flv.cgi returned HTTP ${res.statusCode}.`));
        }
      }
    );
    req.on('timeout', () => req.destroy(new Error('flv.cgi request timed out.')));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ffmpeg discovery (PATH only; no hard-coded absolute path).
// Walks $PATH like `command -v ffmpeg` would, without invoking a shell.
// ---------------------------------------------------------------------------
function findFfmpeg() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'ffmpeg');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      /* not here; keep looking */
    }
  }
  return null;
}

function defaultOutPath(chn1, beginStr, endStr, ext) {
  const safe = (s) => s.replace(/[: ]/g, '-');
  const name = `ch${chn1}_${safe(beginStr)}_to_${safe(endStr)}.${ext}`;
  return path.join(SELF_DIR, name);
}

// Render a one-line progress indicator to stderr.
function progress(bytes, startMs) {
  const secs = (Date.now() - startMs) / 1000 || 1;
  const rate = bytes / secs;
  process.stderr.write(
    `\r  downloaded ${humanBytes(bytes)} (${humanBytes(rate)}/s)   `
  );
}

// ---------------------------------------------------------------------------
// Download command.
// ---------------------------------------------------------------------------
async function runDownload(cfg, opts) {
  if (opts.chn1 === null) {
    throw new Error('Download requires --chn N (1-based channel).');
  }
  const channelIndex0 = opts.chn1 - 1;
  const beginUnix = dateTimeToUnix(opts.begin);
  const endUnix = dateTimeToUnix(opts.end);
  if (endUnix <= beginUnix) {
    throw new Error('--end must be later than --begin.');
  }

  const ext = opts.format;
  const outPath =
    opts.out || defaultOutPath(opts.chn1, opts.begin, opts.end, ext);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const flvPath = buildFlvPath(cfg, channelIndex0, beginUnix, endUnix);
  process.stderr.write(
    `Requesting ch${opts.chn1} ${opts.begin} .. ${opts.end} from ${cfg.host}\n` +
      `  GET /cgi-bin/flv.cgi (chn=${channelIndex0}, begin=${beginUnix}, end=${endUnix})\n`
  );

  // ffmpeg is only needed for MP4 output; check before we open the stream.
  let ffmpegBin = null;
  if (ext === 'mp4') {
    ffmpegBin = findFfmpeg();
    if (!ffmpegBin) {
      throw new Error(
        'ffmpeg not found on PATH (needed for --format mp4). Install ffmpeg, ' +
          'or use --format flv to save the raw stream without conversion.'
      );
    }
  }

  const flv = await openFlvStream(cfg, flvPath);
  const startMs = Date.now();
  let bytes = 0;

  if (ext === 'flv') {
    // Save the raw FLV stream directly.
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      flv.on('data', (c) => {
        bytes += c.length;
        progress(bytes, startMs);
      });
      flv.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      flv.pipe(ws);
    });
  } else {
    // Pipe FLV into ffmpeg and remux to MP4 (-c copy: no re-encode).
    await new Promise((resolve, reject) => {
      const ff = spawn(
        ffmpegBin,
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-f', 'flv',
          '-i', 'pipe:0',
          '-c', 'copy',
          '-movflags', '+faststart',
          '-y',
          outPath,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] }
      );
      let ffErr = '';
      ff.stderr.on('data', (c) => (ffErr += c.toString()));
      ff.on('error', reject);
      ff.on('close', (codeNum) => {
        if (codeNum === 0) resolve();
        else reject(new Error(`ffmpeg exited ${codeNum}: ${ffErr.trim()}`));
      });

      flv.on('data', (c) => {
        bytes += c.length;
        progress(bytes, startMs);
      });
      flv.on('error', (e) => {
        ff.kill('SIGKILL');
        reject(e);
      });
      // If ffmpeg's stdin closes early, don't crash with EPIPE.
      ff.stdin.on('error', () => {});
      flv.pipe(ff.stdin);
    });
  }

  process.stderr.write('\n');
  let size = bytes;
  try {
    size = fs.statSync(outPath).size;
  } catch (_) {
    /* keep streamed byte count */
  }
  process.stdout.write(`Saved ${outPath} (${humanBytes(size)}).\n`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n\n${usage()}\n`);
    process.exit(2);
  }

  if (args.help || (process.argv.length <= 2)) {
    process.stdout.write(usage() + '\n');
    return;
  }

  const cfg = {
    host: args.host || DEFAULTS.host,
    user: args.user || DEFAULTS.user,
    pass: args.pass !== undefined ? args.pass : DEFAULTS.pass,
  };

  // Channel: 1-based on the CLI; null means "all" (only valid for --list).
  let chn1 = null;
  if (args.chn !== undefined) {
    chn1 = Number(args.chn);
    if (!Number.isInteger(chn1) || chn1 < 1 || chn1 > MAX_CHN) {
      process.stderr.write(
        `Error: --chn must be an integer 1..${MAX_CHN} (1-based, UI-style).\n`
      );
      process.exit(2);
    }
  }

  const format = (args.format || 'mp4').toLowerCase();
  if (format !== 'mp4' && format !== 'flv') {
    process.stderr.write(`Error: --format must be "mp4" or "flv".\n`);
    process.exit(2);
  }

  try {
    if (args.list) {
      const range =
        args.begin || args.end ? null : todayRange();
      const begin = validateDateTime(
        args.begin || (range && range.begin),
        '--begin'
      );
      const end = validateDateTime(args.end || (range && range.end), '--end');
      await runSearch(cfg, { chn1, begin, end });
    } else {
      const begin = validateDateTime(args.begin, '--begin');
      const end = validateDateTime(args.end, '--end');
      await runDownload(cfg, { chn1, begin, end, out: args.out, format });
    }
  } catch (e) {
    process.stderr.write(`\nError: ${e.message}\n`);
    process.exit(1);
  }
}

main();
