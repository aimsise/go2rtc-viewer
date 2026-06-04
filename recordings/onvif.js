'use strict';

/*
 * recordings/onvif.js
 *
 * Dependency-free ONVIF Profile G client (Device Management + Recording Search
 * + Replay Control) for the recordings backend. server.js requires this module
 * when RECORDINGS_BACKEND=onvif (the default) and drives it through a small
 * async surface: probe(), listChannels(), search(), replayUriForClip().
 *
 * It is the vendor-neutral replacement for the legacy WTW/Tsukamoto netsdk +
 * flv.cgi path (which remains in server.js behind RECORDINGS_BACKEND=netsdk).
 * Everything here is standard-library only -- node:http / node:https for SOAP,
 * node:crypto for WS-Security PasswordDigest + HTTP-Digest, node:url for XAddr
 * parsing. SOAP 1.2 envelopes are hand-rolled templated strings and responses
 * are parsed with prefix-tolerant regex extraction, in the same minimal-parsing
 * spirit as server.js's JSON-by-string normalizeSearch().
 *
 * Design notes / honest caveats (see .docs/onvif-implementation-spec.md):
 *   - This client speaks the documented Profile G protocol but has NOT been
 *     verified against real Profile G hardware: the only on-hand unit 404s on
 *     /onvif/* and does not answer WS-Discovery unicast Probe. It is written to
 *     the spec so it works against a conforming NVR/DVR, and degrades to clear
 *     errors (never a hang) when the device refuses.
 *   - ONVIF xs:dateTime is UTC ('...Z'). We measure clock skew via the one
 *     UNAUTHENTICATED call (GetSystemDateAndTime) and apply it to BOTH the
 *     WS-Security Created header AND every search/replay time window. We never
 *     reuse the legacy local-time toDvrDateTime() formatting.
 *   - The frontend keeps speaking 0-based chn + begin/end Unix seconds. ONVIF
 *     identifies streams by opaque RecordingToken, so we build a STABLE 0-based
 *     index over the RecordingTokens (ordered by Source name then earliest
 *     recording) and translate chn <-> token server-side.
 *   - Auth ladder: WS-Security UsernameToken/PasswordDigest -> HTTP Digest ->
 *     HTTP Basic, retrying on 401. The winning scheme is remembered and is
 *     surfaced via probe() (drives /api/health).
 *   - We distinguish "parsed 0 records" from "unrecognized/garbled response":
 *     if a response has no recognizable record blocks AND no SOAP Fault, the
 *     parser returns an explicit diagnostic (with a sliced raw-body sample),
 *     never a silent phantom-empty list.
 *
 * No home-directory absolute paths or PII are written into this file: host /
 * user / pass come from the environment, the nonce and digest are computed at
 * runtime, and defaults stay loopback / RFC5737 placeholders.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

// ---------------------------------------------------------------------------
// Configuration (read once at module load). ONVIF_* wins, then DVR_* as a
// backward-compatible fallback so existing .env files keep working. The
// DVR_PASS='' (empty-allowed) semantics are preserved via the ?? chain.
// ---------------------------------------------------------------------------
const CONFIG = (function buildConfig() {
  // Preserve the intentional empty-string-allowed password semantics:
  // ONVIF_PASS ?? DVR_PASS ?? '' (so an explicitly empty value is respected).
  let pass = '';
  if (process.env.ONVIF_PASS !== undefined) pass = process.env.ONVIF_PASS;
  else if (process.env.DVR_PASS !== undefined) pass = process.env.DVR_PASS;

  const honorRaw = process.env.ONVIF_HONOR_XADDR;
  const honorAdvertisedXAddr =
    honorRaw !== undefined && /^(1|true|yes|on)$/i.test(String(honorRaw).trim());

  return {
    // Host may be a bare host ("192.0.2.14") or include a port
    // ("192.0.2.14:8080"). RFC5737 placeholder default; the real value comes
    // from the gitignored .env.
    host: process.env.ONVIF_HOST || process.env.DVR_HOST || '192.0.2.14',
    user: process.env.ONVIF_USER || process.env.DVR_USER || 'admin',
    pass,
    // Device service entry path; the one well-known fixed ONVIF endpoint.
    devicePath: process.env.ONVIF_DEVICE_PATH || '/onvif/device_service',
    // Explicit ONVIF port override; else taken from host:port or defaulted (80).
    port: process.env.ONVIF_PORT ? parseInt(process.env.ONVIF_PORT, 10) : null,
    // SOAP request timeout (ms) -> 504 on miss.
    apiTimeoutMs: parseInt(
      process.env.ONVIF_API_TIMEOUT_MS || process.env.DVR_API_TIMEOUT_MS || '15000',
      10
    ),
    // false (default): rewrite advertised GetServices XAddr paths onto the
    // configured host:port (the device often advertises its own/NAT-wrong
    // host). true: POST to the advertised host as-is.
    honorAdvertisedXAddr,
  };
})();

// ONVIF / SOAP / WS-Security namespace URIs (kept as named constants so the
// envelope templates and discovery matching stay readable).
const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl', // Device Management
  tse: 'http://www.onvif.org/ver10/search/wsdl', // Recording Search
  trp: 'http://www.onvif.org/ver10/replay/wsdl', // Replay Control
  trc: 'http://www.onvif.org/ver10/recording/wsdl', // Recording Control (alt listing)
  tt: 'http://www.onvif.org/ver10/schema', // ONVIF common schema
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  pwDigest:
    'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest',
  b64Binary:
    'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary',
};

// SOAPAction URNs per operation. Sent as the action= parameter of the
// application/soap+xml Content-Type (SOAP 1.2 style).
const ACTION = {
  GetSystemDateAndTime: `${NS.tds}/GetSystemDateAndTime`,
  GetServices: `${NS.tds}/GetServices`,
  GetCapabilities: `${NS.tds}/GetCapabilities`,
  FindRecordings: `${NS.tse}/FindRecordings`,
  GetRecordingSearchResults: `${NS.tse}/GetRecordingSearchResults`,
  GetRecordingSummary: `${NS.tse}/GetRecordingSummary`,
  GetRecordings: `${NS.trc}/GetRecordings`,
  GetReplayUri: `${NS.trp}/GetReplayUri`,
};

// Module-level mutable state: measured clock skew, the winning auth scheme,
// discovered service endpoints, and the cached channel map.
const STATE = {
  // deviceUTC - localNow, in milliseconds. Applied to Created + windows.
  timeSkewMs: 0,
  skewMeasured: false,
  // True once the device actually answered GetSystemDateAndTime (the canonical,
  // unauthenticated reachability ping). NOT the same as skewMeasured, which is
  // set even when the ping fails (so callers do not retry it forever).
  deviceResponded: false,
  // 'ws' | 'digest' | 'basic' | null. Remembered after the first success.
  authScheme: null,
  // Discovered (and host-rewritten) service URLs.
  services: { device: null, search: null, replay: null, recording: null },
  servicesDiscovered: false,
  // Channel map cache (short TTL): { builtAt, channels:[...], byChn:Map, byToken:Map }.
  channelCache: null,
};

// How long to trust the channel map before re-enumerating (ms).
const CHANNEL_CACHE_TTL_MS = 30000;

// ---------------------------------------------------------------------------
// Error helper (mirrors server.js httpError: an Error carrying a statusCode
// and optional upstream body so sendError() can surface a typed status).
// ---------------------------------------------------------------------------
function onvifError(status, message, extra) {
  const e = new Error(message);
  e.statusCode = status;
  if (extra) Object.assign(e, extra);
  return e;
}

// ---------------------------------------------------------------------------
// XML escaping / unescaping. Every dynamic value interpolated into a SOAP
// template is escaped (5-entity); every value extracted from a response is
// unescaped.
// ---------------------------------------------------------------------------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Ampersand last so we don't double-decode entities above.
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Time helpers. ONVIF is UTC end-to-end.
//   - SOAP xs:dateTime: "YYYY-MM-DDThh:mm:ssZ" (fractional seconds allowed).
//   - RTSP Range: clock= / vendor query params: compact basic "YYYYMMDDThhmmssZ".
// ---------------------------------------------------------------------------

/** Unix seconds -> ONVIF xs:dateTime UTC string with 'Z' (no fractional). */
function unixToIsoZ(unixSec) {
  // toISOString() always emits UTC '...Z'; strip the fractional milliseconds
  // so we send the plain "...ssZ" form devices expect.
  return new Date(Math.round(Number(unixSec) * 1000)).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** ONVIF xs:dateTime (UTC 'Z', fractional allowed) -> Unix seconds, or null. */
function isoToUnix(iso) {
  const s = String(iso || '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000);
}

/**
 * ISO xs:dateTime -> compact ISO8601 basic form "YYYYMMDDThhmmssZ" used by the
 * RTSP Range: clock= header and by the vendor starttime=/endtime= query params.
 * Drops the '-'/':' separators and any fractional seconds.
 */
function isoToRtspClock(iso) {
  return String(iso)
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
}

/** Current Created timestamp for WS-Security, corrected by the measured skew. */
function nowCreatedIso() {
  return unixToIsoZ((Date.now() + STATE.timeSkewMs) / 1000);
}

// ---------------------------------------------------------------------------
// Host / XAddr helpers. The recordings backend already splits host[:port] for
// the legacy path; we keep the same shape here (renamed splitHostPort, shared
// concept) so XAddr rewriting reuses the operator-configured target.
// ---------------------------------------------------------------------------

/**
 * Split a "host" or "host:port" string into { hostname, port }. Default port
 * is the supplied fallback (80 for http). Bracketed IPv6 ("[::1]:80") is
 * handled so the colon inside the address is not mistaken for the port sep.
 */
function splitHostPort(host, defaultPort) {
  const h = String(host);
  const dft = defaultPort === undefined ? 80 : defaultPort;
  // IPv6 in brackets, optionally with a port.
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(h);
  if (v6) {
    return { hostname: v6[1], port: v6[2] ? Number(v6[2]) : dft };
  }
  const idx = h.lastIndexOf(':');
  if (idx > -1 && /^\d+$/.test(h.slice(idx + 1)) && h.indexOf(':') === idx) {
    return { hostname: h.slice(0, idx), port: Number(h.slice(idx + 1)) };
  }
  return { hostname: h, port: dft };
}

/** The operator-configured target { hostname, port }, honoring ONVIF_PORT. */
function configuredTarget() {
  const t = splitHostPort(CONFIG.host, 80);
  if (CONFIG.port) t.port = CONFIG.port;
  return t;
}

/**
 * Build the absolute device service URL from CONFIG (host + devicePath). This
 * is the one fixed entry point; all other services are discovered.
 */
function deviceServiceUrl() {
  const t = configuredTarget();
  const hostPart = t.hostname.includes(':') ? `[${t.hostname}]` : t.hostname;
  return `http://${hostPart}:${t.port}${CONFIG.devicePath}`;
}

/**
 * Rewrite an advertised XAddr onto the configured host:port unless
 * ONVIF_HONOR_XADDR is set. Devices frequently advertise their own internal /
 * NAT-wrong host in GetServices/GetCapabilities, so by default we keep only
 * the advertised pathname+search and rebuild against the operator's target.
 * Returns the (possibly rewritten) absolute URL string, or null on parse fail.
 */
function xaddrToTarget(xaddr) {
  let u;
  try {
    u = new URL(String(xaddr).trim());
  } catch (_) {
    return null;
  }
  if (CONFIG.honorAdvertisedXAddr) {
    return u.toString();
  }
  const t = configuredTarget();
  const hostPart = t.hostname.includes(':') ? `[${t.hostname}]` : t.hostname;
  // Keep the device's scheme only when it is https (a TLS-only XAddr); otherwise
  // talk plain http on the configured target.
  const scheme = u.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${hostPart}:${t.port}${u.pathname}${u.search}`;
}

// ---------------------------------------------------------------------------
// WS-Security UsernameToken / PasswordDigest.
//
//   PasswordDigest = Base64( SHA1( nonceBytes ++ Created_utf8 ++ Password_utf8 ) )
//
// where '++' is raw byte concatenation. The <Nonce> element carries the
// base64 of the SAME raw nonce bytes.
// ---------------------------------------------------------------------------

/**
 * Compute the WS-Security PasswordDigest. `nonce` may be a Buffer of raw bytes
 * or a base64 string (it is base64-decoded to raw bytes before hashing, per
 * the OASIS UsernameToken profile). Exported for the unit-test vector.
 */
function computePasswordDigest(nonce, createdIso, password) {
  const nonceBytes = Buffer.isBuffer(nonce) ? nonce : Buffer.from(String(nonce), 'base64');
  return crypto
    .createHash('sha1')
    .update(
      Buffer.concat([
        nonceBytes,
        Buffer.from(String(createdIso), 'utf8'),
        Buffer.from(String(password), 'utf8'),
      ])
    )
    .digest('base64');
}

/**
 * Build the full <Security> SOAP header block (string) for the given user /
 * pass. `createdIso` and `nonceB64` may be supplied for deterministic tests;
 * otherwise a fresh 16-byte nonce and a skew-corrected Created are generated.
 * Exported for the envelope-render test.
 */
function wsSecurityHeader(user, pass, createdIso, nonceB64) {
  const created = createdIso || nowCreatedIso();
  const nonce = nonceB64 || crypto.randomBytes(16).toString('base64');
  const digest = computePasswordDigest(nonce, created, pass);
  return (
    `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${xmlEscape(user)}</wsse:Username>` +
    `<wsse:Password Type="${NS.pwDigest}">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${NS.b64Binary}">${nonce}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created>` +
    `</wsse:UsernameToken>` +
    `</wsse:Security>`
  );
}

// ---------------------------------------------------------------------------
// SOAP 1.2 envelope.
// ---------------------------------------------------------------------------

/**
 * Wrap a body fragment in a SOAP 1.2 envelope. When `securityHeader` is a
 * non-empty string it is placed inside <s:Header>; otherwise an empty header
 * is emitted. Exported (also aliased as buildSoapEnvelope) for render tests.
 */
function soapEnvelope(bodyXml, securityHeader) {
  const header = securityHeader ? `<s:Header>${securityHeader}</s:Header>` : '<s:Header/>';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS.soap}">` +
    header +
    `<s:Body>${bodyXml}</s:Body>` +
    `</s:Envelope>`
  );
}

