#!/usr/bin/env node
'use strict';
/*
 * onvif-client.js — hardware-free unit tests for recordings/onvif.js.
 *
 * Exercises ONLY the pure, exported helpers of the ONVIF Profile G client:
 * WS-Security PasswordDigest, the SOAP 1.2 envelope / UsernameToken render, the
 * prefix-tolerant response parsers (FindRecordings/GetRecordingSearchResults,
 * GetReplayUri, GetSystemDateAndTime), SOAP <Fault> -> typed error mapping, and
 * the UTC time / host:port helpers. No device, no network, no go2rtc, no
 * browser — just node:assert against canned spec-shaped XML, in the same
 * static/headless spirit as the other tests/ scripts.
 *
 * Fixtures are PLACEHOLDER-ONLY: RFC5737 doc IPs (192.0.2.x), neutral tokens,
 * and a fabricated nonce/created/password. tests/ is exempt from the secret
 * scanners, but we stay hygienic — there are no real LAN IPs or credentials.
 *
 * Run: `node tests/onvif-client.js` (exits non-zero on the first failure).
 * Dependency-free: Node built-ins (assert) + require('../recordings/onvif').
 */

const assert = require('node:assert');
const path = require('node:path');

const onvif = require(path.join(__dirname, '..', 'recordings', 'onvif'));

// --- tiny test harness ------------------------------------------------------
let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// (1) computePasswordDigest — deterministic, self-consistent test vector.
//
// The implementation spec (.docs/onvif-implementation-spec.md) gives the EXACT
// OASIS UsernameToken-Profile formula and node:crypto recipe but does NOT pin a
// concrete published worked-example triple (Nonce/Created/Password -> Digest).
// Per the task we therefore assert a DETERMINISTIC SELF-CONSISTENT vector and
// document it here: the digest below was computed once with Node's own
// crypto.createHash('sha1') over the documented byte-concatenation order
//   SHA1( base64decode(Nonce) ++ utf8(Created) ++ utf8(Password) )
// and is reproduced inline by the test so any future change to the byte order,
// nonce decoding, or hash/encoding choice is caught. All inputs are fabricated
// placeholders (16-byte nonce, a fixed UTC Created, a neutral password).
// ---------------------------------------------------------------------------
const VECTOR = {
  nonceB64: 'LKqI6G9P1uS6n7vQ3pA4Bw==', // 16 raw bytes, base64-encoded
  created: '2026-06-04T09:00:00Z', // xs:dateTime, UTC 'Z'
  password: 'test-password', // neutral placeholder, NOT a real credential
  // Base64( SHA1( base64decode(nonceB64) ++ utf8(created) ++ utf8(password) ) )
  expectedDigest: 'jemFt9HxdvD2uNDh+brLosYb384=',
};

test('computePasswordDigest matches the fixed self-consistent vector (base64 nonce)', () => {
  const digest = onvif.computePasswordDigest(VECTOR.nonceB64, VECTOR.created, VECTOR.password);
  assert.strictEqual(
    digest,
    VECTOR.expectedDigest,
    'PasswordDigest from a base64 nonce string must equal the documented vector'
  );
});

test('computePasswordDigest accepts a raw Buffer nonce identically', () => {
  const nonceBytes = Buffer.from(VECTOR.nonceB64, 'base64');
  assert.strictEqual(nonceBytes.length, 16, 'fixture nonce decodes to 16 raw bytes');
  const digest = onvif.computePasswordDigest(nonceBytes, VECTOR.created, VECTOR.password);
  assert.strictEqual(
    digest,
    VECTOR.expectedDigest,
    'a Buffer nonce must hash identically to its base64 form'
  );
});

test('computePasswordDigest is sensitive to the byte-concatenation order', () => {
  // Changing ANY of the three inputs must change the digest — proves the hash
  // really folds in nonce + created + password (not a constant).
  const base = onvif.computePasswordDigest(VECTOR.nonceB64, VECTOR.created, VECTOR.password);
  const otherNonce = onvif.computePasswordDigest(
    'AAAAAAAAAAAAAAAAAAAAAA==',
    VECTOR.created,
    VECTOR.password
  );
  const otherCreated = onvif.computePasswordDigest(
    VECTOR.nonceB64,
    '2026-06-04T09:00:01Z',
    VECTOR.password
  );
  const otherPass = onvif.computePasswordDigest(VECTOR.nonceB64, VECTOR.created, 'other-password');
  assert.notStrictEqual(base, otherNonce, 'nonce participates in the digest');
  assert.notStrictEqual(base, otherCreated, 'created participates in the digest');
  assert.notStrictEqual(base, otherPass, 'password participates in the digest');
});

