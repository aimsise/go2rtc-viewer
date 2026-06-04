// ストリーム管理 — go2rtc の API を使う軽量フロントエンド
//
// 役割:
//   1) go2rtc (:1984) の REST API を読み書きしてストリームを管理する。
//      - GET  api/streams           一覧（producers / consumers を含む）
//      - GET  api               バージョン・設定パス
//      - PUT  api/streams?name=&src=  追加
//      - DELETE api/streams?src=       削除
//   2) 各ストリームをカードで表示（視聴者数・producer稼働・コーデック・ソース）。
//   3) 「視聴/情報/プローブ/リンク/ネット」は go2rtc の既存ページ/APIへリンク。
//   4) 再生モード（webrtc/mse/hls/mjpeg）を localStorage に保存し「視聴」URLへ反映。
//   5) 一覧は差分更新（カードを使い回し）してちらつきなく自動更新する。
//
// CORS: go2rtc 側 origin:"*" 設定により、:8000 から :1984 への GET/PUT/DELETE
//        （プリフライト含む）が許可されている。

'use strict';

// ── go2rtc ベースURLの解決（ビューアと同じ規則） ──
function resolveBase() {
  const q = sanitizeBase(new URLSearchParams(location.search).get('go2rtc'));
  if (q) return q;
  const host = location.hostname || 'localhost';
  return `http://${host}:1984`;
}

// 外部から渡されるベース URL（?go2rtc=）を検証する。スキームは http(s)、ホストは
// loopback か RFC1918 のプライベート LAN に限定し、外部オリジンの混入を防ぐ。
function sanitizeBase(candidate) {
  if (!candidate) return null;
  let u;
  try { u = new URL(String(candidate)); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!isLanOrLoopbackHost(u.hostname)) return null;
  return String(u.href).replace(/\/+$/, '');
}

function isLanOrLoopbackHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

const BASE = resolveBase();
const LS_MODES = 'seccam.modes';
const LS_TAB = 'seccam.tab';
const REFRESH_MS = 8000;
const LOG_POLL_MS = 3000;

const els = {
  grid: document.getElementById('stream-grid'),
  empty: document.getElementById('empty-state'),
  template: document.getElementById('card-template'),
  conn: document.getElementById('conn-status'),
  reload: document.getElementById('reload-btn'),
  modes: document.getElementById('modes'),
  addToggle: document.getElementById('add-toggle'),
  addForm: document.getElementById('add-form'),
  addCancel: document.getElementById('add-cancel'),
  addName: document.getElementById('af-name'),
  addSrc: document.getElementById('af-src'),
  addMsg: document.getElementById('add-msg'),
  version: document.getElementById('version-info'),
  linkGo2rtc: document.getElementById('link-go2rtc'),
  linkAdd: document.getElementById('link-add'),
  // タブ
  tabbar: document.querySelector('.tabbar'),
  tabs: [...document.querySelectorAll('.tab')],
  panels: {
    streams: document.getElementById('panel-streams'),
    config: document.getElementById('panel-config'),
    log: document.getElementById('panel-log'),
    net: document.getElementById('panel-net'),
  },
  // 設定タブ
  cfgEditor: document.getElementById('cfg-editor'),
  cfgStatus: document.getElementById('cfg-status'),
  cfgDirty: document.getElementById('cfg-dirty'),
  cfgSave: document.getElementById('cfg-save'),
  cfgReload: document.getElementById('cfg-reload'),
  cfgDownload: document.getElementById('cfg-download'),
  // ログタブ
  logView: document.getElementById('log-view'),
  logAuto: document.getElementById('log-auto'),
  logNewest: document.getElementById('log-newest'),
  logLevel: document.getElementById('log-level'),
  logSearch: document.getElementById('log-search'),
  logStatus: document.getElementById('log-status'),
  logRefresh: document.getElementById('log-refresh'),
  logCopy: document.getElementById('log-copy'),
  // ネットワークタブ
  netFrame: document.getElementById('net-frame'),
  netOpen: document.getElementById('net-open'),
  netOrigin: document.getElementById('net-origin'),
};

// name -> { el, refs } のカード管理（差分更新用）
const cards = new Map();