// ---------------------------------------------------------------------------
// Generic prefix-tolerant response extractors. All matchers tolerate an
// optional namespace prefix, handle self-closing tags, and unescape entities
// -- exactly the robustness the spec demands so a namespace variation never
// silently yields a phantom-empty result.
//
// PFX matches an OPTIONAL XML namespace prefix ("ns:"). It must accept the full
// XML NCName charset -- letters, digits, '_', '.', and '-' -- NOT just \w,
// because the single most common ONVIF stack (gSOAP, used by Hikvision / Dahua
// / many embedded NVRs) emits the "SOAP-ENV:" prefix whose hyphen \w does not
// match. A \w-only prefix silently fails to detect SOAP-ENV faults/elements.
// ---------------------------------------------------------------------------
const PFX = '(?:[A-Za-z_][A-Za-z0-9_.-]*:)?';

/**
 * Extract the text content of the FIRST <tag>...</tag> (any/no prefix) found in
 * `chunk`. Returns the xmlUnescape()d text, or null if absent. A self-closing
 * <tag/> yields '' (present-but-empty), distinct from null (absent).
 */
function scalar(tag, chunk) {
  if (chunk == null) return null;
  const body = String(chunk);
  const open = `<${PFX}${tag}(?:\\s[^>]*)?>`;
  const close = `<\\/${PFX}${tag}\\s*>`;
  const re = new RegExp(`${open}([\\s\\S]*?)${close}`);
  const m = re.exec(body);
  if (m) return xmlUnescape(m[1]);
  // Self-closing form: <tag/> or <tag attr="..."/>.
  const selfRe = new RegExp(`<${PFX}${tag}(?:\\s[^>]*)?/>`);
  if (selfRe.test(body)) return '';
  return null;
}