// ---------------------------------------------------------------------------
// (2) SOAP 1.2 envelope + WS-Security UsernameToken render.
// ---------------------------------------------------------------------------
test('soapEnvelope renders a well-formed SOAP 1.2 envelope with the WS-Security UsernameToken', () => {
  const header = onvif.wsSecurityHeader(
    'admin',
    VECTOR.password,
    VECTOR.created,
    VECTOR.nonceB64
  );
  const env = onvif.soapEnvelope('<tse:FindRecordings/>', header);

  // SOAP 1.2 structure + namespace.
  assert.ok(env.startsWith('<?xml'), 'has an XML prolog');
  assert.ok(
    env.includes('<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'),
    'is a SOAP 1.2 (2003/05) Envelope'
  );
  assert.ok(env.includes('<s:Header>') && env.includes('</s:Header>'), 'has a Header');
  assert.ok(
    env.includes('<s:Body><tse:FindRecordings/></s:Body>'),
    'wraps the body fragment in <s:Body>'
  );

  // WS-Security UsernameToken parts.
  assert.ok(
    env.includes('<wsse:Security s:mustUnderstand="1"'),
    'Security header is mustUnderstand=1'
  );
  assert.ok(env.includes('<wsse:UsernameToken>'), 'carries a UsernameToken');
  assert.ok(env.includes('<wsse:Username>admin</wsse:Username>'), 'Username present');

  // Password element MUST be typed as #PasswordDigest and carry the digest.
  assert.ok(
    env.includes(
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
    ),
    'Password is typed #PasswordDigest'
  );
  assert.ok(
    env.includes(`>${VECTOR.expectedDigest}</wsse:Password>`),
    'Password element contains the computed digest'
  );

  // Nonce (EncodingType Base64Binary) + Created.
  assert.ok(
    env.includes('<wsse:Nonce EncodingType="') && env.includes('#Base64Binary">'),
    'Nonce carries the Base64Binary EncodingType'
  );
  assert.ok(env.includes(`>${VECTOR.nonceB64}</wsse:Nonce>`), 'Nonce element carries the nonce');
  assert.ok(
    env.includes(`<wsu:Created>${VECTOR.created}</wsu:Created>`),
    'Created element carries the UTC timestamp'
  );
});

test('soapEnvelope without a security header emits an empty <s:Header/>', () => {
  const env = onvif.soapEnvelope('<tds:GetSystemDateAndTime/>', '');
  assert.ok(env.includes('<s:Header/>'), 'empty header when no security block given');
  assert.ok(!env.includes('wsse:Security'), 'no Security block for an unauthenticated call');
});

test('buildSoapEnvelope is exported as an alias for soapEnvelope', () => {
  assert.strictEqual(
    onvif.buildSoapEnvelope,
    onvif.soapEnvelope,
    'buildSoapEnvelope alias is wired up (per spec)'
  );
});

// ---------------------------------------------------------------------------
// (3) Response parsers on canned spec-shaped XML (namespace-prefix + self-
//     closing tolerant). Modeled on the spec's responseFieldsWeNeed shapes.
// ---------------------------------------------------------------------------