// ── ユーティリティ ──────────────────────────────────────
function api(path) {
  return new URL(path, BASE + '/').toString();
}

// rtsp://user:pass@host/... の資格情報を伏字化して表示用に。
// userinfo（パスワードに @ を含む場合も host 直前の @ まで）と、クエリ文字列中の
// 既知の機密キーの値の両方を伏字化する。
function redactCredentials(url) {
  if (!url) return url;
  let s = String(url);
  s = s.replace(/(\/\/)[^/]*@([^/@]+)/g, '$1•••@$2');
  s = s.replace(/([?&](?:password|passwd|pass|pwd|token|secret|secretkey|cred|credential|auth|apikey|api_key|key)=)[^&#\s]*/gi, '$1•••');
  return s;
}

// producers[].medias（"video, recvonly, H264" 等）からコーデック一覧を抽出。
function deriveCodecs(producers) {
  const out = [];
  const seen = new Set();
  for (const p of producers || []) {
    for (const m of p.medias || []) {
      const parts = String(m).split(',').map((s) => s.trim());
      if (parts.length < 2) continue;
      const kind = parts[0].toLowerCase();         // video / audio
      let codec = parts[parts.length - 1];          // "H264" / "PCMA/8000"
      codec = codec.split('/')[0].trim();
      if (!codec) continue;
      const key = kind + ':' + codec;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, codec });
    }
  }
  return out;
}

// 表示用ソース文字列（無ければ待機メッセージ）。
function sourceInfo(producers) {
  for (const p of producers || []) {
    if (p.url) return { text: redactCredentials(p.url), empty: false };
    if (p.source) return { text: redactCredentials(String(p.source).slice(0, 200)), empty: false };
  }
  return { text: window.i18n.t('mgmt.source.waiting'), empty: true };
}

function modeParam() {
  const checked = [...els.modes.querySelectorAll('input[type="checkbox"]')]
    .filter((i) => i.checked)
    .map((i) => i.name);
  return checked.join(',');
}

// ── 接続状態 ────────────────────────────────────────────
function setConn(kind, label) {
  els.conn.classList.remove(
    'conn-status--ok', 'conn-status--warn', 'conn-status--error', 'conn-status--unknown'
  );
  els.conn.classList.add(`conn-status--${kind}`);
  els.conn.querySelector('.conn-label').textContent = label;
}