/**
 * Read an attribute value off the FIRST <tag ...> open tag (any/no prefix).
 * Returns the xmlUnescape()d value or null. Used for elements that carry data
 * in attributes rather than text.
 */
function attr(tag, attrName, chunk) {
  if (chunk == null) return null;
  const re = new RegExp(`<${PFX}${tag}\\b([^>]*)>`);
  const m = re.exec(String(chunk));
  if (!m) return null;
  const am = new RegExp(`\\b${attrName}\\s*=\\s*"([^"]*)"`).exec(m[1]);
  return am ? xmlUnescape(am[1]) : null;
}

/**
 * Split `body` into an array of per-<tag> chunks (the full element text of each
 * occurrence, any/no prefix). Self-closing occurrences are included as their
 * own (attribute-only) chunk. Returns [] when none are found.
 */
function blocks(tag, body) {
  if (body == null) return [];
  const text = String(body);
  const out = [];
  // Match either a self-closing <tag .../> or a paired <tag ...>...</tag>.
  const re = new RegExp(
    `<${PFX}${tag}(?:\\s[^>]*)?/>|<${PFX}${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${PFX}${tag}\\s*>`,
    'g'
  );
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
    // Guard against a zero-length match looping forever (defensive).
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SOAP <Fault> detection + mapping. A parsable Fault on HTTP 500 is NOT a
// transport error -- it is surfaced as a typed onvifError with the human
// Reason text.
// ---------------------------------------------------------------------------

/**
 * Scan a SOAP body for a <Fault> and, if present, return an Error mapping the
 * fault subcode to an HTTP-ish status. Returns null when there is no fault.
 * Exported for the Fault->typed-error test.
 */
function parseFault(body) {
  const text = String(body || '');
  if (!/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Fault[\s/>]/.test(text)) return null;

  // SOAP 1.2 Reason/Text, or SOAP 1.1 faultstring.
  let reason =
    scalar('Text', text) ||
    scalar('faultstring', text) ||
    scalar('Reason', text) ||
    '';
  reason = String(reason).trim();

  // Subcode chain: <Subcode><Value>ter:NotAuthorized</Value>...</Subcode>.
  // Grab the LAST (most specific) Value under any Subcode/Code element.
  let subcode = '';
  const valRe = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Value(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Value\s*>/g;
  let vm;
  while ((vm = valRe.exec(text)) !== null) {
    const v = xmlUnescape(vm[1]).trim();
    if (v) subcode = v;
  }

  const subLower = subcode.toLowerCase();
  let status = 502; // default: upstream/protocol fault
  if (/notauthorized|notauthenticated|unauthorized/.test(subLower)) {
    status = 401;
  } else if (/invalidargval|invalidargs|outofrange|noconfig|notfound/.test(subLower)) {
    status = 400;
  } else if (/actionnotsupported|optionalfeature|notsupported|notimplemented/.test(subLower)) {
    status = 501;
  } else if (/sender/.test(subLower)) {
    // Generic Sender fault without a more specific subcode.
    status = 400;
  }

  const human = reason || subcode || 'SOAP Fault';
  const err = onvifError(status, `ONVIF fault: ${human}${subcode ? ` (${subcode})` : ''}`, {
    fault: true,
    faultReason: reason,
    faultSubcode: subcode,
  });
  return err;
}

// ---------------------------------------------------------------------------
// HTTP Digest (RFC 2617) computation for the auth ladder, via node:crypto MD5.
// ---------------------------------------------------------------------------

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

/** Parse a "WWW-Authenticate: Digest ..." header into a params object. */
function parseDigestChallenge(headerValue) {
  const out = {};
  const body = String(headerValue || '').replace(/^Digest\s+/i, '');
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] || '').trim();
  }
  return out;
}

/**
 * Build an "Authorization: Digest ..." header value for a POST to `uri`.
 * Supports qop=auth (with cnonce + nc) and the legacy no-qop form.
 */