// GetRecordingSearchResults — two records with DIFFERENT namespace prefixes
// (env: vs tt: vs tns:) and a self-closing element, to prove prefix tolerance.
const SEARCH_RESULTS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">',
  ' <env:Body>',
  '  <tse:GetRecordingSearchResultsResponse xmlns:tse="http://www.onvif.org/ver10/search/wsdl">',
  '   <tse:ResultList>',
  '    <tt:SearchState xmlns:tt="http://www.onvif.org/ver10/schema">Completed</tt:SearchState>',
  '    <tt:RecordingInformation xmlns:tt="http://www.onvif.org/ver10/schema">',
  '     <tt:RecordingToken>SD_REC0002</tt:RecordingToken>',
  '     <tt:Source>',
  '      <tt:SourceId>http://192.0.2.14/sources/1</tt:SourceId>',
  '      <tt:Name>Back Yard</tt:Name>',
  '      <tt:Location>Rear</tt:Location>',
  '      <tt:Description>Camera 2</tt:Description>',
  '      <tt:Address>192.0.2.14</tt:Address>',
  '     </tt:Source>',
  '     <tt:EarliestRecording>2026-06-04T06:00:00Z</tt:EarliestRecording>',
  '     <tt:LatestRecording>2026-06-04T12:00:00Z</tt:LatestRecording>',
  '     <tt:RecordingStatus>Recording</tt:RecordingStatus>',
  '     <tt:Track>',
  '      <tt:TrackToken>VIDEO002</tt:TrackToken>',
  '      <tt:TrackType>Video</tt:TrackType>',
  '      <tt:DataFrom>2026-06-04T06:00:00Z</tt:DataFrom>',
  '      <tt:DataTo>2026-06-04T12:00:00Z</tt:DataTo>',
  '     </tt:Track>',
  '    </tt:RecordingInformation>',
  // Second record with a bare (no-prefix) tag name + a self-closing field.
  '    <RecordingInformation>',
  '     <RecordingToken>SD_REC0001</RecordingToken>',
  '     <Source>',
  '      <Name>Front Door</Name>',
  '      <Location>Entrance</Location>',
  '      <Description/>',
  '     </Source>',
  '     <EarliestRecording>2026-06-04T00:00:00Z</EarliestRecording>',
  '     <LatestRecording>2026-06-04T23:59:59Z</LatestRecording>',
  '     <RecordingStatus>Stopped</RecordingStatus>',
  '    </RecordingInformation>',
  '   </tse:ResultList>',
  '  </tse:GetRecordingSearchResultsResponse>',
  ' </env:Body>',
  '</env:Envelope>',
].join('\n');

test('parseRecordingList extracts SearchState + both records (prefixed and bare)', () => {
  const parsed = onvif.parseRecordingList(SEARCH_RESULTS_XML);
  assert.strictEqual(parsed.recognized, true, 'recognized as a real results envelope');
  assert.strictEqual(parsed.searchState, 'Completed', 'SearchState parsed');
  assert.strictEqual(parsed.records.length, 2, 'both RecordingInformation blocks parsed');

  const tokens = parsed.records.map((r) => r.recordingToken);
  assert.deepStrictEqual(
    tokens,
    ['SD_REC0002', 'SD_REC0001'],
    'records parsed in document order, both prefix styles'
  );

  const first = parsed.records[0];
  assert.strictEqual(first.source.name, 'Back Yard', 'Source.Name extracted');
  assert.strictEqual(first.source.location, 'Rear', 'Source.Location extracted');
  assert.strictEqual(first.earliestRecording, '2026-06-04T06:00:00Z', 'EarliestRecording extracted');
  assert.strictEqual(first.latestRecording, '2026-06-04T12:00:00Z', 'LatestRecording extracted');
  assert.strictEqual(first.recordingStatus, 'Recording', 'RecordingStatus extracted');
  assert.strictEqual(first.tracks.length, 1, 'one Track parsed');
  assert.strictEqual(first.tracks[0].trackType, 'Video', 'TrackType extracted');
  assert.strictEqual(first.tracks[0].trackToken, 'VIDEO002', 'TrackToken extracted');

  // Self-closing <Description/> -> present-but-empty ('' not null).
  const second = parsed.records[1];
  assert.strictEqual(second.source.name, 'Front Door', 'bare-prefix Source.Name extracted');
  assert.strictEqual(
    second.source.description,
    '',
    'self-closing <Description/> yields empty string'
  );
});

test('parseRecordingInformation parses a single canned chunk', () => {
  const chunk = [
    '<tt:RecordingInformation xmlns:tt="http://www.onvif.org/ver10/schema">',
    ' <tt:RecordingToken>TOK1</tt:RecordingToken>',
    ' <tt:Source><tt:Name>Lobby</tt:Name></tt:Source>',
    ' <tt:EarliestRecording>2026-06-04T01:00:00Z</tt:EarliestRecording>',
    ' <tt:LatestRecording>2026-06-04T02:00:00Z</tt:LatestRecording>',
    '</tt:RecordingInformation>',
  ].join('\n');
  const rec = onvif.parseRecordingInformation(chunk);
  assert.strictEqual(rec.recordingToken, 'TOK1');
  assert.strictEqual(rec.source.name, 'Lobby');
  assert.deepStrictEqual(rec.tracks, [], 'no tracks -> empty array');
});

