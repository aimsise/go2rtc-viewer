// 録画 検索・閲覧 — フロントエンド ロジック
//
// 役割:
//   1) 録画バックエンド（既定 :3914）の /api/recordings/* を fetch。
//   2) 日付ピッカー + 時刻 + チャンネル/種別の選択で録画を検索。
//   3) 結果を「リスト」と「簡易タイムライン」で表示。
//   4) 各録画を <video> でモーダル再生（/api/recordings/clip.mp4）、
//      または MP4 ダウンロード（/api/recordings/download?format=mp4）。
//
// バックエンドAPI（このフロントが期待する契約）:
//   GET  /api/recordings/health
//        → 200 で疎通OK（本文は任意）。接続状態バッジに使用。
//   GET  /api/recordings/channels
//        → { maxChannels:<n>, channels:[ { index:<0起点>, name?, online?, recording? } ] }
//   GET  /api/recordings/search?date=YYYY-MM-DD&begin=HH:MM:SS&end=HH:MM:SS
//                              &channels=0,1,2&types=Timing,Motion,Alarm,Manual
//        → { ok:true, count:<n>, source?:"dvr"|"local", message?:<string>,
//             items:[ { id?, channel:<0起点>, start:<Unix秒>, end:<Unix秒>,
//                       duration?:<秒>, type?:<bit>, types?:[<名称>], sizeBytes?:<n> } ] }
//        ※ start/end は録画ItemのTimeStart/TimeEnd（Unix秒）。recon仕様準拠。
//   GET  /api/recordings/clip.mp4?<同じ録画特定パラメータ>
//        → 再生可能な MP4（<video> の src）。
//   GET  /api/recordings/download?<同じ録画特定パラメータ>&format=mp4
//        → attachment（ダウンロード）。
//
// 録画の特定パラメータ（clip.mp4 / download 共通）:
//   id があれば id=<id>、無ければ channel/begin/end（Unix秒）で範囲指定。
//   recon: DVR の録画ch番号は0起点（UIは +1 して表示）。

'use strict';

// ───────────────────────────────────────────────────────────────────────────
// バックエンド ベースURL の解決
// ───────────────────────────────────────────────────────────────────────────
//
// このページは録画バックエンド（server.js）が静的配信する想定だが、
// file:// や別ポートの静的サーバから開いても動くよう、API origin を解決する。
// 優先順位:
//   1) URL クエリ ?api=http://host:3914
//   2) 同一オリジン（http(s) で開かれていれば location.origin）
//   3) 既定: 現在のホスト名 + :3914
const DEFAULT_API_PORT = 3914;

function resolveApiBase() {
  const q = sanitizeBase(new URLSearchParams(location.search).get('api'));
  if (q) return q;

  // http(s) の同一オリジンで配信されているならそれを使う。
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    if (location.origin && location.origin !== 'null') {
      return stripTrailingSlash(location.origin);
    }
  }

  // file:// 等で開いた場合は hostname が空 → localhost にフォールバック。
  const host = location.hostname || 'localhost';
  return `http://${host}:${DEFAULT_API_PORT}`;
}

function stripTrailingSlash(s) {
  return String(s).replace(/\/+$/, '');
}

// 外部から渡されるベース URL（?api=）を検証する。スキームは http(s)、ホストは
// loopback か RFC1918 のプライベート LAN に限定し、外部オリジンの混入を防ぐ。
function sanitizeBase(candidate) {
  if (!candidate) return null;
  let u;
  try { u = new URL(String(candidate)); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!isLanOrLoopbackHost(u.hostname)) return null;
  return stripTrailingSlash(u.href);
}

function isLanOrLoopbackHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function apiUrl(path, params) {
  const u = new URL(path.replace(/^\//, ''), state.apiBase + '/');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

// ───────────────────────────────────────────────────────────────────────────
// 録画種別（recon: Type ビットマスク {1:Timing,2:Motion,4:Alarm,8:Manual}）
// ───────────────────────────────────────────────────────────────────────────
const TYPE_BITS = [
  { name: 'Timing', bit: 1, label: '定時', cls: 'timing' },
  { name: 'Motion', bit: 2, label: '動体', cls: 'motion' },
  { name: 'Alarm', bit: 4, label: 'アラーム', cls: 'alarm' },
  { name: 'Manual', bit: 8, label: '手動', cls: 'manual' },
];

const TYPE_BY_NAME = new Map(TYPE_BITS.map((t) => [t.name.toLowerCase(), t]));

// 録画の種別を「{cls,label,name} の配列」に正規化する。
//   - item.types: 名称配列（["Motion", ...]）を優先
//   - item.type:  ビット値（整数）からデコード
function resolveItemTypes(item) {
  const out = [];
  if (Array.isArray(item.types) && item.types.length) {
    for (const n of item.types) {
      const t = TYPE_BY_NAME.get(String(n).toLowerCase());
      if (t) out.push(t);
    }
  }
  if (!out.length && (item.type !== undefined && item.type !== null)) {
    const bits = Number(item.type) || 0;
    for (const t of TYPE_BITS) {
      if (bits & t.bit) out.push(t);
    }
  }
  return out;
}

// 単一の代表種別（タイムラインの色分け用）。複数なら優先度 Alarm>Motion>Manual>Timing。
function dominantType(types) {
  if (!types.length) return TYPE_BITS[0]; // 既定: Timing 色
  const priority = ['alarm', 'motion', 'manual', 'timing'];
  for (const p of priority) {
    const hit = types.find((t) => t.cls === p);
    if (hit) return hit;
  }
  return types[0];
}

// ───────────────────────────────────────────────────────────────────────────
// 状態
// ───────────────────────────────────────────────────────────────────────────
const state = {
  apiBase: null,
  channels: [], // [ { index, name, online, recording } ]
  maxChannels: 0,
  items: [], // 直近の検索結果（正規化済み）
  // i18n 再翻訳のための直近コンテキスト（言語切替時に画面を作り直す）。
  lastConn: { kind: 'unknown', key: 'common.connStatus.checking', vars: null },
  lastPayload: null, // 直近検索のレスポンス
  lastRange: null, // 直近検索の { date, begin, end }
  lastStatus: null, // 直近の状態パネル { kind, titleFn, descFn }
  openItem: null, // 再生モーダルで開いている録画（言語切替時の再翻訳用）
};

// ───────────────────────────────────────────────────────────────────────────
// DOM 参照
// ───────────────────────────────────────────────────────────────────────────
const els = {
  connStatus: document.getElementById('conn-status'),

  form: document.getElementById('search-form'),
  dateInput: document.getElementById('date-input'),
  beginInput: document.getElementById('begin-input'),
  endInput: document.getElementById('end-input'),
  channelChips: document.getElementById('channel-chips'),
  typeChips: document.getElementById('type-chips'),
  searchBtn: document.getElementById('search-btn'),
  todayBtn: document.getElementById('today-btn'),

  resultBar: document.getElementById('result-bar'),
  resultSummary: document.getElementById('result-summary'),
  resultSource: document.getElementById('result-source'),

  timelineSection: document.getElementById('timeline-section'),
  timeline: document.getElementById('timeline'),
  timelineAxis: document.getElementById('timeline-axis'),

  statusPanel: document.getElementById('status-panel'),
  statusSpinner: document.querySelector('#status-panel [data-role="spinner"]'),
  statusTitle: document.querySelector('#status-panel [data-role="status-title"]'),
  statusDesc: document.querySelector('#status-panel [data-role="status-desc"]'),

  listSection: document.getElementById('list-section'),
  recordList: document.getElementById('record-list'),
  rowTemplate: document.getElementById('record-row-template'),

  // 再生モーダル
  modal: document.getElementById('player-modal'),
  modalBackdrop: document.querySelector('#player-modal [data-role="backdrop"]'),
  modalTitle: document.getElementById('player-title'),
  modalVideo: document.getElementById('player-video'),
  modalDownload: document.getElementById('player-download'),
  modalClose: document.getElementById('player-close'),
  modalOverlay: document.querySelector('#player-modal [data-role="player-overlay"]'),
  modalOverlayText: document.querySelector('#player-modal [data-role="player-overlay-text"]'),
};

// ───────────────────────────────────────────────────────────────────────────
// 接続状態バッジ
// ───────────────────────────────────────────────────────────────────────────
async function updateConnectionStatus() {
  setConnStatus('unknown', 'common.connStatus.checking');
  try {
    const res = await fetch(apiUrl('/api/recordings/health'), { cache: 'no-cache' });
    if (res.ok) {
      setConnStatus('ok', 'rec.connStatus.ok');
    } else {
      setConnStatus('warn', 'rec.connStatus.warn', { status: res.status });
    }
  } catch (_) {
    setConnStatus('error', 'rec.connStatus.error');
  }
}

// key + vars を保持し、言語切替時に再翻訳できるようにする。
function setConnStatus(kind, key, vars) {
  state.lastConn = { kind: kind, key: key, vars: vars || null };
  const el = els.connStatus;
  el.classList.remove(
    'conn-status--ok',
    'conn-status--warn',
    'conn-status--error',
    'conn-status--unknown'
  );
  el.classList.add(`conn-status--${kind}`);
  el.querySelector('.conn-label').textContent = window.i18n.t(key, vars);
}

// ───────────────────────────────────────────────────────────────────────────
// チャンネル チップ
// ───────────────────────────────────────────────────────────────────────────
async function loadChannels() {
  let data = null;
  try {
    const res = await fetch(apiUrl('/api/recordings/channels'), { cache: 'no-cache' });
    if (res.ok) data = await res.json();
  } catch (err) {
    console.warn('channels の取得に失敗。既定 9ch にフォールバック:', err);
  }

  let channels = [];
  let maxChannels = 0;

  if (data) {
    maxChannels = Number(data.maxChannels) || 0;
    if (Array.isArray(data.channels)) {
      channels = data.channels.map((c, i) => normalizeChannel(c, i));
    }
  }

  // フォールバック: recon の MAX_CHN=9（ch0 のみ接続）。
  if (!channels.length) {
    const n = maxChannels || 9;
    channels = Array.from({ length: n }, (_, i) => ({
      index: i,
      name: '',
      online: i === 0, // recon: ch0 のみ接続
      recording: i === 0,
    }));
    maxChannels = n;
  }

  state.channels = channels;
  state.maxChannels = maxChannels || channels.length;
  renderChannelChips();
}

function normalizeChannel(c, i) {
  if (typeof c === 'number') return { index: c, name: '', online: false, recording: false };
  const index = Number(c.index ?? c.channel ?? c.ch ?? i);
  return {
    index: Number.isFinite(index) ? index : i,
    name: c.name || c.title || '',
    online: Boolean(c.online ?? c.connected ?? c.bcamOnline),
    recording: Boolean(c.recording ?? c.recordingState),
  };
}

function renderChannelChips() {
  els.channelChips.replaceChildren();

  for (const ch of state.channels) {
    const label = document.createElement('label');
    label.className = 'chip chip--channel';
    if (ch.online) label.classList.add('is-online');
    if (ch.recording) label.classList.add('is-recording');

    const title = [];
    if (ch.online) title.push(window.i18n.t('rec.chip.online.title'));
    if (ch.recording) title.push(window.i18n.t('rec.chip.recording.title'));
    if (title.length) label.title = title.join(' / ');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(ch.index);
    // 既定で接続chをチェック。接続情報が無ければ全ch（ch0=最初）をチェック。
    input.checked = ch.online || state.channels.every((c) => !c.online);
    input.dataset.role = 'channel';

    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    // recon: UI は Number(Channel)+1 で表示（ch番号は0起点）。
    text.textContent = ch.name ? `${ch.name}` : `ch${ch.index + 1}`;

    label.append(input, dot, text);
    els.channelChips.appendChild(label);
  }

  // どれもチェックされていない場合に備え、最低 1 つ（ch0）を選択。
  const anyChecked = getSelectedChannels().length > 0;
  if (!anyChecked) {
    const first = els.channelChips.querySelector('input[data-role="channel"]');
    if (first) first.checked = true;
  }
}

function getSelectedChannels() {
  return Array.from(
    els.channelChips.querySelectorAll('input[data-role="channel"]:checked')
  ).map((el) => el.value);
}

function getSelectedTypes() {
  return Array.from(
    els.typeChips.querySelectorAll('input[type="checkbox"]:checked')
  ).map((el) => el.value);
}

// ───────────────────────────────────────────────────────────────────────────
// 検索
// ───────────────────────────────────────────────────────────────────────────
async function runSearch() {
  const date = els.dateInput.value;
  if (!date) {
    setStatus('error', () => window.i18n.t('rec.search.err.noDate.title'), () => window.i18n.t('rec.search.err.noDate.desc'));
    return;
  }

  const channels = getSelectedChannels();
  if (!channels.length) {
    setStatus('error', () => window.i18n.t('rec.search.err.noChannel.title'), () => window.i18n.t('rec.search.err.noChannel.desc'));
    return;
  }

  const types = getSelectedTypes();
  const begin = normalizeTime(els.beginInput.value, '00:00:00');
  const end = normalizeTime(els.endInput.value, '23:59:59');

  // UI を検索中状態に。
  setBusy(true);
  hide(els.resultBar);
  hide(els.timelineSection);
  hide(els.listSection);
  setStatus(
    'loading',
    () => window.i18n.t('rec.search.loading.title'),
    () => window.i18n.t('rec.search.loading.desc', { date: date, ch: channels.length })
  );

  const params = {
    date,
    begin,
    end,
    channels: channels.join(','),
    types: types.join(','),
  };

  let payload;
  try {
    const res = await fetch(apiUrl('/api/recordings/search', params), { cache: 'no-cache' });
    const text = await res.text();
    payload = text ? safeJson(text) : null;

    if (!res.ok) {
      const msg =
        (payload && (payload.message || payload.error || payload.RetDetail)) ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }
  } catch (err) {
    console.error('search 失敗:', err);
    const searchErr = err;
    setStatus(
      'error',
      () => window.i18n.t('rec.search.err.failed.title'),
      () => window.i18n.t('rec.search.err.failed.desc', { err: describeError(searchErr), base: state.apiBase })
    );
    setBusy(false);
    return;
  }

  setBusy(false);

  const items = normalizeItems(payload);
  state.items = items;
  // 言語切替時の再描画用に直近の検索コンテキストを保持。
  state.lastPayload = payload;
  state.lastRange = { date, begin, end };

  renderResultBar(payload, items, { date, begin, end });

  if (!items.length) {
    setStatus(
      'empty',
      () => window.i18n.t('rec.search.empty.title'),
      () => buildEmptyHint(payload)
    );
    hide(els.timelineSection);
    hide(els.listSection);
    return;
  }

  state.lastStatus = null;
  hide(els.statusPanel);
  renderTimeline(items, { date, begin, end });
  renderList(items);
}

// バックエンドの応答を [ { channel, start, end, duration, types[], sizeBytes, id?, params } ] に正規化。
function normalizeItems(payload) {
  if (!payload) return [];
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.Item)
    ? payload.Item
    : [];

  return rawItems
    .map((raw, i) => normalizeOneItem(raw, i))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.channel - b.channel);
}

function normalizeOneItem(raw, i) {
  if (!raw || typeof raw !== 'object') return null;

  // recon: Channel は0起点。バックエンド(server.js)は `chn` で返す。
  // 生の DVR レスポンス(Channel)や別実装(channel/ch)も許容。
  const channel = Number(raw.chn ?? raw.channel ?? raw.Channel ?? raw.ch ?? 0) || 0;

  // recon: TimeStart/TimeEnd は Unix秒。バックエンドは begin/end。
  const start = Number(raw.start ?? raw.begin ?? raw.TimeStart ?? raw.beginTime);
  const end = Number(raw.end ?? raw.TimeEnd ?? raw.endTime ?? (start + (Number(raw.durationSec ?? raw.duration) || 0)));
  if (!Number.isFinite(start)) return null;

  // バックエンドは durationSec で返す（duration も許容）。
  const rawDur = raw.durationSec ?? raw.duration;
  const duration = Number.isFinite(Number(rawDur))
    ? Number(rawDur)
    : Number.isFinite(end)
    ? Math.max(0, end - start)
    : 0;

  const types = resolveItemTypes(raw);
  const sizeBytes = Number(raw.sizeBytes ?? raw.size ?? raw.bytes);

  const id = raw.id ?? raw.recordId ?? raw.key ?? null;

  return {
    id,
    channel,
    start,
    end: Number.isFinite(end) ? end : start + duration,
    duration,
    types,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    raw,
  };
}

// clip.mp4 / download の録画特定パラメータを作る。
function clipParams(item) {
  if (item.id !== null && item.id !== undefined && item.id !== '') {
    return { id: String(item.id) };
  }
  return {
    channel: String(item.channel),
    begin: String(item.start),
    end: String(item.end),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 結果メタバー
// ───────────────────────────────────────────────────────────────────────────
function renderResultBar(payload, items, range) {
  const count = items.length;
  els.resultSummary.textContent =
    count > 0
      ? window.i18n.t('rec.result.summary.some', { count: count, date: range.date, begin: range.begin, end: range.end })
      : window.i18n.t('rec.result.summary.none', { date: range.date, begin: range.begin, end: range.end });

  const source = payload && (payload.source || payload.Source);
  els.resultSource.classList.remove('result-source--dvr', 'result-source--local');
  if (source) {
    const s = String(source).toLowerCase();
    if (s.includes('dvr') || s.includes('xvr') || s.includes('netsdk') || s.includes('onvif')) {
      els.resultSource.textContent = window.i18n.t('rec.source.dvr');
      els.resultSource.classList.add('result-source--dvr');
    } else if (s.includes('local') || s.includes('rtsp') || s.includes('ffmpeg')) {
      els.resultSource.textContent = window.i18n.t('rec.source.local');
      els.resultSource.classList.add('result-source--local');
    } else {
      els.resultSource.textContent = String(source);
    }
    els.resultSource.hidden = false;
  } else {
    els.resultSource.hidden = true;
  }

  show(els.resultBar);
}

function buildEmptyHint(payload) {
  const msg = payload && (payload.message || payload.note || payload.RetDetail);
  const base = window.i18n.t('rec.empty.hint.base');
  if (msg) return window.i18n.t('rec.empty.hint.backend', { base: base, msg: msg });
  return window.i18n.t('rec.empty.hint.retry', { base: base });
}

// ───────────────────────────────────────────────────────────────────────────
// タイムライン（チャンネル別・選択時間帯を 100% としたバー）
// ───────────────────────────────────────────────────────────────────────────
function renderTimeline(items, range) {
  // タイムラインの範囲は「検索した時間帯」を使う（その日の begin〜end）。
  const span = computeRangeEpoch(range);
  const total = Math.max(1, span.endEpoch - span.beginEpoch);

  // 出現したチャンネルを昇順で。
  const channels = Array.from(new Set(items.map((it) => it.channel))).sort((a, b) => a - b);

  els.timeline.replaceChildren();

  for (const ch of channels) {
    const row = document.createElement('div');
    row.className = 'timeline-row';
    row.setAttribute('role', 'listitem');

    const label = document.createElement('span');
    label.className = 'timeline-row-label';
    label.textContent = `ch${ch + 1}`; // recon: 0起点 → +1 表示

    const track = document.createElement('div');
    track.className = 'timeline-track';
    track.setAttribute('aria-label', `ch${ch + 1} の録画`);

    for (const it of items.filter((x) => x.channel === ch)) {
      const segStart = Math.max(it.start, span.beginEpoch);
      const segEnd = Math.min(it.end, span.endEpoch);
      if (segEnd <= segStart) continue;

      const left = ((segStart - span.beginEpoch) / total) * 100;
      const width = ((segEnd - segStart) / total) * 100;

      const seg = document.createElement('button');
      seg.type = 'button';
      const dom = dominantType(it.types);
      seg.className = `timeline-seg timeline-seg--${dom.cls}`;
      seg.style.left = `${left}%`;
      seg.style.width = `${Math.max(width, 0.4)}%`;
      seg.title = window.i18n.t('rec.timeline.seg.title', {
        ch: ch + 1,
        start: fmtClock(it.start),
        end: fmtClock(it.end),
        dur: fmtDuration(it.duration),
      });
      seg.setAttribute(
        'aria-label',
        window.i18n.t('rec.timeline.seg.aria', {
          ch: ch + 1,
          start: fmtClock(it.start),
          dur: fmtDuration(it.duration),
        })
      );
      seg.addEventListener('click', () => openPlayer(it));
      track.appendChild(seg);
    }

    row.append(label, track);
    els.timeline.appendChild(row);
  }

  renderTimelineAxis(span);
  show(els.timelineSection);
}

function renderTimelineAxis(span) {
  els.timelineAxis.replaceChildren();
  const ticks = document.createElement('div');
  ticks.className = 'timeline-axis-ticks';

  const total = Math.max(1, span.endEpoch - span.beginEpoch);
  // おおよそ 6〜8 本の目盛りを「キリの良い時刻」で。
  const TICK_COUNT = 6;
  for (let i = 0; i <= TICK_COUNT; i++) {
    const epoch = span.beginEpoch + (total * i) / TICK_COUNT;
    const pct = (i / TICK_COUNT) * 100;
    const tick = document.createElement('span');
    tick.className = 'timeline-tick';
    tick.style.left = `${pct}%`;
    tick.textContent = fmtClockHM(epoch);
    ticks.appendChild(tick);
  }
  els.timelineAxis.appendChild(ticks);
}

// 検索範囲（date + begin/end 時刻）を Unix秒(ローカル)に変換。
function computeRangeEpoch(range) {
  const beginEpoch = epochFromDateTime(range.date, range.begin);
  let endEpoch = epochFromDateTime(range.date, range.end);
  // end <= begin の場合（例: 終了が翌日に回り込む指定）は +1 日扱いにしておく。
  if (endEpoch <= beginEpoch) endEpoch = beginEpoch + 86400;
  return { beginEpoch, endEpoch };
}

// ───────────────────────────────────────────────────────────────────────────
// 録画リスト
// ───────────────────────────────────────────────────────────────────────────
function renderList(items) {
  els.recordList.replaceChildren();

  for (const it of items) {
    const frag = els.rowTemplate.content.cloneNode(true);
    const row = frag.querySelector('.record-row');

    row.querySelector('[data-role="ch"]').textContent = String(it.channel + 1);
    row.querySelector('[data-role="start"]').textContent = fmtDateTime(it.start);
    row.querySelector('[data-role="end"]').textContent = fmtDateTime(it.end);
    row.querySelector('[data-role="dur"]').textContent = fmtDuration(it.duration);
    row.querySelector('[data-role="size"]').textContent =
      it.sizeBytes !== null ? fmtSize(it.sizeBytes) : '—';

    // 種別バッジ
    const typeCell = row.querySelector('[data-role="type"]');
    typeCell.replaceChildren(buildTypeBadges(it.types));

    // 再生
    row.querySelector('[data-role="play"]').addEventListener('click', () => openPlayer(it));

    // ダウンロード（直リンク: バックエンドが Content-Disposition: attachment を返す前提）
    const dl = row.querySelector('[data-role="download"]');
    dl.href = apiUrl('/api/recordings/download', { ...clipParams(it), format: 'mp4' });
    dl.setAttribute('download', buildClipFilename(it));

    // クローンした行内の data-i18n 要素（再生/DL ボタンの title/text）を
    // 現在の言語へ翻訳する（<template> の内容は初期 apply の走査対象外のため）。
    window.i18n.apply(row);

    els.recordList.appendChild(row);
  }

  show(els.listSection);
}

function buildTypeBadges(types) {
  const wrap = document.createElement('span');
  wrap.className = 'type-badges';
  if (!types.length) {
    const b = document.createElement('span');
    b.className = 'type-badge';
    b.textContent = '—';
    wrap.appendChild(b);
    return wrap;
  }
  for (const t of types) {
    const b = document.createElement('span');
    b.className = `type-badge type-badge--${t.cls}`;
    b.textContent = window.i18n.t(`rec.type.${t.cls}`);
    wrap.appendChild(b);
  }
  return wrap;
}

// ───────────────────────────────────────────────────────────────────────────
// 再生モーダル
// ───────────────────────────────────────────────────────────────────────────
function openPlayer(item) {
  state.openItem = item; // 言語切替時にモーダル見出しを再翻訳するため保持。
  const title = window.i18n.t('rec.player.title', {
    ch: item.channel + 1,
    start: fmtDateTime(item.start),
    end: fmtClock(item.end),
    dur: fmtDuration(item.duration),
  });
  els.modalTitle.textContent = title;

  const params = clipParams(item);
  const clipSrc = apiUrl('/api/recordings/clip.mp4', params);

  // ダウンロードリンク（モーダル内）
  els.modalDownload.href = apiUrl('/api/recordings/download', { ...params, format: 'mp4' });
  els.modalDownload.setAttribute('download', buildClipFilename(item));

  // 再生エラー時のオーバーレイ
  hideOverlay();
  els.modalVideo.onerror = () => {
    showOverlay(window.i18n.t('rec.player.error.overlay'));
  };
  els.modalVideo.onloadeddata = hideOverlay;

  els.modalVideo.src = clipSrc;
  els.modalVideo.load();

  openModal();

  // 自動再生（ブラウザがブロックする場合は controls で手動再生可能）。
  const p = els.modalVideo.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function openModal() {
  els.modal.hidden = false;
  els.modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  els.modalClose.focus({ preventScroll: true });
  document.addEventListener('keydown', onModalKeydown);
}

function closeModal() {
  // 映像を停止して解放。
  try {
    els.modalVideo.pause();
  } catch (_) {
    /* noop */
  }
  els.modalVideo.removeAttribute('src');
  els.modalVideo.load();
  hideOverlay();

  state.openItem = null;
  els.modal.hidden = true;
  els.modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onModalKeydown);
}

function onModalKeydown(e) {
  if (e.key === 'Escape') closeModal();
}

function showOverlay(text) {
  els.modalOverlayText.textContent = text;
  els.modalOverlay.hidden = false;
}
function hideOverlay() {
  els.modalOverlay.hidden = true;
}

// ───────────────────────────────────────────────────────────────────────────
// 状態パネル（ローディング / エラー / 空）
// ───────────────────────────────────────────────────────────────────────────
function showStatus(kind, title, desc) {
  els.statusPanel.classList.toggle('status-panel--error', kind === 'error');
  els.statusSpinner.hidden = kind !== 'loading';
  els.statusTitle.textContent = title;
  els.statusDesc.textContent = desc || '';
  show(els.statusPanel);
}

// 状態パネルを「再翻訳可能な形」で表示する。title/desc は遅延評価サンク
// （() => string）で受け取り、言語切替時に現在の言語で再生成できるよう保持する。
function setStatus(kind, titleFn, descFn) {
  state.lastStatus = { kind: kind, titleFn: titleFn, descFn: descFn };
  showStatus(kind, titleFn(), descFn ? descFn() : '');
}

function setBusy(busy) {
  els.searchBtn.disabled = busy;
  els.searchBtn.querySelector('.btn-text').textContent = busy
    ? window.i18n.t('rec.search.busy.label')
    : window.i18n.t('rec.search.submit');
}

// ───────────────────────────────────────────────────────────────────────────
// フォーマッタ / ユーティリティ
// ───────────────────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');

// Unix秒 → "MM/DD HH:MM:SS"（ローカル時刻。recon: DVR時計はホストと一致）
function fmtDateTime(epoch) {
  const d = new Date(epoch * 1000);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
// Unix秒 → "HH:MM:SS"
function fmtClock(epoch) {
  const d = new Date(epoch * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
// Unix秒 → "HH:MM"
function fmtClockHM(epoch) {
  const d = new Date(epoch * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// 秒数 → "M分S秒" / "H時間M分"
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return window.i18n.t('rec.fmt.duration.hm', { h: h, m: pad2(m) });
  if (m > 0) return window.i18n.t('rec.fmt.duration.ms', { m: m, s: pad2(s) });
  return window.i18n.t('rec.fmt.duration.s', { s: s });
}
// バイト数 → 人が読めるサイズ
function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

// "HH:MM" / "HH:MM:SS" を "HH:MM:SS" に正規化（recon: フル時刻が必要）。
function normalizeTime(value, fallback) {
  if (!value) return fallback;
  const parts = String(value).split(':');
  const h = pad2(parts[0] ?? '00');
  const m = pad2(parts[1] ?? '00');
  const s = pad2(parts[2] ?? '00');
  return `${h}:${m}:${s}`;
}

// date("YYYY-MM-DD") + time("HH:MM:SS") → ローカル Unix秒
function epochFromDateTime(date, time) {
  const [y, mo, da] = String(date).split('-').map(Number);
  const [h, mi, s] = normalizeTime(time, '00:00:00').split(':').map(Number);
  const d = new Date(y, (mo || 1) - 1, da || 1, h || 0, mi || 0, s || 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function buildClipFilename(item) {
  const d = new Date(item.start * 1000);
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `rec_ch${item.channel + 1}_${stamp}.mp4`;
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function describeError(err) {
  const m = err && err.message ? String(err.message) : String(err);
  // fetch のネットワークエラーは "Failed to fetch" 等になりがちなので補足。
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return window.i18n.t('rec.err.connectFailed');
  }
  return m;
}

function show(el) {
  if (el) el.hidden = false;
}
function hide(el) {
  if (el) el.hidden = true;
}

// ───────────────────────────────────────────────────────────────────────────
// 言語切替時の再翻訳
// ───────────────────────────────────────────────────────────────────────────
//
// i18n.js の setLang は data-i18n* 属性を持つ静的要素を自動で再走査するが、
// JS が t() で組み立てた動的文字列は手動で作り直す必要がある。ユーザの選択
// 状態（チェック済みチャンネル等）を壊さないよう、DOM の作り直しは避けて
// テキスト/属性のみを現在の言語で再生成する。
function rerenderI18n() {
  // 1) 接続状態バッジ
  if (state.lastConn) {
    els.connStatus.querySelector('.conn-label').textContent =
      window.i18n.t(state.lastConn.key, state.lastConn.vars);
  }

  // 2) チャンネルチップの title（classList から状態を復元）
  const chips = els.channelChips.querySelectorAll('.chip--channel');
  for (const chip of chips) {
    const title = [];
    if (chip.classList.contains('is-online')) title.push(window.i18n.t('rec.chip.online.title'));
    if (chip.classList.contains('is-recording')) title.push(window.i18n.t('rec.chip.recording.title'));
    if (title.length) chip.title = title.join(' / ');
    else chip.removeAttribute('title');
  }

  // 3) 検索ボタンのラベル（busy 状態は disabled で判定）
  els.searchBtn.querySelector('.btn-text').textContent = els.searchBtn.disabled
    ? window.i18n.t('rec.search.busy.label')
    : window.i18n.t('rec.search.submit');

  // 4) 状態パネル（ローディング/エラー/空）が表示中なら再生成
  if (state.lastStatus && !els.statusPanel.hidden) {
    showStatus(
      state.lastStatus.kind,
      state.lastStatus.titleFn(),
      state.lastStatus.descFn ? state.lastStatus.descFn() : ''
    );
  }

  // 5) 結果バー / タイムライン / リストが表示中なら、直近の検索結果で再描画
  if (!els.resultBar.hidden && state.lastRange) {
    renderResultBar(state.lastPayload, state.items, state.lastRange);
    if (!els.timelineSection.hidden) renderTimeline(state.items, state.lastRange);
    if (!els.listSection.hidden) renderList(state.items);
  }

  // 6) 再生モーダルが開いていれば見出しを再翻訳
  if (state.openItem && !els.modal.hidden) {
    const it = state.openItem;
    els.modalTitle.textContent = window.i18n.t('rec.player.title', {
      ch: it.channel + 1,
      start: fmtDateTime(it.start),
      end: fmtClock(it.end),
      dur: fmtDuration(it.duration),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 初期化
// ───────────────────────────────────────────────────────────────────────────
function init() {
  state.apiBase = resolveApiBase();

  // 既定の日付は今日。
  if (!els.dateInput.value) els.dateInput.value = todayLocalISO();
  els.dateInput.max = todayLocalISO();

  // イベント
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });
  els.todayBtn.addEventListener('click', () => {
    els.dateInput.value = todayLocalISO();
    els.beginInput.value = '00:00:00';
    els.endInput.value = '23:59:59';
  });

  els.modalClose.addEventListener('click', closeModal);
  els.modalBackdrop.addEventListener('click', closeModal);

  // 言語切替時、JS が t() で組み立てた動的文字列を再生成する。
  window.i18n.onChange(rerenderI18n);

  // 接続状態 + チャンネル一覧（非同期・ブロックしない）。
  updateConnectionStatus();
  loadChannels();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