function buildDigestAuth(challenge, user, pass, method, uri) {
  // RFC 7616 quoted-string escaping for values we emit inside quotes.
  const q = (s) => String(s).replace(/(["\\])/g, '\\$1');
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  // Prefer plain "auth" when the server offers a list (e.g. "auth-int,auth"):
  // we only implement the auth variant (HA2 = md5(method:uri)), not auth-int
  // (which hashes the entity body). If only auth-int is offered we drop to the
  // legacy no-qop form as a best effort.
  const qops = (challenge.qop || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const usable = qops.filter((x) => x !== 'auth-int');
  const qop = usable.includes('auth') ? 'auth' : usable[0] || '';
  const opaque = challenge.opaque;
  // We always compute a plain-MD5 HA1, so always advertise "MD5" -- never echo a
  // "MD5-sess" the challenge offered (that needs a session HA1 we do not build;
  // sending algorithm=MD5-sess with a plain HA1 would guarantee an auth failure).
  const algorithm = 'MD5';
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  let response;
  const parts = [
    `username="${q(user)}"`,
    `realm="${q(realm)}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) {
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`, `response="${response}"`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
    parts.push(`response="${response}"`);
  }
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Low-level SOAP transport. POSTs a SOAP 1.2 envelope and resolves the raw
// response { statusCode, headers, body }. Mirrors server.js dvrApi's timeout /
// error handling (timeout -> 504, transport error -> 502).
// ---------------------------------------------------------------------------

function httpPost(serviceUrl, action, envelope, extraHeaders) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(serviceUrl);
    } catch (_) {
      return reject(onvifError(500, `Invalid ONVIF service URL: ${serviceUrl}`));
    }
    const isHttps = u.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = Buffer.from(envelope, 'utf8');
    const headers = Object.assign(
      {
        // SOAP 1.2 content type carries the action as a parameter.
        'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`,
        'Content-Length': payload.length,
        Accept: 'application/soap+xml, application/xml, text/xml, */*',
      },
      extraHeaders || {}
    );
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers,
    };
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', (e) =>
      reject(onvifError(502, `Cannot reach ONVIF device at ${u.host}: ${e.code || e.message}`))
    );
    req.setTimeout(CONFIG.apiTimeoutMs, () => {
      req.destroy(onvifError(504, `ONVIF request timed out after ${CONFIG.apiTimeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * High-level SOAP call with the auth ladder. `auth` controls the credential
 * mode for THIS call:
 *   - 'none'  : no auth (used for the unauthenticated GetSystemDateAndTime).
 *   - 'auto'  : try the remembered scheme, else WS -> Digest -> Basic on 401.
 * Returns the response body string on a 2xx (or a Fault-bearing 500); throws a
 * typed onvifError on transport error, hard 401 after the ladder, or a Fault.
 */
async function soapCall(serviceUrl, action, bodyXml, auth) {
  const mode = auth || 'auto';

  // Helper that performs one POST with a given auth strategy and returns the
  // raw HTTP result (no Fault interpretation yet).
  const post = (strategy, challenge) => {
    let securityHeader = '';
    const extraHeaders = {};
    if (strategy === 'ws' || strategy === 'ws+digest') {
      securityHeader = wsSecurityHeader(CONFIG.user, CONFIG.pass);
    }
    if (strategy === 'digest' || strategy === 'ws+digest') {
      let u;
      try {
        u = new URL(serviceUrl);
      } catch (_) {
        u = { pathname: '/', search: '' };
      }
      extraHeaders.Authorization = buildDigestAuth(
        challenge || {},
        CONFIG.user,
        CONFIG.pass,
        'POST',
        u.pathname + (u.search || '')
      );
    }
    if (strategy === 'basic') {
      extraHeaders.Authorization = basicAuthHeader(CONFIG.user, CONFIG.pass);
    }
    const envelope = soapEnvelope(bodyXml, securityHeader);
    return httpPost(serviceUrl, action, envelope, extraHeaders);
  };

  // Interpret a raw HTTP result: surface Faults, map non-2xx, return body on OK.
  const interpret = (res) => {
    // A parsable SOAP Fault is an application error, not a transport failure --
    // even on HTTP 500. Surface it as a typed error (NotAuthorized -> 401).
    const fault = parseFault(res.body);
    if (fault) throw fault;
    if (res.statusCode >= 200 && res.statusCode < 300) return res.body;
    if (res.statusCode === 401) {
      throw onvifError(401, 'ONVIF device rejected credentials (401).', { is401: true });
    }
    throw onvifError(502, `ONVIF ${action} returned HTTP ${res.statusCode}`, {
      body: res.body,
    });
  };

  if (mode === 'none') {
    const res = await post('none');
    return interpret(res);
  }

  // Ordered ladder. Start with the remembered scheme if we have one.
  const ladder = [];
  if (STATE.authScheme === 'digest') ladder.push('digest', 'ws+digest', 'basic');
  else if (STATE.authScheme === 'basic') ladder.push('basic', 'ws', 'digest');
  else ladder.push('ws', 'digest', 'basic'); // default / 'ws' remembered

  let lastErr = null;
  let challenge = null;
  for (let i = 0; i < ladder.length; i++) {
    const strategy = ladder[i];
    // The digest strategy needs a fresh challenge from a prior 401; if we do
    // not have one yet, do a probing POST (WS) to elicit WWW-Authenticate.
    if ((strategy === 'digest' || strategy === 'ws+digest') && !challenge) {
      const res = await post('ws');
      const fault = parseFault(res.body);
      if (fault) throw fault; // a Fault answer means WS reached the app layer
      if (res.statusCode !== 401) {
        // WS actually worked (or a non-auth error) -- interpret it directly.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          STATE.authScheme = 'ws';
          return res.body;
        }
        // Non-2xx, non-401, non-fault: record and continue the ladder.
        lastErr = onvifError(502, `ONVIF ${action} returned HTTP ${res.statusCode}`, {
          body: res.body,
        });
        continue;
      }
      const wwwAuth = res.headers['www-authenticate'] || '';
      if (/digest/i.test(wwwAuth)) challenge = parseDigestChallenge(wwwAuth);
      else if (/basic/i.test(wwwAuth)) {
        // Device wants Basic, not Digest -- jump straight to it.
        const bres = await post('basic');
        try {
          const out = interpret(bres);
          STATE.authScheme = 'basic';
          return out;
        } catch (e) {
          lastErr = e;
          continue;
        }
      } else {
        lastErr = onvifError(401, 'ONVIF device rejected WS-Security (401).', { is401: true });
        continue;
      }
    }

    let res;
    try {
      res = await post(strategy, challenge);
    } catch (e) {
      lastErr = e;
      continue;
    }
    const fault = parseFault(res.body);
    if (fault) throw fault;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      STATE.authScheme = strategy === 'ws+digest' ? 'digest' : strategy;
      return res.body;
    }
    if (res.statusCode === 401) {
      // Refresh the digest challenge for the next attempt if offered.
      const wwwAuth = res.headers['www-authenticate'] || '';
      if (/digest/i.test(wwwAuth)) challenge = parseDigestChallenge(wwwAuth);
      lastErr = onvifError(401, `ONVIF device rejected ${strategy} auth (401).`, { is401: true });
      continue;
    }
    lastErr = onvifError(502, `ONVIF ${action} returned HTTP ${res.statusCode}`, {
      body: res.body,
    });
  }

  throw lastErr || onvifError(401, 'ONVIF authentication failed (all schemes).');
}

// ---------------------------------------------------------------------------
// SOAP body templates (per operation). Dynamic values are xmlEscape()d.
// ---------------------------------------------------------------------------

function bodyGetSystemDateAndTime() {
  return `<tds:GetSystemDateAndTime xmlns:tds="${NS.tds}"/>`;
}

function bodyGetServices(includeCapability) {
  return (
    `<tds:GetServices xmlns:tds="${NS.tds}">` +
    `<tds:IncludeCapability>${includeCapability ? 'true' : 'false'}</tds:IncludeCapability>` +
    `</tds:GetServices>`
  );
}

function bodyGetCapabilities() {
  return (
    `<tds:GetCapabilities xmlns:tds="${NS.tds}">` +
    `<tds:Category>All</tds:Category>` +
    `</tds:GetCapabilities>`
  );
}

function bodyFindRecordings() {
  // Empty scope matches everything; KeepAliveTime is an xs:duration.
  return (
    `<tse:FindRecordings xmlns:tse="${NS.tse}" xmlns:tt="${NS.tt}">` +
    `<tse:Scope/>` +
    `<tse:MaxMatches>100</tse:MaxMatches>` +
    `<tse:KeepAliveTime>PT60S</tse:KeepAliveTime>` +
    `</tse:FindRecordings>`
  );
}

function bodyGetRecordingSearchResults(searchToken) {
  return (
    `<tse:GetRecordingSearchResults xmlns:tse="${NS.tse}">` +
    `<tse:SearchToken>${xmlEscape(searchToken)}</tse:SearchToken>` +
    `<tse:MinResults>1</tse:MinResults>` +
    `<tse:MaxResults>50</tse:MaxResults>` +
    `<tse:WaitTime>PT5S</tse:WaitTime>` +
    `</tse:GetRecordingSearchResults>`
  );
}

function bodyGetRecordings() {
  return `<trc:GetRecordings xmlns:trc="${NS.trc}"/>`;
}

function bodyGetReplayUri(recordingToken) {
  return (
    `<trp:GetReplayUri xmlns:trp="${NS.trp}" xmlns:tt="${NS.tt}">` +
    `<trp:StreamSetup>` +
    `<tt:Stream>RTP-Unicast</tt:Stream>` +
    `<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>` +
    `</trp:StreamSetup>` +
    `<trp:RecordingToken>${xmlEscape(recordingToken)}</trp:RecordingToken>` +
    `</trp:GetReplayUri>`
  );
}

// ---------------------------------------------------------------------------
// Response parsers (prefix-tolerant; distinguish empty from unrecognized).
// ---------------------------------------------------------------------------

/**
 * Parse GetSystemDateAndTime -> { deviceUnix } or null. Reads the UTCDateTime
 * Date/Time fields (falling back to LocalDateTime if UTC is absent).
 */
function parseSystemDateAndTime(body) {
  // Prefer the UTC block; some devices only fill LocalDateTime.
  const utcBlock = blocks('UTCDateTime', body)[0] || blocks('LocalDateTime', body)[0] || body;
  const dateChunk = blocks('Date', utcBlock)[0];
  const timeChunk = blocks('Time', utcBlock)[0];
  if (!dateChunk || !timeChunk) return null;
  const Y = Number(scalar('Year', dateChunk));
  const Mo = Number(scalar('Month', dateChunk));
  const D = Number(scalar('Day', dateChunk));
  const H = Number(scalar('Hour', timeChunk));
  const Mi = Number(scalar('Minute', timeChunk));
  const S = Number(scalar('Second', timeChunk));
  if (![Y, Mo, D, H, Mi, S].every(Number.isFinite)) return null;
  // The fields are UTC; build a UTC epoch.
  const deviceMs = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  if (Number.isNaN(deviceMs)) return null;
  return { deviceUnix: Math.floor(deviceMs / 1000) };
}

/**
 * Parse GetServices -> map of { namespace: xaddr }. Each <Service> carries a
 * <Namespace> and an <XAddr>. Returns {} when no services are recognized.
 */
function parseServices(body) {
  const out = {};
  for (const chunk of blocks('Service', body)) {
    const ns = scalar('Namespace', chunk);
    const xaddr = scalar('XAddr', chunk);
    if (ns && xaddr) out[ns.trim()] = xaddr.trim();
  }
  return out;
}

/**
 * Parse GetCapabilities -> { search, replay, recording } XAddrs (fallback
 * discovery for devices lacking GetServices). Reads the Extension block.
 */
function parseCapabilities(body) {
  const out = {};
  const ext = blocks('Extension', body)[0] || body;
  const search = blocks('Search', ext)[0];
  const replay = blocks('Replay', ext)[0];
  const recording = blocks('Recording', ext)[0];
  if (search) out.search = (scalar('XAddr', search) || '').trim() || undefined;
  if (replay) out.replay = (scalar('XAddr', replay) || '').trim() || undefined;
  if (recording) out.recording = (scalar('XAddr', recording) || '').trim() || undefined;
  return out;
}

/**
 * Parse one RecordingInformation chunk into our internal record shape.
 */
function parseRecordingInformation(chunk) {
  const sourceChunk = blocks('Source', chunk)[0] || '';
  const tracks = blocks('Track', chunk).map((t) => ({
    trackToken: scalar('TrackToken', t),
    trackType: scalar('TrackType', t),
    dataFrom: scalar('DataFrom', t),
    dataTo: scalar('DataTo', t),
  }));
  return {
    recordingToken: scalar('RecordingToken', chunk),
    source: {
      sourceId: scalar('SourceId', sourceChunk),
      name: scalar('Name', sourceChunk),
      location: scalar('Location', sourceChunk),
      description: scalar('Description', sourceChunk),
      address: scalar('Address', sourceChunk),
    },
    earliestRecording: scalar('EarliestRecording', chunk),
    latestRecording: scalar('LatestRecording', chunk),
    recordingStatus: scalar('RecordingStatus', chunk),
    tracks,
  };
}

/**
 * Parse a GetRecordingSearchResults / GetRecordings body into:
 *   { records:[...], searchState, recognized:bool, raw?:string }
 * `recognized` is false (with a sliced raw sample) ONLY when the body contains
 * no RecordingInformation blocks AND no Fault -- the crucial distinction
 * between a genuinely empty archive and a garbled / unrecognized response.
 */
function parseRecordingList(body) {
  const searchState = scalar('SearchState', body);
  const recChunks = blocks('RecordingInformation', body);
  const records = recChunks
    .map(parseRecordingInformation)
    .filter((r) => r.recordingToken); // drop tokenless garbage
  if (records.length > 0) {
    return { records, searchState, recognized: true };
  }
  // Zero records. Decide: legitimately empty vs. unrecognized shape.
  // A response we DO recognize as empty contains a results envelope element
  // (ResultList / SearchResults / a *Response wrapper) even with no records.
  const looksLikeResults =
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?(?:ResultList|GetRecordingSearchResultsResponse|GetRecordingsResponse|SearchResults)[\s/>]/.test(
      String(body)
    );
  if (looksLikeResults) {
    return { records: [], searchState, recognized: true };
  }
  return {
    records: [],
    searchState,
    recognized: false,
    raw: String(body || '').slice(0, 500),
  };
}

/** Parse GetReplayUri -> the RTSP Uri string, or null. */
function parseReplayUri(body) {
  const uri = scalar('Uri', body);
  return uri ? uri.trim() : null;
}

// ---------------------------------------------------------------------------
// Operations.
// ---------------------------------------------------------------------------

/**
 * Measure clock skew via the one UNAUTHENTICATED call. Stores STATE.timeSkewMs
 * (deviceUTC - localNow). Best-effort: a failure leaves skew at 0 but is not
 * fatal (auth may still work if the clocks happen to agree).
 */
async function measureClockSkew() {
  if (STATE.skewMeasured) return STATE.timeSkewMs;
  try {
    const body = await soapCall(
      deviceServiceUrl(),
      ACTION.GetSystemDateAndTime,
      bodyGetSystemDateAndTime(),
      'none'
    );
    const parsed = parseSystemDateAndTime(body);
    if (parsed) {
      STATE.deviceResponded = true;
      // The device reports whole-second precision. Compare it to the local
      // clock floored to whole seconds so an agreeing clock yields exactly
      // zero skew (rather than a spurious -1s from Date.now()'s sub-second
      // remainder dragging a window across a second boundary).
      STATE.timeSkewMs = (parsed.deviceUnix - Math.floor(Date.now() / 1000)) * 1000;
    }
  } catch (_) {
    // Leave skew at 0; subsequent auth may still succeed.
  }
  STATE.skewMeasured = true;
  return STATE.timeSkewMs;
}

/**
 * Discover the Search / Replay / Recording service endpoints. Tries
 * GetServices first, then GetCapabilities, then a fixed-path fallback. All
 * discovered XAddrs are rewritten onto the configured host:port unless
 * ONVIF_HONOR_XADDR is set. Cached after the first success.
 */
async function discoverServices() {
  if (STATE.servicesDiscovered) return STATE.services;
  // Measure clock skew BEFORE any authenticated call. discoverServices() is the
  // chokepoint every authenticated path (search / listChannels / replay) funnels
  // through, and the WS-Security Created header sent below must carry the
  // device's corrected time or the device rejects the request as stale
  // ("Sender not authorized"). measureClockSkew() is idempotent.
  await measureClockSkew();
  const deviceUrl = deviceServiceUrl();
  STATE.services.device = deviceUrl;

  let resolved = { search: null, replay: null, recording: null };

  // Preferred: GetServices.
  try {
    const body = await soapCall(deviceUrl, ACTION.GetServices, bodyGetServices(false), 'auto');
    const map = parseServices(body);
    for (const [ns, xaddr] of Object.entries(map)) {
      if (ns === NS.tse) resolved.search = xaddr;
      else if (ns === NS.trp) resolved.replay = xaddr;
      else if (ns === NS.trc) resolved.recording = xaddr;
    }
  } catch (_) {
    /* fall through to GetCapabilities */
  }

  // Fallback: GetCapabilities (older devices).
  if (!resolved.search || !resolved.replay) {
    try {
      const body = await soapCall(deviceUrl, ACTION.GetCapabilities, bodyGetCapabilities(), 'auto');
      const caps = parseCapabilities(body);
      resolved.search = resolved.search || caps.search || null;
      resolved.replay = resolved.replay || caps.replay || null;
      resolved.recording = resolved.recording || caps.recording || null;
    } catch (_) {
      /* fall through to fixed paths */
    }
  }

  // Final fallback: well-known fixed paths on the configured host.
  const t = configuredTarget();
  const hostPart = t.hostname.includes(':') ? `[${t.hostname}]` : t.hostname;
  const fixed = (p) => `http://${hostPart}:${t.port}${p}`;

  STATE.services.search = resolved.search ? xaddrToTarget(resolved.search) : fixed('/onvif/search');
  STATE.services.replay = resolved.replay ? xaddrToTarget(resolved.replay) : fixed('/onvif/replay');
  STATE.services.recording = resolved.recording
    ? xaddrToTarget(resolved.recording)
    : fixed('/onvif/Recording');

  STATE.servicesDiscovered = true;
  return STATE.services;
}

/**
 * Enumerate all recordings: FindRecordings, then poll GetRecordingSearchResults
 * until SearchState==Completed (or a poll cap). Falls back to GetRecordings
 * (Recording Control) when the Search service is unsupported. Returns
 *   { records:[...], recognized:bool, note?:string, raw?:string }
 * Never reports a phantom-empty: an unrecognized response yields recognized:false.
 */
async function findAllRecordings() {
  await discoverServices();
  const searchUrl = STATE.services.search;

  // (1) FindRecordings -> SearchToken.
  let searchToken = null;
  let searchErr = null;
  try {
    const body = await soapCall(searchUrl, ACTION.FindRecordings, bodyFindRecordings(), 'auto');
    searchToken = scalar('SearchToken', body);
  } catch (e) {
    searchErr = e;
  }

  if (searchToken) {
    // (2) Poll for results.
    const collected = [];
    const seen = new Set();
    let recognizedAtLeastOnce = false;
    let lastRaw = null;
    const MAX_POLLS = 12;
    for (let i = 0; i < MAX_POLLS; i++) {
      let body;
      try {
        body = await soapCall(
          searchUrl,
          ACTION.GetRecordingSearchResults,
          bodyGetRecordingSearchResults(searchToken),
          'auto'
        );
      } catch (e) {
        // A transport/fault error mid-poll: stop and report what we have.
        if (collected.length) break;
        throw e;
      }
      const parsed = parseRecordingList(body);
      if (parsed.recognized) recognizedAtLeastOnce = true;
      else lastRaw = parsed.raw;
      for (const r of parsed.records) {
        if (r.recordingToken && !seen.has(r.recordingToken)) {
          seen.add(r.recordingToken);
          collected.push(r);
        }
      }
      const state = (parsed.searchState || '').toLowerCase();
      if (state === 'completed' || state === 'unknown') break;
    }
    if (collected.length > 0) {
      return { records: collected, recognized: true };
    }
    if (recognizedAtLeastOnce) {
      return { records: [], recognized: true, note: 'No recordings reported by the device.' };
    }
    // Searched but never got a recognizable result shape -> diagnostic.
    return {
      records: [],
      recognized: false,
      note: 'Unrecognized ONVIF search-results response (no RecordingInformation, no Fault).',
      raw: lastRaw,
    };
  }

  // (3) Fallback: GetRecordings on the Recording Control service.
  try {
    const body = await soapCall(
      STATE.services.recording,
      ACTION.GetRecordings,
      bodyGetRecordings(),
      'auto'
    );
    const parsed = parseRecordingList(body);
    if (parsed.records.length > 0) return { records: parsed.records, recognized: true };
    if (parsed.recognized) {
      return { records: [], recognized: true, note: 'No recordings reported by the device.' };
    }
    return {
      records: [],
      recognized: false,
      note: 'Unrecognized ONVIF GetRecordings response (no RecordingInformation, no Fault).',
      raw: parsed.raw,
    };
  } catch (e) {
    // Both Search and Recording listing failed: surface the most informative.
    throw searchErr || e;
  }
}

// ---------------------------------------------------------------------------
// Channel map: stable 0-based chn <-> opaque RecordingToken. Ordered by Source
// name (then earliest recording) for stability. Cached with a short TTL.
// ---------------------------------------------------------------------------

/**
 * Build (or return cached) the channel map. Throws when the underlying
 * enumeration is unrecognized, so callers never silently see an empty list.
 */
async function buildChannelMap() {
  const now = Date.now();
  if (STATE.channelCache && now - STATE.channelCache.builtAt < CHANNEL_CACHE_TTL_MS) {
    return STATE.channelCache;
  }
  const found = await findAllRecordings();
  if (!found.recognized) {
    throw onvifError(502, found.note || 'Unrecognized ONVIF response.', { body: found.raw });
  }

  const sorted = found.records.slice().sort((a, b) => {
    const an = (a.source.name || a.source.location || a.recordingToken || '').toLowerCase();
    const bn = (b.source.name || b.source.location || b.recordingToken || '').toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    const ae = isoToUnix(a.earliestRecording) || 0;
    const be = isoToUnix(b.earliestRecording) || 0;
    return ae - be;
  });

  const channels = sorted.map((r, i) => ({
    chn: i,
    recordingToken: r.recordingToken,
    source: r.source,
    name: r.source.name || r.source.location || '',
    earliest: r.earliestRecording || null,
    latest: r.latestRecording || null,
    recordingStatus: r.recordingStatus || null,
    tracks: r.tracks,
  }));

  const byChn = new Map();
  const byToken = new Map();
  for (const c of channels) {
    byChn.set(c.chn, c);
    if (c.recordingToken) byToken.set(c.recordingToken, c);
  }

  STATE.channelCache = { builtAt: now, channels, byChn, byToken, note: found.note || null };
  return STATE.channelCache;
}

/** Translate a 0-based chn to its RecordingToken (throws on unknown chn). */
async function chnToToken(chn) {
  const map = await buildChannelMap();
  const entry = map.byChn.get(Number(chn));
  if (!entry) {
    throw onvifError(400, `Unknown channel ${chn} (have 0..${Math.max(0, map.channels.length - 1)}).`);
  }
  return entry.recordingToken;
}

// ---------------------------------------------------------------------------
// Public async surface consumed by server.js.
// ---------------------------------------------------------------------------

/**
 * probe() -- reachability + auth + discovery summary. Drives /api/health; the
 * frontend only needs HTTP 200, so this never throws (errors are captured into
 * the returned object).
 */
async function probe() {
  const out = {
    reachable: false,
    authScheme: null,
    deviceTime: null,
    skewMs: 0,
    searchXAddr: null,
    replayXAddr: null,
  };
  try {
    await measureClockSkew();
    out.skewMs = STATE.timeSkewMs;
    // Reachability = the device actually answered the unauthenticated, mandatory
    // GetSystemDateAndTime ping. Service discovery is NOT a reachability signal:
    // discoverServices() falls back to fixed paths and returns successfully even
    // when the host is down, so it must not drive `reachable`.
    out.reachable = STATE.deviceResponded;
    if (STATE.deviceResponded) {
      out.deviceTime = unixToIsoZ((Date.now() + STATE.timeSkewMs) / 1000);
    }
    await discoverServices();
    out.searchXAddr = STATE.services.search;
    out.replayXAddr = STATE.services.replay;
    // Best-effort recording count (does not change reachability either way).
    try {
      const map = await buildChannelMap();
      out.numRecordings = map.channels.length;
    } catch (e) {
      out.recordingsError = e.message;
    }
  } catch (e) {
    out.error = e.message;
    out.errorStatus = e.statusCode || 502;
  }
  out.authScheme = STATE.authScheme;
  return out;
}

/**
 * listChannels() -- the channel picker source. Emits the aliases the frontend's
 * normalizeChannel reads ('channel' 0-based + 'online' + 'name' + 'recording'),
 * plus recordingToken as a debug field.
 */
async function listChannels() {
  const map = await buildChannelMap();
  return map.channels.map((c) => ({
    channel: c.chn, // 0-based; frontend reads index ?? channel ?? ch
    channelDisplay: c.chn + 1,
    name: c.name || '',
    online: c.recordingStatus !== 'Stopped' || c.tracks.length > 0,
    recording: c.recordingStatus === 'Recording',
    recordingToken: c.recordingToken,
    earliest: c.earliest,
    latest: c.latest,
  }));
}

/**
 * search(window, chnSel, typeSel) -- recordings overlapping the requested
 * window. Returns the EXISTING normalized envelope { ok, source:'onvif',
 * window, note, items[] }. ONVIF Profile G exposes per-recording coverage, not
 * the XVR Timing/Motion/Alarm/Manual bitmask, so each item's types default to
 * ['Timing'] (decision #5). The window is clamped by the measured clock skew so
 * we intersect against the device's wall clock.
 *
 *   window : { beginUnix, endUnix, beginStr?, endStr? } (from resolveWindow)
 *   chnSel : undefined/''/'all' -> all channels; or a comma list / array of
 *            0-based channel indices.
 *   typeSel: undefined/''/array/CSV of type names (default ['Timing']).
 */
async function search(window, chnSel, typeSel) {
  await measureClockSkew();
  const map = await buildChannelMap();

  const beginUnix = Number(window.beginUnix);
  const endUnix = Number(window.endUnix);

  // Which channels did the caller ask for?
  let wantChns = null; // null = all
  if (chnSel !== undefined && chnSel !== null && String(chnSel).toLowerCase() !== 'all' && String(chnSel) !== '') {
    const list = Array.isArray(chnSel) ? chnSel : String(chnSel).split(',');
    wantChns = new Set(
      list
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isInteger(n))
    );
  }

  // Type labels: ONVIF coverage is per-recording; default to Timing.
  let types = ['Timing'];
  if (typeSel !== undefined && typeSel !== null && typeSel !== '') {
    const list = Array.isArray(typeSel) ? typeSel : String(typeSel).split(',');
    const cleaned = list.map((s) => String(s).trim()).filter(Boolean);
    if (cleaned.length) types = cleaned;
  }

  const items = [];
  for (const c of map.channels) {
    if (wantChns && !wantChns.has(c.chn)) continue;
    const recEarliest = isoToUnix(c.earliest);
    const recLatest = isoToUnix(c.latest);
    // Intersect the recording's [earliest, latest] coverage with the requested
    // window. When the device omits bounds we keep the channel (best-effort).
    let begin = beginUnix;
    let end = endUnix;
    if (recEarliest != null) begin = Math.max(begin, recEarliest);
    if (recLatest != null) end = Math.min(end, recLatest);
    if (recEarliest != null && recLatest != null && (recLatest <= beginUnix || recEarliest >= endUnix)) {
      // No overlap with the requested window.
      continue;
    }
    if (end <= begin) continue;

    items.push({
      chn: c.chn,
      channelDisplay: c.chn + 1, // 1-based for display
      begin,
      end,
      durationSec: end - begin,
      // Profile G search carries no byte size; expose null so the UI shows
      // "unknown" rather than 0.
      sizeBytes: null,
      types: types.slice(),
      // No bitmask on ONVIF; null keeps the frontend's type alias happy.
      typeRaw: null,
      stream: `/api/recordings/clip.mp4?chn=${c.chn}&begin=${begin}&end=${end}`,
      downloadMp4: `/api/recordings/download?chn=${c.chn}&begin=${begin}&end=${end}&format=mp4`,
      // FLV is not available for ONVIF; the link is kept shaped like the legacy
      // backend for the frontend, but the backend returns 400 if requested.
      downloadFlv: `/api/recordings/download?chn=${c.chn}&begin=${begin}&end=${end}&format=flv`,
      // Debug-only, mirrors the legacy flvUpstream transparency field.
      recordingToken: c.recordingToken,
    });
  }

  // Distinguish "no overlapping coverage" from device-empty for the UI hint.
  let note = map.note || null;
  if (!note && items.length === 0) {
    note =
      map.channels.length === 0
        ? 'The device reported no recordings.'
        : 'No recordings overlap the requested window. ' +
          'Note: ONVIF Profile G exposes per-recording coverage, not per-event clips.';
  }

  return {
    ok: true,
    source: 'onvif',
    window: {
      beginUnix,
      endUnix,
      begin: window.beginStr || unixToIsoZ(beginUnix),
      end: window.endStr || unixToIsoZ(endUnix),
    },
    note,
    items,
  };
}

/**
 * replayUriForClip({chn, beginUnix, endUnix}) -- resolve the RTSP replay URI
 * for the clip, append the vendor time-range query params (approach A), and
 * inject the credentials into the rtsp:// userinfo so ffmpeg can authenticate.
 * Returns the final rtsp URL string for server.js's streamRtspAsMp4.
 */
async function replayUriForClip(opts) {
  await measureClockSkew();
  const chn = Number(opts.chn);
  const beginUnix = Number(opts.beginUnix);
  const endUnix = Number(opts.endUnix);
  if (!Number.isFinite(beginUnix) || !Number.isFinite(endUnix) || endUnix <= beginUnix) {
    throw onvifError(400, 'Invalid begin/end for replay.');
  }

  const recordingToken = await chnToToken(chn);
  await discoverServices();

  const body = await soapCall(
    STATE.services.replay,
    ACTION.GetReplayUri,
    bodyGetReplayUri(recordingToken),
    'auto'
  );
  const rawUri = parseReplayUri(body);
  if (!rawUri) {
    throw onvifError(502, 'ONVIF GetReplayUri returned no Uri.', { body: String(body).slice(0, 500) });
  }

  // Apply the measured skew to the window so we replay the right wall-clock
  // range, then format as the compact ISO basic form devices expect.
  const startClock = isoToRtspClock(unixToIsoZ(beginUnix + STATE.timeSkewMs / 1000));
  const endClock = isoToRtspClock(unixToIsoZ(endUnix + STATE.timeSkewMs / 1000));

  let u;
  try {
    u = new URL(rawUri);
  } catch (_) {
    throw onvifError(502, `ONVIF GetReplayUri returned an invalid URI: ${rawUri}`);
  }

  // (A) Append vendor time-range query params. Preserve any existing token=
  // params the device already embedded.
  const params = new URLSearchParams(u.search);
  params.set('starttime', startClock);
  params.set('endtime', endClock);
  u.search = '?' + params.toString();

  // Inject credentials into the rtsp:// userinfo for ffmpeg's RTSP auth.
  // (URL userinfo percent-encoding keeps special characters safe.)
  if (CONFIG.user) {
    u.username = encodeURIComponent(CONFIG.user);
    u.password = CONFIG.pass ? encodeURIComponent(CONFIG.pass) : '';
  }

  return u.toString();
}

// ---------------------------------------------------------------------------
// Exports: the async surface server.js consumes + the pure helpers the unit
// tests exercise.
// ---------------------------------------------------------------------------
module.exports = {
  // Async surface for server.js.
  probe,
  listChannels,
  search,
  replayUriForClip,
  // Pure helpers for unit tests.
  computePasswordDigest,
  wsSecurityHeader,
  soapEnvelope,
  buildSoapEnvelope: soapEnvelope, // alias per spec
  parseFault,
  scalar,
  blocks,
  attr,
  parseSystemDateAndTime,
  parseServices,
  parseCapabilities,
  parseRecordingList,
  parseRecordingInformation,
  parseReplayUri,
  unixToIsoZ,
  isoToUnix,
  isoToRtspClock,
  splitHostPort,
  xmlEscape,
  xmlUnescape,
  // Config + namespaces (read-only references for tests / health).
  CONFIG,
  NS,
};