test('scalar / blocks / attr are prefix-tolerant and handle self-closing tags', () => {
  // scalar: bare, prefixed, self-closing (-> '' present-but-empty), absent (-> null).
  assert.strictEqual(onvif.scalar('Uri', '<Uri>rtsp://x</Uri>'), 'rtsp://x');
  assert.strictEqual(onvif.scalar('Uri', '<trp:Uri>rtsp://y</trp:Uri>'), 'rtsp://y');
  assert.strictEqual(onvif.scalar('Empty', '<tt:Empty/>'), '', 'self-closing -> empty string');
  assert.strictEqual(onvif.scalar('Missing', '<tt:Other>z</tt:Other>'), null, 'absent -> null');
  // entity unescape on extracted text.
  assert.strictEqual(onvif.scalar('N', '<N>a &amp; b &lt;c&gt;</N>'), 'a & b <c>');

  // blocks: count repeated elements including a self-closing occurrence.
  const body = '<tt:Track>a</tt:Track><Track>b</Track><tt:Track/>';
  const chunks = onvif.blocks('Track', body);
  assert.strictEqual(chunks.length, 3, 'paired + bare-prefix + self-closing all counted');

  // attr: read an attribute off the first matching open tag.
  assert.strictEqual(
    onvif.attr('Password', 'Type', '<wsse:Password Type="X#PasswordDigest">d</wsse:Password>'),
    'X#PasswordDigest'
  );
});

test('extractors tolerate hyphenated NCName prefixes (gSOAP "SOAP-ENV:")', () => {
  // gSOAP (Hikvision/Dahua/many embedded NVRs) emits the "SOAP-ENV:" prefix
  // whose hyphen is NOT matched by \w. A \w-only prefix silently fails to find
  // these elements; the prefix matcher must accept the full XML NCName charset.
  assert.strictEqual(onvif.scalar('Uri', '<SOAP-ENV:Uri>rtsp://z</SOAP-ENV:Uri>'), 'rtsp://z');
  assert.strictEqual(
    onvif.attr('Track', 'TrackType', '<SOAP-ENV:Track TrackType="Video"/>'),
    'Video'
  );
  assert.strictEqual(onvif.blocks('Service', '<SOAP-ENV:Service><x/></SOAP-ENV:Service>').length, 1);
});

test('parseFault detects a gSOAP "SOAP-ENV:"-prefixed NotAuthorized fault', () => {
  const xml = [
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope">',
    '<SOAP-ENV:Body><SOAP-ENV:Fault>',
    '<SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value>',
    '<SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode>',
    '</SOAP-ENV:Code>',
    '<SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">Sender not authorized</SOAP-ENV:Text>',
    '</SOAP-ENV:Reason></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>',
  ].join('');
  const err = onvif.parseFault(xml);
  assert.ok(err instanceof Error, 'detects the SOAP-ENV-prefixed Fault');
  assert.strictEqual(err.statusCode, 401, 'NotAuthorized -> HTTP 401 even with a hyphenated prefix');
  assert.strictEqual(err.faultSubcode, 'ter:NotAuthorized', 'captured the fault subcode');
  assert.ok(/Sender not authorized/.test(err.message), 'surfaces the human Reason text');
});

// GetReplayUri.
const REPLAY_URI_XML = [
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>',
  '<trp:GetReplayUriResponse xmlns:trp="http://www.onvif.org/ver10/replay/wsdl">',
  '<trp:Uri>rtsp://192.0.2.14/onvif/replay?token=SD_REC0001</trp:Uri>',
  '</trp:GetReplayUriResponse></env:Body></env:Envelope>',
].join('');

test('parseReplayUri extracts the RTSP replay Uri', () => {
  assert.strictEqual(
    onvif.parseReplayUri(REPLAY_URI_XML),
    'rtsp://192.0.2.14/onvif/replay?token=SD_REC0001'
  );
  assert.strictEqual(onvif.parseReplayUri('<env:Body></env:Body>'), null, 'no Uri -> null');
});

