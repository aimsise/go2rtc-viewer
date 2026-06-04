#!/usr/bin/env node
'use strict';
/*
 * i18n-parity.js — asserts every i18n key the UI references actually exists in
 * BOTH the `ja` and `en` dictionaries of the matching i18n.js.
 *
 * "Matching": web pages (web/*.html, web/{app,streams}.js) use web/i18n.js;
 * the recordings page (recordings/public/recordings.html + recordings.js) uses
 * recordings/public/i18n.js.
 *
 * Keys are referenced two ways:
 *   1. HTML attributes: data-i18n / data-i18n-title / data-i18n-placeholder /
 *      data-i18n-aria-label="KEY".
 *   2. JS calls: window.i18n.t('KEY', ...) — we only collect STRING-LITERAL
 *      first args. Computed keys (template literals / variables, e.g.
 *      i18n.t(`rec.type.${cls}`)) cannot be resolved statically and are skipped;
 *      their concrete values (rec.type.timing/motion/alarm/manual, conn-status
 *      keys) are covered by other literal references / the dicts themselves.
 *
 * Dict loading is belt-and-suspenders:
 *   - We `vm`-load each i18n.js in a sandbox with mocked document/window/
 *     localStorage/navigator. This proves the file parses & runs and exposes
 *     window.i18n.t (a real smoke test of the shipped artifact).
 *   - We ALSO extract the raw DICT object by brace-matching `const DICT = {...}`
 *     and JSON.parse it, so we can check `ja` and `en` INDEPENDENTLY. (t() falls
 *     back to ja when a key is missing in the active language, which would
 *     otherwise hide a missing `en` key.)
 *
 * Dependency-free: Node built-ins only (fs, path, vm).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL: ' + msg); };

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// --- Extract the DICT object from an i18n.js as parsed JSON ------------------
function extractDict(rel) {
  const src = read(rel);
  const at = src.indexOf('const DICT =');
  if (at === -1) throw new Error(rel + ': could not find `const DICT =`');
  const braceStart = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = braceStart; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error(rel + ': unbalanced braces in DICT');
  return JSON.parse(src.slice(braceStart, end + 1));
}

// --- Smoke-load i18n.js in a vm sandbox; returns window.i18n ----------------
function loadI18n(rel) {
  const noop = () => {};
  const fakeEl = {
    getAttribute: () => null,
    setAttribute: noop,
    hasAttribute: () => false,
  };
  const document = {
    readyState: 'complete',
    documentElement: { setAttribute: noop, getAttribute: () => null },
    querySelectorAll: () => [],
    addEventListener: noop,
    title: '',
    nodeType: 9,
  };
  const sandbox = {
    document,
    navigator: { language: 'ja' },
    localStorage: { getItem: () => null, setItem: noop },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    setTimeout: noop,
    console,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = noop;
  sandbox.window.dispatchEvent = noop;
  vm.createContext(sandbox);
  vm.runInContext(read(rel), sandbox, { filename: rel });
  if (!sandbox.window.i18n || typeof sandbox.window.i18n.t !== 'function') {
    throw new Error(rel + ': did not expose window.i18n.t after load');
  }
  return sandbox.window.i18n;
}

// --- Collect data-i18n* keys from an HTML file -------------------------------
function htmlKeys(rel) {
  const src = read(rel);
  const keys = new Set();
  const re = /data-i18n(?:-title|-placeholder|-aria-label)?\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  // also data-title-key on <html>
  const tk = /data-title-key\s*=\s*"([^"]+)"/g;
  while ((m = tk.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

// --- Collect i18n.t('literal', ...) keys from a JS file ----------------------
function jsKeys(rel) {
  const src = read(rel);
  const keys = new Set();
  // i18n.t( 'key'  or  i18n.t( "key"   — literal first arg only.
  const re = /\bi18n\s*\.\s*t\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[2]);
  return keys;
}

// --- Assert a set of keys exists in both ja and en of a dict ----------------
function checkKeys(label, keys, dict, dictRel) {
  const ja = dict.ja || {};
  const en = dict.en || {};
  for (const k of [...keys].sort()) {
    if (!Object.prototype.hasOwnProperty.call(ja, k)) {
      fail(`${label}: key "${k}" missing from JA dict of ${dictRel}`);
    }
    if (!Object.prototype.hasOwnProperty.call(en, k)) {
      fail(`${label}: key "${k}" missing from EN dict of ${dictRel}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Group 1: web pages -> web/i18n.js
// ---------------------------------------------------------------------------
const WEB_DICT_REL = 'web/i18n.js';
const RECS_DICT_REL = 'recordings/public/i18n.js';

const groups = [
  {
    name: 'web',
    dictRel: WEB_DICT_REL,
    html: ['web/index.html', 'web/streams.html'],
    js: ['web/app.js', 'web/streams.js'],
  },
  {
    name: 'recordings',
    dictRel: RECS_DICT_REL,
    html: ['recordings/public/recordings.html'],
    js: ['recordings/public/recordings.js'],
  },
];

console.log('i18n-parity: checking key parity (ja + en) per page group');

// Sanity: ja and en dicts of each i18n.js must have identical key sets.
for (const dictRel of [WEB_DICT_REL, RECS_DICT_REL]) {
  let dict;
  try {
    dict = extractDict(dictRel);
    loadI18n(dictRel); // smoke test: file parses, runs, exposes window.i18n.t
  } catch (e) {
    fail(`${dictRel}: ${e.message}`);
    continue;
  }
  const ja = Object.keys(dict.ja || {});
  const en = Object.keys(dict.en || {});
  const jaSet = new Set(ja);
  const enSet = new Set(en);
  for (const k of ja) if (!enSet.has(k)) fail(`${dictRel}: key "${k}" in JA but not EN`);
  for (const k of en) if (!jaSet.has(k)) fail(`${dictRel}: key "${k}" in EN but not JA`);
  console.log(`  ${dictRel}: ja=${ja.length} en=${en.length} keys (dict self-parity)`);
}

for (const g of groups) {
  let dict;
  try {
    dict = extractDict(g.dictRel);
  } catch (e) {
    fail(`${g.dictRel}: ${e.message}`);
    continue;
  }
  const used = new Set();
  for (const h of g.html) for (const k of htmlKeys(h)) used.add(k);
  for (const j of g.js) for (const k of jsKeys(j)) used.add(k);
  console.log(`  [${g.name}] ${used.size} referenced keys across ${g.html.length} html + ${g.js.length} js`);
  checkKeys(g.name, used, dict, g.dictRel);
}

if (failures > 0) {
  console.error(`\ni18n-parity: ${failures} failure(s).`);
  process.exit(1);
}
console.log('i18n-parity: OK');
