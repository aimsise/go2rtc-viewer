#!/usr/bin/env node
'use strict';
/*
 * no-real-secrets.js — fails if any git-tracked-candidate file contains a real
 * secret that the repo convention says must live ONLY in the gitignored .env:
 *
 *   - an RFC1918 private IPv4   (192.168.x.x / 10.x.x.x / 172.16-31.x.x)
 *   - a literal URL credential  (scheme://user:pass@) that is NOT an
 *     env-placeholder (${...}) and NOT a generic doc placeholder
 *   - an absolute home path     (/Users/<name> or /home/<name>)
 *
 * This mirrors .claude/hooks/secret-guard.py's allow/deny logic so the same
 * legitimate placeholders the guard permits (e.g. rtsp://${RTSP_USER}:
 * ${RTSP_PASS}@192.0.2.50, rtsp://user:pass@... doc examples) do NOT
 * false-positive here. RFC5737 doc IPs (192.0.2.x / 198.51.100.x / 203.0.113.x)
 * and loopback/wildcard (127.0.0.1 / 0.0.0.0) are intentionally NOT flagged.
 *
 * File set = exactly what git would commit on this checkout:
 *   tracked files (`git ls-files`) PLUS untracked-but-not-ignored files
 *   (`git ls-files --others --exclude-standard`). This respects .gitignore, so
 *   .env / cameras.json / logs / .playwright-cli / bin are excluded. The hook
 *   itself and the i18n/README files (which contain ALLOWED placeholders) are
 *   in-set and must stay clean.
 *
 * Dependency-free: Node built-ins (fs, path, child_process) + git.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// --- patterns ---------------------------------------------------------------
// RFC1918 private IPv4. 10/8 requires full 4 octets so versions like "10.2.3"
// aren't misread (matches the hook).
const PRIVATE_IP_RE =
  /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g;
// scheme://userinfo@  where userinfo has a colon (user:pass).
const URL_CRED_RE = /:\/\/([^/\s@'"`]+:[^/\s@'"`]+)@/g;
// Absolute home directory paths.
const HOME_PATH_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;

const PLACEHOLDER_WORDS = new Set([
  'user', 'pass', 'password', 'username', 'usr', 'pwd',
  '<user>', '<pass>', 'user_name', 'your_user', 'your_pass',
]);

// userinfo is an ALLOWED credential placeholder if it is an env form (${...})
// or every colon-separated part is a generic doc placeholder word.
function isAllowedCred(userinfo) {
  if (userinfo.includes('${')) return true;
  return userinfo.split(':').every((p) => PLACEHOLDER_WORDS.has(p.toLowerCase()));
}

// Binary media/archive extensions only. We deliberately do NOT skip by source
// extension (e.g. .ts could be TypeScript); any non-skipped file that is
// actually binary is caught by the NUL-byte check below.
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.flv', '.zip', '.gz',
  '.pyc', // bytecode left by `python3 -m py_compile` in an earlier CI step
]);

// --- collect candidate files -----------------------------------------------
function gitList(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

const tracked = gitList(['ls-files']);
const untracked = gitList(['ls-files', '--others', '--exclude-standard']);

// Path prefixes exempt from the scan. tests/ holds DELIBERATELY adversarial
// fixtures (e.g. secret-guard.sh feeds a fake 192.168.1.50 / admin:hunter2@ to
// prove the guard BLOCKS them) — those are test inputs, never app config, and
// must not trip this scan. They are fabricated, not real LAN values.
const EXEMPT_PREFIXES = ['tests/'];
const isExempt = (rel) => EXEMPT_PREFIXES.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p));

const files = [...new Set([...tracked, ...untracked])]
  .filter((rel) => !isExempt(rel))
  .sort();

if (files.length === 0) {
  console.error('no-real-secrets: could not enumerate git files (is this a git repo?)');
  process.exit(1);
}

// This test file itself contains example tokens (e.g. user:pass) in comments;
// they are all in the ALLOWED set, so it does not need self-exemption.
let findings = 0;
const report = (file, line, kind, text) => {
  findings++;
  console.error(`  FAIL: ${file}:${line}  [${kind}]  ${text}`);
};

let scanned = 0;
for (const rel of files) {
  if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
  const abs = path.join(ROOT, rel);
  let content;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) continue;
    content = fs.readFileSync(abs);
  } catch (_) {
    continue;
  }
  // Skip files with NUL bytes (binary).
  if (content.includes(0)) continue;
  const lines = content.toString('utf8').split('\n');
  scanned++;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    PRIVATE_IP_RE.lastIndex = 0;
    let m;
    while ((m = PRIVATE_IP_RE.exec(line)) !== null) {
      report(rel, ln, 'RFC1918 IP', m[0]);
    }

    URL_CRED_RE.lastIndex = 0;
    while ((m = URL_CRED_RE.exec(line)) !== null) {
      if (!isAllowedCred(m[1])) report(rel, ln, 'URL credential', `://${m[1]}@`);
    }

    HOME_PATH_RE.lastIndex = 0;
    while ((m = HOME_PATH_RE.exec(line)) !== null) {
      report(rel, ln, 'home path', m[0]);
    }
  }
}

console.log(`no-real-secrets: scanned ${scanned} text file(s) of ${files.length} candidate(s)`);
if (findings > 0) {
  console.error(`no-real-secrets: ${findings} finding(s) — real secrets must live ONLY in the gitignored .env.`);
  process.exit(1);
}
console.log('no-real-secrets: OK');