// GetSystemDateAndTime (UTC block).
const SYSTEM_DATE_XML = [
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>',
  '<tds:GetSystemDateAndTimeResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl">',
  '<tds:SystemDateAndTime>',
  '<tt:UTCDateTime xmlns:tt="http://www.onvif.org/ver10/schema">',
  '<tt:Time><tt:Hour>9</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>0</tt:Second></tt:Time>',
  '<tt:Date><tt:Year>2026</tt:Year><tt:Month>6</tt:Month><tt:Day>4</tt:Day></tt:Date>',
  '</tt:UTCDateTime>',
  '</tds:SystemDateAndTime>',
  '</tds:GetSystemDateAndTimeResponse></env:Body></env:Envelope>',
].join('');

test('parseSystemDateAndTime reads the UTC Date/Time block to a Unix epoch', () => {
  const parsed = onvif.parseSystemDateAndTime(SYSTEM_DATE_XML);
  assert.ok(parsed, 'parsed a result');
  assert.strictEqual(
    onvif.unixToIsoZ(parsed.deviceUnix),
    '2026-06-04T09:00:00Z',
    'device UTC round-trips to the expected ISO Z string'
  );
});

test('parseServices maps Service Namespace -> XAddr', () => {
  const xml = [
    '<tds:GetServicesResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl">',
    '<tds:Service><tds:Namespace>http://www.onvif.org/ver10/search/wsdl</tds:Namespace>',
    '<tds:XAddr>http://192.0.2.14/onvif/search</tds:XAddr></tds:Service>',
    '<tds:Service><tds:Namespace>http://www.onvif.org/ver10/replay/wsdl</tds:Namespace>',
    '<tds:XAddr>http://192.0.2.14/onvif/replay</tds:XAddr></tds:Service>',
    '</tds:GetServicesResponse>',
  ].join('');
  const map = onvif.parseServices(xml);
  assert.strictEqual(map[onvif.NS.tse], 'http://192.0.2.14/onvif/search', 'search XAddr mapped');
  assert.strictEqual(map[onvif.NS.trp], 'http://192.0.2.14/onvif/replay', 'replay XAddr mapped');
});

// ---------------------------------------------------------------------------
// (4) SOAP <Fault> -> typed error mapping (NotAuthorized -> 401).
// ---------------------------------------------------------------------------
const FAULT_NOT_AUTHORIZED_XML = [
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>',
  '<env:Fault>',
  ' <env:Code><env:Value>env:Sender</env:Value>',
  '  <env:Subcode><env:Value>ter:NotAuthorized</env:Value></env:Subcode></env:Code>',
  ' <env:Reason><env:Text xml:lang="en">Sender not authorized</env:Text></env:Reason>',
  '</env:Fault></env:Body></env:Envelope>',
].join('');

test('parseFault maps a NotAuthorized Subcode to a typed 401 error', () => {
  const err = onvif.parseFault(FAULT_NOT_AUTHORIZED_XML);
  assert.ok(err instanceof Error, 'returns an Error');
  assert.strictEqual(err.statusCode, 401, 'NotAuthorized -> HTTP 401');
  assert.strictEqual(err.fault, true, 'flagged as a SOAP fault');
  assert.strictEqual(err.faultSubcode, 'ter:NotAuthorized', 'captured the fault subcode');
  assert.ok(/Sender not authorized/.test(err.message), 'surfaces the human Reason text');
});

test('parseFault maps an InvalidArgVal Subcode to 400', () => {
  const xml = [
    '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>',
    '<env:Fault><env:Code><env:Value>env:Sender</env:Value>',
    '<env:Subcode><env:Value>ter:InvalidArgVal</env:Value></env:Subcode></env:Code>',
    '<env:Reason><env:Text>Bad argument</env:Text></env:Reason></env:Fault>',
    '</env:Body></env:Envelope>',
  ].join('');
  const err = onvif.parseFault(xml);
  assert.strictEqual(err.statusCode, 400, 'InvalidArgVal -> HTTP 400');
});

test('parseFault returns null when there is no Fault', () => {
  assert.strictEqual(
    onvif.parseFault(REPLAY_URI_XML),
    null,
    'a clean response has no fault'
  );
});