// ── バージョン/設定パス ────────────────────────────────
async function loadVersion() {
  els.linkGo2rtc.href = api('');
  els.linkAdd.href = api('add.html');
  try {
    const res = await fetch(api('api'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const ver = info.version ? window.i18n.t('mgmt.version.prefix', { version: info.version }) : 'go2rtc';
    const cfg = info.config_path ? window.i18n.t('mgmt.version.configpath', { path: info.config_path }) : '';
    els.version.textContent = ver + cfg;
  } catch (_) {
    els.version.textContent = window.i18n.t('mgmt.version.error');
  }
}

// ── 一覧の取得と差分描画 ────────────────────────────────
async function loadStreams() {
  let data;
  try {
    const res = await fetch(api('api/streams'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    setConn('ok', window.i18n.t('common.go2rtc.connStatus.ok'));
  } catch (_) {
    setConn('error', window.i18n.t('common.go2rtc.connStatus.error'));
    return;
  }
  renderStreams(data && typeof data === 'object' ? data : {});
}

function renderStreams(data) {
  const names = Object.keys(data).sort();

  // 削除されたカードを撤去。
  for (const name of [...cards.keys()]) {
    if (!names.includes(name)) {
      cards.get(name).el.remove();
      cards.delete(name);
    }
  }

  // 追加・更新。
  for (const name of names) {
    let card = cards.get(name);
    if (!card) {
      card = createCard(name);
      cards.set(name, card);
      els.grid.appendChild(card.el);
    }
    updateCard(card, name, data[name] || {});
  }

  // グリッド内のカード順を names 順に整える（新規挿入時の並びズレ防止）。
  for (const name of names) {
    els.grid.appendChild(cards.get(name).el);
  }

  els.empty.hidden = names.length > 0;
}

function createCard(name) {
  const frag = els.template.content.cloneNode(true);
  const el = frag.querySelector('.stream-card');
  const refs = {
    el,
    name: el.querySelector('[data-role="name"]'),
    online: el.querySelector('[data-role="online"]'),
    onlineText: el.querySelector('[data-role="online-text"]'),
    statusText: el.querySelector('[data-role="status-text"]'),
    codecs: el.querySelector('[data-role="codecs"]'),
    source: el.querySelector('[data-role="source"]'),
    watch: el.querySelector('[data-role="watch"]'),
    info: el.querySelector('[data-role="info"]'),
    probe: el.querySelector('[data-role="probe"]'),
    links: el.querySelector('[data-role="links"]'),
    net: el.querySelector('[data-role="net"]'),
    del: el.querySelector('[data-role="delete"]'),
  };
  refs.del.addEventListener('click', () => deleteStream(name));
  window.i18n.apply(el);
  return { el, refs };
}

function updateCard(card, name, data) {
  const r = card.refs;
  const producers = Array.isArray(data.producers) ? data.producers : [];
  const consumers = Array.isArray(data.consumers) ? data.consumers : [];
  const online = consumers.length;
  const srcActive = producers.length > 0;

  r.name.textContent = name;

  // 視聴者バッジ
  r.onlineText.textContent = String(online);
  card.el.classList.toggle('is-watched', online > 0);

  // producer 稼働状態
  card.el.classList.toggle('is-active-src', srcActive);
  card.el.classList.toggle('is-idle-src', !srcActive);
  r.statusText.textContent = srcActive ? window.i18n.t('mgmt.card.status.active') : window.i18n.t('mgmt.card.status.idle');

  // コーデック
  const codecs = deriveCodecs(producers);
  r.codecs.replaceChildren();
  for (const c of codecs) {
    const chip = document.createElement('span');
    chip.className = 'codec-chip' + (c.kind === 'audio' ? ' is-audio' : '');
    chip.textContent = c.codec;
    chip.title = `${c.kind}: ${c.codec}`;
    r.codecs.appendChild(chip);
  }

  // ソース
  const si = sourceInfo(producers);
  r.source.textContent = si.text;
  r.source.classList.toggle('is-empty', si.empty);
  r.source.title = si.empty ? '' : si.text;

  // 各リンク
  const enc = encodeURIComponent(name);
  const mode = modeParam();
  r.watch.href = api(`stream.html?src=${enc}`) + (mode ? `&mode=${mode}` : '');
  r.info.href = api(`api/streams?src=${enc}`);
  r.probe.href = api(`api/streams?src=${enc}&video=all&audio=all&microphone`);
  r.links.href = api(`links.html?src=${enc}`);
  r.net.href = api(`net.html?src=${enc}`);
}

// 再生モード変更時、既存カードの「視聴」URLだけ貼り替える。
function refreshWatchLinks() {
  const mode = modeParam();
  for (const [name, card] of cards) {
    const enc = encodeURIComponent(name);
    card.refs.watch.href = api(`stream.html?src=${enc}`) + (mode ? `&mode=${mode}` : '');
  }
}

// ── 削除 ────────────────────────────────────────────────
async function deleteStream(name) {
  const ok = window.confirm(window.i18n.t('mgmt.delete.confirm', { name }));
  if (!ok) return;
  try {
    const res = await fetch(api(`api/streams?src=${encodeURIComponent(name)}`), { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    window.alert(window.i18n.t('mgmt.delete.error', { message: e && e.message ? e.message : e }));
  }
  await loadStreams();
}

// ── 追加 ────────────────────────────────────────────────
function showAddMsg(text, ok) {
  els.addMsg.textContent = text;
  els.addMsg.hidden = false;
  els.addMsg.classList.toggle('is-ok', !!ok);
  els.addMsg.classList.toggle('is-err', !ok);
}

async function submitAdd(e) {
  e.preventDefault();
  const name = els.addName.value.trim();
  const src = els.addSrc.value.trim();
  if (!name || !src) {
    showAddMsg(window.i18n.t('mgmt.add.error.required'), false);
    return;
  }
  const url = api(`api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`);
  try {
    const res = await fetch(url, { method: 'PUT' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showAddMsg(window.i18n.t('mgmt.add.success', { name }), true);
    els.addName.value = '';
    els.addSrc.value = '';
    await loadStreams();
  } catch (err) {
    showAddMsg(window.i18n.t('mgmt.add.error.failed', { message: err && err.message ? err.message : err }), false);
  }
}

function toggleAddForm(force) {
  const open = typeof force === 'boolean' ? force : els.addForm.hidden;
  els.addForm.hidden = !open;
  els.addToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    els.addMsg.hidden = true;
    els.addName.focus();
  }
}

// ── 再生モード（localStorage 永続化 + チップ表示） ──────
function syncModeChips() {
  for (const input of els.modes.querySelectorAll('input[type="checkbox"]')) {
    input.closest('.mode-chip').classList.toggle('is-on', input.checked);
  }
}

function loadModes() {
  let saved = null;
  try { saved = localStorage.getItem(LS_MODES); } catch (_) { /* noop */ }
  if (saved !== null) {
    const set = new Set(saved ? saved.split(',') : []);
    for (const input of els.modes.querySelectorAll('input[type="checkbox"]')) {
      input.checked = set.has(input.name);
    }
  }
  syncModeChips();
}

function saveModes() {
  try {
    const on = [...els.modes.querySelectorAll('input[type="checkbox"]')]
      .filter((i) => i.checked).map((i) => i.name).join(',');
    localStorage.setItem(LS_MODES, on);
  } catch (_) { /* noop */ }
}

// ───────────────────────────────────────────────────────────────────────────
// タブ切替（ストリーム / 設定 / ログ / ネットワーク）
// ───────────────────────────────────────────────────────────────────────────

let activeTab = 'streams';

function setTab(name, persist = true) {
  if (!els.panels[name]) name = 'streams';
  activeTab = name;
  for (const t of els.tabs) {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  }
  for (const [k, panel] of Object.entries(els.panels)) {
    if (panel) panel.hidden = (k !== name);
  }
  if (persist) { try { localStorage.setItem(LS_TAB, name); } catch (_) { /* noop */ } }

  // タブ固有の起動・停止
  if (name === 'config' && cfg.loaded === false) loadConfig();
  if (name === 'log') { renderLog(); startLogPoll(); } else { stopLogPoll(); }
  if (name === 'net') ensureNetFrame();
}

function initTabs() {
  els.tabbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) setTab(btn.dataset.tab);
  });
  let start = 'streams';
  try { start = localStorage.getItem(LS_TAB) || 'streams'; } catch (_) { /* noop */ }
  setTab(start, false);
}

// ───────────────────────────────────────────────────────────────────────────
// 設定タブ — go2rtc.yaml エディタ
//   GET  api/config  … 生 YAML を取得（コメント込み）
//   POST api/config  … リクエストボディを逐語でファイルへ書き込み（コメント保持）
//                       ※ PATCH は mergeYAML で再整形しコメントを壊すので絶対に使わない
//   POST api/restart … プロセス re-exec（保存後の反映に必要）
// ───────────────────────────────────────────────────────────────────────────

const cfg = { loaded: false, original: '', restarting: false };

function setCfgStatus(text, kind) {
  els.cfgStatus.textContent = text;
  els.cfgStatus.classList.toggle('is-ok', kind === 'ok');
  els.cfgStatus.classList.toggle('is-err', kind === 'err');
}

function cfgMarkDirty() {
  const dirty = els.cfgEditor.value !== cfg.original;
  els.cfgDirty.hidden = !dirty;
  els.cfgSave.disabled = !dirty || cfg.restarting;
}

async function loadConfig() {
  setCfgStatus(window.i18n.t('mgmt.cfg.status.loading'), null);
  els.cfgEditor.disabled = true;
  try {
    const res = await fetch(api('api/config'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    els.cfgEditor.value = text;
    cfg.original = text;
    cfg.loaded = true;
    setCfgStatus(window.i18n.t('mgmt.cfg.status.loaded'), 'ok');
  } catch (e) {
    setCfgStatus(window.i18n.t('mgmt.cfg.status.loadError', { message: e && e.message ? e.message : e }), 'err');
  } finally {
    els.cfgEditor.disabled = false;
    cfgMarkDirty();
  }
}

async function saveConfig() {
  // textarea の値を逐語送信。Content-Type を付けない（text/plain の単純リクエスト→
  // プリフライト不要）。JSON 化・フォーム化は厳禁（go2rtc は生バイトを書き込むため）。
  const body = els.cfgEditor.value;
  setCfgStatus(window.i18n.t('mgmt.cfg.status.saving'), null);
  els.cfgSave.disabled = true;
  try {
    const res = await fetch(api('api/config'), { method: 'POST', body });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    cfg.original = body;
    cfgMarkDirty();
    setCfgStatus(window.i18n.t('mgmt.cfg.status.saved'), 'ok');
    if (window.confirm(window.i18n.t('mgmt.cfg.restart.confirm'))) {
      await restartGo2rtc();
    } else {
      setCfgStatus(window.i18n.t('mgmt.cfg.status.savedNotApplied'), 'ok');
    }
  } catch (e) {
    setCfgStatus(window.i18n.t('mgmt.cfg.status.saveError', { message: e && e.message ? e.message : e }), 'err');
    cfgMarkDirty();
  }
}

async function restartGo2rtc() {
  cfg.restarting = true;
  setConn('warn', window.i18n.t('mgmt.conn.restarting'));
  showRestartBanner(true);
  try { await fetch(api('api/restart'), { method: 'POST' }); } catch (_) { /* 切断は想定内 */ }
  // 復帰までポーリング（re-exec に 1〜3 秒程度）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const r = await fetch(api('api/streams'), { cache: 'no-cache' });
      if (r.ok) break;
    } catch (_) { /* まだ起動中 */ }
  }
  cfg.restarting = false;
  showRestartBanner(false);
  await loadConfig();
  await loadStreams();
  setCfgStatus(window.i18n.t('mgmt.cfg.status.restarted'), 'ok');
}

function showRestartBanner(on) {
  let b = document.getElementById('cfg-restart-banner');
  if (on && !b) {
    b = document.createElement('div');
    b.id = 'cfg-restart-banner';
    b.className = 'cfg-restart';
    b.textContent = window.i18n.t('mgmt.cfg.restart.banner');
    els.panels.config.insertBefore(b, els.panels.config.querySelector('.cfg-warn'));
  } else if (!on && b) {
    b.remove();
  }
}

function downloadConfig() {
  const blob = new Blob([els.cfgEditor.value], { type: 'application/yaml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `go2rtc-${ts}.yaml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ───────────────────────────────────────────────────────────────────────────
// ログタブ — GET api/log（JSON-lines）をポーリング
// ───────────────────────────────────────────────────────────────────────────

const LEVEL_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
let logTimer = null;
let logRaw = []; // パース済みの行（oldest→newest）

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

async function fetchLog() {
  try {
    const res = await fetch(api('api/log'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch (_) { /* 壊れ行は無視 */ }
    }
    logRaw = rows;
    els.logStatus.textContent = window.i18n.t('mgmt.log.status.count', { count: rows.length, time: fmtTime(Date.now()) });
    renderLog();
  } catch (_) {
    els.logStatus.textContent = window.i18n.t('mgmt.log.status.error');
  }
}

function renderLog() {
  if (!els.logView) return;
  const min = LEVEL_RANK[els.logLevel.value] ?? 0;
  const q = els.logSearch.value.trim().toLowerCase();
  // 再描画前に「末尾に張り付いているか」を判定（自動スクロール用）
  const pinned = els.logView.scrollHeight - els.logView.scrollTop - els.logView.clientHeight < 24;

  let rows = logRaw.filter((o) => (LEVEL_RANK[o.level] ?? 2) >= min);
  if (q) rows = rows.filter((o) => JSON.stringify(o).toLowerCase().includes(q));
  if (els.logNewest.checked) rows = rows.slice().reverse();

  const frag = document.createDocumentFragment();
  for (const o of rows) {
    const row = document.createElement('div');
    row.className = `log-row lv-${o.level || 'info'}`;
    const t = document.createElement('span'); t.className = 'log-time'; t.textContent = fmtTime(o.time);
    const lv = document.createElement('span'); lv.className = 'log-lvl'; lv.textContent = o.level || 'info';
    const msg = document.createElement('span'); msg.className = 'log-msg'; msg.textContent = o.message || '';
    // level / time / message 以外を key=value で添える
    const ctx = document.createElement('span'); ctx.className = 'log-ctx';
    for (const [k, v] of Object.entries(o)) {
      if (k === 'level' || k === 'time' || k === 'message') continue;
      const chip = document.createElement('span');
      if (k === 'error') chip.className = 'is-err';
      const b = document.createElement('b'); b.textContent = ` ${k}=`;
      chip.append(b, document.createTextNode(String(v)));
      ctx.appendChild(chip);
    }
    msg.appendChild(ctx);
    row.append(t, lv, msg);
    frag.appendChild(row);
  }
  els.logView.replaceChildren(frag);
  if (rows.length === 0) {
    const e = document.createElement('div');
    e.className = 'log-empty';
    e.textContent = window.i18n.t('mgmt.log.empty');
    els.logView.appendChild(e);
  }
  // 古い順表示かつ末尾固定中のみ自動スクロール
  if (!els.logNewest.checked && pinned) els.logView.scrollTop = els.logView.scrollHeight;
}

function startLogPoll() {
  fetchLog();
  stopLogPoll();
  logTimer = setInterval(() => {
    if (document.hidden) return;
    if (activeTab !== 'log') return;
    if (!els.logAuto.checked) return;
    fetchLog();
  }, LOG_POLL_MS);
}

function stopLogPoll() {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
}

function copyLog() {
  const text = [...els.logView.querySelectorAll('.log-row')].map((r) => r.textContent.trim()).join('\n');
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

// ───────────────────────────────────────────────────────────────────────────
// ネットワークタブ — go2rtc net.html を iframe で遅延ロード
// ───────────────────────────────────────────────────────────────────────────

let netLoaded = false;
function ensureNetFrame() {
  const url = api('net.html');
  els.netOpen.href = url;
  els.netOrigin.textContent = BASE.replace(/^https?:\/\//, '');
  if (!netLoaded) { els.netFrame.src = url; netLoaded = true; }
}

// ── 自動更新（入力中・非表示・ストリームタブ以外では休止） ──────────────────
function startAutoRefresh() {
  setInterval(() => {
    if (document.hidden) return;
    if (activeTab !== 'streams') return;   // ストリームタブ表示中のみ更新
    if (!els.addForm.hidden) return;       // 追加フォームを開いている間は触らない
    loadStreams();
  }, REFRESH_MS);
}

// ── 初期化 ──────────────────────────────────────────────
function init() {
  loadModes();

  els.reload.addEventListener('click', () => { loadVersion(); loadStreams(); });

  els.modes.addEventListener('change', () => {
    syncModeChips();
    saveModes();
    refreshWatchLinks();
  });

  els.addToggle.addEventListener('click', () => toggleAddForm());
  els.addCancel.addEventListener('click', () => toggleAddForm(false));
  els.addForm.addEventListener('submit', submitAdd);

  // 設定タブ
  els.cfgEditor.addEventListener('input', cfgMarkDirty);
  els.cfgSave.addEventListener('click', saveConfig);
  els.cfgReload.addEventListener('click', () => {
    if (els.cfgEditor.value !== cfg.original &&
        !window.confirm(window.i18n.t('mgmt.cfg.reload.confirm'))) return;
    loadConfig();
  });
  els.cfgDownload.addEventListener('click', downloadConfig);

  // ログタブ
  els.logRefresh.addEventListener('click', fetchLog);
  els.logCopy.addEventListener('click', copyLog);
  for (const el of [els.logLevel, els.logSearch, els.logNewest, els.logAuto]) {
    el.addEventListener('input', renderLog);
  }

  // 未保存の設定があるままのページ離脱を警告
  window.addEventListener('beforeunload', (e) => {
    if (cfg.loaded && els.cfgEditor.value !== cfg.original) { e.preventDefault(); e.returnValue = ''; }
  });

  // 言語切替時、t() で動的に組み立てた文字列（バージョン・接続状態・カードの状態/
  // ソース・ログ）を即座に再描画する。data-i18n の静的要素は i18n.js が再走査する。
  window.i18n.onChange(() => {
    loadVersion();
    loadStreams();
    if (activeTab === 'log') renderLog();
  });

  loadVersion();
  loadStreams();
  startAutoRefresh();
  initTabs();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