test('an unrecognized response shape yields a diagnostic, not a phantom-empty list', () => {
  const garbage =
    '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">' +
    '<env:Body><weird>unexpected</weird></env:Body></env:Envelope>';
  const parsed = onvif.parseRecordingList(garbage);
  assert.strictEqual(parsed.recognized, false, 'not recognized (no records, no results wrapper)');
  assert.strictEqual(parsed.records.length, 0, 'no phantom records');
  assert.strictEqual(typeof parsed.raw, 'string', 'carries a sliced raw sample for diagnosis');

  // A genuinely-empty-but-recognized results envelope IS recognized.
  const emptyOk =
    '<tse:GetRecordingSearchResultsResponse><tse:ResultList>' +
    '<tt:SearchState>Completed</tt:SearchState></tse:ResultList>' +
    '</tse:GetRecordingSearchResultsResponse>';
  const empty = onvif.parseRecordingList(emptyOk);
  assert.strictEqual(empty.recognized, true, 'empty-but-shaped results recognized');
  assert.strictEqual(empty.records.length, 0, 'genuinely empty');
});

// ---------------------------------------------------------------------------
// (5) Time helpers (UTC 'Z') + splitHostPort.
// ---------------------------------------------------------------------------
test('unixToIsoZ emits a UTC Z string with no fractional seconds', () => {
  const unix = Date.UTC(2026, 5, 4, 9, 0, 0) / 1000; // 2026-06-04T09:00:00Z
  assert.strictEqual(onvif.unixToIsoZ(unix), '2026-06-04T09:00:00Z');
  // Fractional input is rounded to whole seconds and still ends in 'Z'.
  assert.strictEqual(onvif.unixToIsoZ(unix + 0.4), '2026-06-04T09:00:00Z');
  assert.ok(/Z$/.test(onvif.unixToIsoZ(unix)), 'always ends in Z (UTC)');
});

test('isoToUnix <-> unixToIsoZ round-trip', () => {
  const iso = '2026-06-04T09:00:00Z';
  const unix = onvif.isoToUnix(iso);
  assert.strictEqual(unix, Date.UTC(2026, 5, 4, 9, 0, 0) / 1000, 'ISO Z parsed to Unix seconds');
  assert.strictEqual(onvif.unixToIsoZ(unix), iso, 'round-trips back to the same ISO Z string');
  assert.strictEqual(onvif.isoToUnix(''), null, 'empty -> null');
  assert.strictEqual(onvif.isoToUnix('not-a-date'), null, 'garbage -> null');
});

test('isoToRtspClock produces the compact YYYYMMDDThhmmssZ form', () => {
  assert.strictEqual(onvif.isoToRtspClock('2026-06-04T08:00:00Z'), '20260604T080000Z');
  assert.strictEqual(
    onvif.isoToRtspClock('2026-06-04T08:00:00.440Z'),
    '20260604T080000Z',
    'fractional seconds dropped'
  );
});

test('splitHostPort splits host:port and applies the default port', () => {
  assert.deepStrictEqual(onvif.splitHostPort('192.0.2.14'), { hostname: '192.0.2.14', port: 80 });
  assert.deepStrictEqual(onvif.splitHostPort('192.0.2.14:8080'), {
    hostname: '192.0.2.14',
    port: 8080,
  });
  assert.deepStrictEqual(onvif.splitHostPort('192.0.2.14', 554), {
    hostname: '192.0.2.14',
    port: 554,
  });
  // Bracketed IPv6: the inner colons are NOT mistaken for the port separator.
  assert.deepStrictEqual(onvif.splitHostPort('[2001:db8::1]:554'), {
    hostname: '2001:db8::1',
    port: 554,
  });
  assert.deepStrictEqual(onvif.splitHostPort('[2001:db8::1]'), {
    hostname: '2001:db8::1',
    port: 80,
  });
});

test('xmlEscape / xmlUnescape round-trip the 5 XML entities', () => {
  const raw = `a & b < c > d " e ' f`;
  const escaped = onvif.xmlEscape(raw);
  assert.ok(
    escaped.includes('&amp;') &&
      escaped.includes('&lt;') &&
      escaped.includes('&gt;') &&
      escaped.includes('&quot;') &&
      escaped.includes('&apos;'),
    'all 5 entities escaped'
  );
  assert.strictEqual(onvif.xmlUnescape(escaped), raw, 'unescape reverses escape');
});

// ---------------------------------------------------------------------------
// Runner — sequential, fail-fast-friendly (collects all failures, exits 1).
// ---------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e && e.message ? e.message : e}`);
  }
}

console.log('');
console.log(`onvif-client: ${passed} passed, ${failed} failed (of ${tests.length})`);
if (failed > 0) {
  console.error('onvif-client: FAILED');
  process.exit(1);
}
console.log('onvif-client: OK');
