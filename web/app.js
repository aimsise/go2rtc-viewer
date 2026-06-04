// 防犯カメラ ビューア — フロントエンド ロジック
//
// 役割:
//   1) 同リポジトリの cameras.json を fetch してカメラ一覧を取得。
//   2) 1 / 2 / 4 / 6 画面のレイアウトを選び、各「ペイン（枠）」にカメラを割り当てる。
//   3) go2rtc 本体が配信する VideoRTC Web Component (video-stream.js) を読み込み、
//      割当のあるペインに <video-stream> を生成して映像を表示する。
//   4) 各ペインで [HD切替] [スナップショット] [フルスクリーン] を実装。
//   5) レイアウトとペインのカメラ割当を localStorage に保存し、リロードで復元。
//   6) ペイン切替/カメラ変更時に旧 <video-stream> を確実に破棄して接続リークを防ぐ。
//
// go2rtc API（AlexxIT/go2rtc の www/ 実装で確認）:
//   - Web Component:   <video-stream> （video-stream.js, video-rtc.js を継承）
//   - 映像ソース指定:  video.src = new URL('api/ws?src=' + encodeURIComponent(NAME), base)
//                      → WebSocket(api/ws) 経由。component が ws:// に自動変換する。
//   - 再生モード既定:  mode = "webrtc,mse,hls,mjpeg"（WebRTC 優先 → MSE → HLS → MJPEG）
//   - スナップショット: api/frame.jpeg?src=NAME
//   - ストリーム一覧:  api/streams （{ "name": {...} } 形式のオブジェクト）
//   - リーク防止:      VideoRTC は disconnectedCallback で WebSocket / RTCPeerConnection を
//                      破棄する。要素を DOM から外せば接続は閉じる（下記 destroyVideo 参照）。

'use strict';

// ───────────────────────────────────────────────────────────────────────────
// 設定
// ───────────────────────────────────────────────────────────────────────────

// 再生モード既定（go2rtc の VideoRTC 既定と同一: WebRTC 優先・MSE フォールバック）。
const DEFAULT_MODE = 'webrtc,mse,hls,mjpeg';

// 対応レイアウト（=最大ペイン数）。1=1x1, 2=2x1, 4=2x2, 6=3x2。
const LAYOUTS = [1, 2, 4, 6];
const DEFAULT_LAYOUT = 1;
const MAX_PANES = Math.max(...LAYOUTS);

// localStorage キー。
const LS_LAYOUT = 'seccam.layout'; // 数値（1/2/4/6）
const LS_ASSIGN = 'seccam.assign'; // 配列（ペイン index → cameraId | null）

// go2rtc 本体のベース URL を解決する。
// このダッシュボードを go2rtc とは別オリジン（file:// や別ポートの静的サーバ）から
// 開いても動くように go2rtc の origin を解決する。
// 優先順位:
//   1) URL クエリ ?go2rtc=http://host:1984
//   2) cameras.json の "go2rtc" / "base_url" フィールド
//   3) 既定: 現在のホスト名 + :1984
function resolveGo2rtcBase(camerasMeta) {
  const q = sanitizeBase(new URLSearchParams(location.search).get('go2rtc'));
  if (q) return q;

  if (camerasMeta) {
    const fromJson = sanitizeBase(camerasMeta.go2rtc || camerasMeta.base_url || camerasMeta.baseUrl);
    if (fromJson) return fromJson;
  }

  // file:// で開いた場合 location.hostname は空 → localhost にフォールバック。
  const host = location.hostname || 'localhost';
  return `http://${host}:1984`;
}

function stripTrailingSlash(s) {
  return String(s).replace(/\/+$/, '');
}

// 外部から渡されるベース URL（?go2rtc= / cameras.json）を検証する。スキームは
// http(s)、ホストは loopback か RFC1918 のプライベート LAN に限定し、外部オリジンの
// 混入（モジュール script 注入によるクリック型 XSS）を防ぐ。不正なら null を返して
// デフォルト（現在ホスト名 + :1984）に委ねる。
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

// go2rtc の video-rtc.js は、ストリーム破棄時（ondisconnect 内の video.src=''）に
// 内部 <video> の error イベントで必ず「Empty src attribute」を console.error する。
// また切断と同時に WebSocket が「closed before established」警告を出すことがある。
// どちらも我々が意図したストリーム停止（レイアウト変更・HD 切替・離脱）に伴う
// benign なライブラリ由来ログで、機能上の問題はない。これらだけを狭く判定して
// 握りつぶし、それ以外のエラー/警告はそのまま通す。グローバル console を
// 上書きするが、対象は下記の固定パターンに限定する。
function installBenignLogFilter() {
  const isBenign = (args) => {
    const first = args && args.length ? args[0] : '';
    const s = typeof first === 'string' ? first : '';
    // go2rtc の破棄時ログ（空 src によるメディアエラー）
    if (s.indexOf('[VideoRTC] Video error') !== -1) {
      const detail = args[1];
      const msg = detail && detail.message ? String(detail.message) : '';
      const ns = detail && typeof detail.networkState !== 'undefined'
        ? detail.networkState : null;
      // 空 src 由来（NETWORK_NO_SOURCE=3 / "Empty src attribute"）のみ抑制。
      if (msg.indexOf('Empty src attribute') !== -1 || ns === 3) return true;
    }
    // 切断と競合した WebSocket クローズ警告。
    if (s.indexOf('WebSocket') !== -1 &&
        s.indexOf('closed before the connection is established') !== -1) {
      return true;
    }
    // ストリーム再構築（HD 切替・カメラ変更）で前の play() が新しい load に
    // 中断されたときの benign な再生中断警告。AbortError は Error/文字列の
    // どちらでも来うるので両方を見る。
    const asText = s || (first && first.name ? `${first.name}: ${first.message || ''}` : '');
    if (asText.indexOf('AbortError') !== -1 &&
        asText.indexOf('play()') !== -1 &&
        asText.indexOf('interrupted') !== -1) {
      return true;
    }
    return false;
  };

  const wrap = (orig) => function (...args) {
    if (isBenign(args)) return;
    return orig.apply(this, args);
  };

  // 二重適用防止。
  if (!console.__seccamFiltered) {
    console.error = wrap(console.error.bind(console));
    console.warn = wrap(console.warn.bind(console));
    console.__seccamFiltered = true;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 状態
// ───────────────────────────────────────────────────────────────────────────

const state = {
  base: null,            // go2rtc ベース URL
  scriptLoaded: false,   // video-stream.js 読み込み完了フラグ
  cameras: [],           // 正規化済みカメラ配列
  cameraById: new Map(), // cameraId -> camera
  layout: DEFAULT_LAYOUT,// 現在のレイアウト（ペイン数）
  assign: [],            // ペイン index -> cameraId | null
  panes: [],             // ペイン index -> pane オブジェクト（DOM/動画/状態）
};

// ───────────────────────────────────────────────────────────────────────────
// go2rtc Web Component の読み込み
// ───────────────────────────────────────────────────────────────────────────

// go2rtc 本体から video-stream.js（type="module"）を動的注入する。
// 同一オリジンに無くても CORS 不要（module script は go2rtc から配信される静的JS）。
function loadVideoStreamComponent(base) {
  return new Promise((resolve, reject) => {
    if (window.customElements && customElements.get('video-stream')) {
      state.scriptLoaded = true;
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.type = 'module';
    s.src = `${base}/video-stream.js`;
    s.onload = () => {
      state.scriptLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error(`video-stream.js を読み込めません: ${s.src}`));
    document.head.appendChild(s);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// cameras.json の読み込みと正規化
// ───────────────────────────────────────────────────────────────────────────

// cameras.json はリポジトリ直下に置く一方、この index.html は web/ 配下にある。
// そのため「web/ を配信ルートにした場合」「リポジトリ直下を配信ルートにした場合」
// のどちらでも見つかるよう、複数の候補パスを順に試す。
const CAMERAS_JSON_CANDIDATES = [
  '../cameras.json', // web/ を配信ルート → 一つ上（リポジトリ直下）
  './cameras.json',  // cameras.json が index.html と同じ場所にある場合
  'cameras.json',    // リポジトリ直下を配信ルート（/web/index.html を開いた場合）
];

async function loadCameras() {
  const errors = [];
  for (const path of CAMERAS_JSON_CANDIDATES) {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) {
        errors.push(`${path} → HTTP ${res.status}`);
        continue;
      }
      const raw = await res.json();
      return normalizeCameras(raw);
    } catch (e) {
      errors.push(`${path} → ${e && e.message ? e.message : e}`);
    }
  }
  throw new Error(`cameras.json を取得できませんでした (${errors.join(' / ')})`);
}

function normalizeCameras(raw) {
  // 受理する形:
  //   A) { "cameras": [ {...} ], "go2rtc": "..." }
  //   B) [ {...}, {...} ]
  //   C) { "cam1": {...}, ... }   （go2rtc streams 風のオブジェクト）
  let meta = {};
  let list = [];

  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && Array.isArray(raw.cameras)) {
    meta = raw;
    list = raw.cameras;
  } else if (raw && typeof raw === 'object') {
    // オブジェクトのうち配列でない既知メタキーを除外して残りをカメラ扱い。
    const metaKeys = new Set(['go2rtc', 'base_url', 'baseUrl', 'version']);
    meta = raw;
    for (const [key, val] of Object.entries(raw)) {
      if (metaKeys.has(key)) continue;
      if (val && typeof val === 'object') {
        list.push({ id: val.id || key, ...val });
      }
    }
  }

  const cameras = list
    .map((c, i) => normalizeOneCamera(c, i))
    .filter(Boolean);

  return { meta, cameras };
}

function normalizeOneCamera(c, index) {
  if (!c || typeof c !== 'object') return null;

  const id = c.id || c.name || c.stream || `cam_${index}`;
  const name =
    c.name || c.title || c.label || c.display_name || id;
  const ip = c.ip || c.address || c.host || '';

  // ソース（go2rtc のストリーム名）の解決。多様な書き方を許容する。
  // sd: 既定で表示する軽量(サブ)ストリーム。
  // hd: HD 切替で使う高画質(メイン)ストリーム。
  const sources = resolveSources(c, id);

  // enabled / RTSP未設定 の判定:
  //   - 明示的に enabled === false なら無効扱い。
  //   - sd ストリーム名が解決できなければ RTSP 未設定（映像は出せない）。
  //   stream をまだ記入していないカメラはここで configured=false になり、
  //   ドロップダウンには出るが「(RTSP未設定)」と表示して映像は出さない。
  const explicitDisabled = c.enabled === false;
  const configured = !explicitDisabled && !!sources.sd;
  const enabled = configured; // 映像を出せる＝有効

  return { id, name, ip, sources, enabled, configured, explicitDisabled, raw: c };
}

function resolveSources(c, id) {
  // 優先: 明示的な sources オブジェクト
  // 例: "sources": { "sd": "cam1", "hd": "cam1_hd" }
  if (c.sources && typeof c.sources === 'object' && !Array.isArray(c.sources)) {
    const sd =
      c.sources.sd || c.sources.sub || c.sources.low || c.sources.lite || null;
    const hd =
      c.sources.hd || c.sources.main || c.sources.high || c.sources.full || null;
    if (sd || hd) {
      return { sd: sd || hd, hd: hd || sd };
    }
  }

  // 個別フィールド指定
  // 例: "stream_sd": "cam1", "stream_hd": "cam1_hd"
  //  or "src": "cam1", "src_hd": "cam1_hd"
  // 注意: stream 未設定のカメラ（無効プレースホルダ等）では sd が null になり、
  //       上位（normalizeOneCamera）が configured=false と判定する。
  const sd =
    c.stream_sd || c.sub || c.src_sd || c.sd || c.src || c.stream || null;
  const explicitHd =
    c.stream_hd || c.main || c.src_hd || c.hd || null;
  // HD はサブが存在する場合のみ既定の `${id}_hd` を補完する。
  const hd = explicitHd || (sd ? `${id}_hd` : null);

  return { sd: sd || hd || null, hd: hd || sd || null };
}

// ───────────────────────────────────────────────────────────────────────────
// DOM 参照
// ───────────────────────────────────────────────────────────────────────────

const els = {
  grid: document.getElementById('grid'),
  emptyState: document.getElementById('empty-state'),
  template: document.getElementById('pane-template'),
  connStatus: document.getElementById('conn-status'),
  reloadBtn: document.getElementById('reload-btn'),
  layoutSwitch: document.getElementById('layout-switch'),
};

// ───────────────────────────────────────────────────────────────────────────
// localStorage 永続化
// ───────────────────────────────────────────────────────────────────────────

function loadLayoutPref() {
  try {
    const v = parseInt(localStorage.getItem(LS_LAYOUT), 10);
    if (LAYOUTS.includes(v)) return v;
  } catch (_) { /* localStorage 不可環境は既定値 */ }
  return DEFAULT_LAYOUT;
}

function saveLayoutPref(layout) {
  try {
    localStorage.setItem(LS_LAYOUT, String(layout));
  } catch (_) { /* noop */ }
}

function loadAssignPref() {
  try {
    const raw = localStorage.getItem(LS_ASSIGN);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch (_) { /* 壊れていれば無視 */ }
  return null;
}

function saveAssignPref() {
  try {
    // MAX_PANES 長で保存（レイアウトを広げても割当が残るように）。
    const arr = [];
    for (let i = 0; i < MAX_PANES; i++) arr[i] = state.assign[i] || null;
    localStorage.setItem(LS_ASSIGN, JSON.stringify(arr));
  } catch (_) { /* noop */ }
}

// 保存済み割当を検証して採用。未知IDは破棄。未保存なら有効カメラを順に自動配置。
// layout（現在のペイン数）を受け取り、復元結果が「表示中ペインに何も無い」場合は
// 先頭ペインへ詰め直して空画面を防ぐ。
function resolveInitialAssign(layout) {
  const saved = loadAssignPref();
  const assign = new Array(MAX_PANES).fill(null);
  const usable = state.cameras.filter((c) => c.configured);

  if (saved) {
    for (let i = 0; i < MAX_PANES; i++) {
      const id = saved[i];
      if (id && state.cameraById.has(id)) assign[i] = id;
    }
    if (assign.some((x) => x)) {
      // 保存はあるが、現在のレイアウトで見える範囲(0..layout-1)が全て空で、
      // かつ表示できるカメラが存在する場合だけ、見える範囲へ詰め直す。
      const visibleHasAny = assign.slice(0, layout).some((x) => x);
      if (!visibleHasAny && usable.length) {
        compactInto(assign, layout, usable);
      }
      return assign;
    }
  }

  // 既定（未保存 or 全て無効）: 有効カメラを先頭から順に配置。残りは null。
  for (let i = 0; i < MAX_PANES && i < usable.length; i++) {
    assign[i] = usable[i].id;
  }
  return assign;
}

// 見える範囲(0..layout-1)の空きペインへカメラを詰める。
// 優先: 隠れペイン(index >= layout)に居るカメラを手前へ移動。
// 次点: どこにも未配置の使えるカメラを追加。
function compactInto(assign, layout, usable) {
  const visiblePlaced = new Set(assign.slice(0, layout).filter(Boolean));
  // 隠れペインのカメラを回収（重複は除外しつつ順序維持）。
  const queue = [];
  for (let i = layout; i < assign.length; i++) {
    const id = assign[i];
    if (id && !visiblePlaced.has(id) && !queue.includes(id)) {
      queue.push(id);
      assign[i] = null; // 手前へ移すので隠れ側はクリア。
    }
  }
  // それでも足りなければ未配置の使えるカメラを足す。
  const allPlaced = new Set([...visiblePlaced, ...queue]);
  for (const c of usable) {
    if (!allPlaced.has(c.id)) {
      queue.push(c.id);
      allPlaced.add(c.id);
    }
  }
  for (let i = 0; i < layout && queue.length; i++) {
    if (!assign[i]) assign[i] = queue.shift();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// レイアウト / ペイン構築
// ───────────────────────────────────────────────────────────────────────────

// レイアウトを適用してペイン群を（必要数だけ）生成・破棄する。
function applyLayout(layout, { persist = true } = {}) {
  if (!LAYOUTS.includes(layout)) layout = DEFAULT_LAYOUT;
  state.layout = layout;
  els.grid.dataset.layout = String(layout);

  // ペイン数を layout に合わせる。
  // 減らす場合: 余剰ペインの <video-stream> を破棄してから DOM 除去（リーク防止）。
  while (state.panes.length > layout) {
    const pane = state.panes.pop();
    destroyVideo(pane);
    pane.article.remove();
  }
  // 増やす場合: 不足分を生成。
  while (state.panes.length < layout) {
    const index = state.panes.length;
    const pane = buildPane(index);
    state.panes.push(pane);
    els.grid.appendChild(pane.article);
  }

  // 各ペインに割当カメラを反映（既存ペインも再評価して映像を張り直す）。
  for (let i = 0; i < state.panes.length; i++) {
    mountCamera(state.panes[i], state.assign[i] || null, { force: false });
  }

  updateLayoutButtons();
  if (persist) saveLayoutPref(layout);
}

function updateLayoutButtons() {
  const btns = els.layoutSwitch.querySelectorAll('.layout-btn');
  btns.forEach((b) => {
    const active = parseInt(b.dataset.layout, 10) === state.layout;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

// 1ペインの DOM とローカル状態を生成（カメラはまだ載せない）。
function buildPane(index) {
  const frag = els.template.content.cloneNode(true);
  const article = frag.querySelector('.pane');
  article.dataset.paneIndex = String(index);

  const pane = {
    index,
    article,
    wrap: article.querySelector('[data-role="video-wrap"]'),
    select: article.querySelector('[data-role="camera-select"]'),
    addrEl: article.querySelector('[data-role="addr"]'),
    qualityBadge: article.querySelector('[data-role="quality-badge"]'),
    placeholder: article.querySelector('[data-role="placeholder"]'),
    placeholderText: article.querySelector('[data-role="placeholder-text"]'),
    overlay: article.querySelector('[data-role="overlay"]'),
    overlayText: article.querySelector('[data-role="overlay-text"]'),
    hdBtn: article.querySelector('[data-role="hd-toggle"]'),
    snapBtn: article.querySelector('[data-role="snapshot"]'),
    fsBtn: article.querySelector('[data-role="fullscreen"]'),
    video: null,        // 現在の <video-stream>（未割当時は null）
    cam: null,          // 現在割当のカメラ
    quality: 'sd',      // 'sd' | 'hd'
    _overlayTimer: null,
  };

  // クローンしたテンプレート内の data-i18n 要素を現在の言語へ反映。
  window.i18n.apply(article);

  // ドロップダウンの中身を生成。
  populateSelect(pane);

  // イベント: カメラ選択変更。
  pane.select.addEventListener('change', () => {
    const id = pane.select.value || null;
    assignPaneCamera(index, id);
  });

  // イベント: HD 切替 / 撮影 / 全画面。
  pane.hdBtn.addEventListener('click', () => toggleHd(index));
  pane.snapBtn.addEventListener('click', () => takeSnapshot(index));
  pane.fsBtn.addEventListener('click', () => toggleFullscreen(index));

  return pane;
}

// ドロップダウンに「（未割当）」+ 全カメラを並べる。
// RTSP 未設定（configured=false）のカメラは選べるが末尾に「(RTSP未設定)」を付ける。
function populateSelect(pane) {
  const sel = pane.select;
  sel.replaceChildren();

  const none = document.createElement('option');
  none.value = '';
  none.textContent = window.i18n.t('viewer.js.option.unassigned');
  sel.appendChild(none);

  for (const cam of state.cameras) {
    const opt = document.createElement('option');
    opt.value = cam.id;
    const ipPart = cam.ip ? ` (${cam.ip})` : '';
    const statePart = cam.configured ? '' : window.i18n.t('viewer.js.option.unconfigured');
    opt.textContent = `${cam.name}${ipPart}${statePart}`;
    if (!cam.configured) opt.dataset.unconfigured = 'true';
    sel.appendChild(opt);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// カメラ割当 / 映像マウント・破棄
// ───────────────────────────────────────────────────────────────────────────

// 外部操作（ドロップダウン変更）から呼ばれる割当変更。
// 同一カメラが他ペインに居る場合は重複表示を避けるためそのペインを未割当にする。
function assignPaneCamera(index, cameraId) {
  const pane = state.panes[index];
  if (!pane) return;

  // 重複排除: 同じカメラを表示している別ペインを未割当へ。
  if (cameraId) {
    for (let i = 0; i < state.panes.length; i++) {
      if (i !== index && state.assign[i] === cameraId) {
        state.assign[i] = null;
        mountCamera(state.panes[i], null, { force: true });
      }
    }
  }

  state.assign[index] = cameraId;
  mountCamera(pane, cameraId, { force: true });
  saveAssignPref();
}

// ペインに指定カメラを載せる（または未割当にする）。
// force=false のときは「同じカメラが既に載っていれば何もしない」で再接続を避ける。
function mountCamera(pane, cameraId, { force }) {
  const cam = cameraId ? state.cameraById.get(cameraId) || null : null;

  // 既に同一カメラを表示済みなら（force でなければ）スキップ。
  if (!force && pane.cam && cam && pane.cam.id === cam.id && pane.video) {
    syncSelect(pane, cam ? cam.id : '');
    return;
  }

  // まず既存の映像を破棄（リーク防止）。
  destroyVideo(pane);

  pane.cam = cam;
  pane.quality = 'sd';
  syncSelect(pane, cam ? cam.id : '');

  // 未割当 or RTSP未設定 → プレースホルダ表示のみ。
  if (!cam || !cam.configured) {
    pane.article.classList.add('is-empty');
    pane.wrap.classList.remove('is-live');
    pane.qualityBadge.hidden = true;
    pane.addrEl.textContent = cam && cam.ip ? cam.ip : '';
    pane.placeholderText.textContent = !cam
      ? window.i18n.t('viewer.pane.placeholder.unassigned')
      : window.i18n.t('viewer.js.placeholder.rtspUnset');
    // プレースホルダ2行目のヒントを状態で出し分ける（文言切替は CSS が担う）。
    pane.article.classList.toggle('is-unconfigured', !!cam && !cam.configured);
    setControlsEnabled(pane, false);
    return;
  }

  // 映像を生成して表示。
  pane.article.classList.remove('is-empty');
  pane.article.classList.remove('is-unconfigured');
  pane.addrEl.textContent = cam.ip || '';

  const video = createVideoStream(cam.sources.sd);
  pane.wrap.insertBefore(video, pane.wrap.firstChild);
  pane.video = video;
  pane.wrap.classList.add('is-live');

  // 画質バッジ初期化（SD）。
  pane.qualityBadge.hidden = false;
  pane.qualityBadge.textContent = 'SD';
  pane.qualityBadge.classList.remove('cam-badge--hd');

  // コントロール有効化。HD はサブと別のメインがある場合のみ。
  setControlsEnabled(pane, true);
  const hasHd = cam.sources.hd && cam.sources.hd !== cam.sources.sd;
  pane.hdBtn.disabled = !hasHd;
  pane.hdBtn.classList.remove('is-active');
  pane.hdBtn.setAttribute('aria-pressed', 'false');
  refreshHdTitle(pane);
}

// HD ボタンの title を現在の状態（HD 有無・現在の画質）に応じて設定する。
// mountCamera / toggleHd / 言語切替で共通利用し、文言を一箇所に集約する。
function refreshHdTitle(pane) {
  if (!pane.cam) return;
  const hasHd = pane.cam.sources.hd && pane.cam.sources.hd !== pane.cam.sources.sd;
  if (!hasHd) {
    pane.hdBtn.title = window.i18n.t('viewer.js.hd.titleNoHd');
  } else if (pane.quality === 'hd') {
    pane.hdBtn.title = window.i18n.t('viewer.js.hd.titleBackToSd');
  } else {
    pane.hdBtn.title = window.i18n.t('viewer.pane.hd.title');
  }
}

// ペインの <video-stream> を確実に破棄して接続（WebSocket/RTCPeerConnection）を閉じる。
// VideoRTC は disconnectedCallback で ondisconnect() を呼んで接続を解放するため、
// DOM から外せば閉じる。タイミング差に備え ondisconnect も明示的に呼ぶ。
//
// 注意: ここで video の src を空にしてはいけない。VideoRTC の ondisconnect() は
// 内部 <video>.src='' を自分で行う（=「Empty src attribute」エラーを内部発火する。
// これは benign で下の installBenignLogFilter が抑制する）。さらに我々が
// カスタム要素側の src='' を呼ぶと、空 URL の WebSocket を新規に開こうとして
// 「WebSocket closed before the connection is established」警告を増やすだけなので
// 行わない。ondisconnect() で ws/pc は閉じ、remove() の disconnectedCallback は
// 既に CLOSED 判定で早期 return するため、これで接続は確実に解放される。
function destroyVideo(pane) {
  const v = pane.video;
  if (!v) return;
  try {
    if (typeof v.ondisconnect === 'function') v.ondisconnect();
  } catch (_) { /* noop */ }
  try {
    v.remove(); // disconnectedCallback が発火し（既に CLOSED のため）即 return。
  } catch (_) { /* noop */ }
  pane.video = null;
  pane.wrap.classList.remove('is-live');
}

function setControlsEnabled(pane, enabled) {
  pane.hdBtn.disabled = !enabled;
  pane.snapBtn.disabled = !enabled;
  pane.fsBtn.disabled = !enabled;
}

// ドロップダウンの選択値を状態に同期（外部からの割当変更時の表示ズレ防止）。
function syncSelect(pane, value) {
  if (pane.select.value !== value) pane.select.value = value;
}

// <video-stream> 要素を生成。go2rtc の www 実装に準拠した属性を設定する。
function createVideoStream(streamName) {
  const video = document.createElement('video-stream');

  // 既定モード（WebRTC 優先・MSE フォールバック）。
  // 属性とプロパティの両方を設定して、component 初期化タイミングの差異に備える。
  video.setAttribute('mode', DEFAULT_MODE);
  video.mode = DEFAULT_MODE;

  // 画面に表示されていない間は再生を止める（負荷軽減）。background=false が既定。
  video.setAttribute('background', 'false');
  video.background = false;

  setVideoSource(video, streamName);
  return video;
}

// 映像ソースを差し替える。go2rtc は api/ws?src=NAME（WebSocket）を入力に取る。
// component の src setter が http(s)→ws(s) に変換するため、ここでは http(s) で渡してよい。
function setVideoSource(video, streamName) {
  const url = new URL(
    'api/ws?src=' + encodeURIComponent(streamName),
    state.base + '/'
  );
  video.src = url.toString();
}

// ───────────────────────────────────────────────────────────────────────────
// 操作: HD 切替 / スナップショット / フルスクリーン
// ───────────────────────────────────────────────────────────────────────────

function currentSource(pane) {
  if (!pane.cam) return null;
  return pane.quality === 'hd' ? pane.cam.sources.hd : pane.cam.sources.sd;
}

function toggleHd(index) {
  const pane = state.panes[index];
  if (!pane || !pane.cam || !pane.video) return;

  const goingHd = pane.quality !== 'hd';
  const nextSrc = goingHd ? pane.cam.sources.hd : pane.cam.sources.sd;
  if (!nextSrc) return;

  // ストリームを差し替える。同一要素の src を付け替えるより、要素ごと作り直す方が
  // クリーンに再接続できる（旧 ws/pc は destroyVideo で確実に閉じ、新ストリームは
  // 最初から正しい src で開くため、空 src 経由の余計なエラーを生まない）。
  destroyVideo(pane);
  const video = createVideoStream(nextSrc);
  pane.wrap.insertBefore(video, pane.wrap.firstChild);
  pane.video = video;
  pane.wrap.classList.add('is-live');

  pane.quality = goingHd ? 'hd' : 'sd';
  pane.qualityBadge.textContent = goingHd ? 'HD' : 'SD';
  pane.qualityBadge.classList.toggle('cam-badge--hd', goingHd);

  pane.hdBtn.classList.toggle('is-active', goingHd);
  pane.hdBtn.setAttribute('aria-pressed', String(goingHd));
  refreshHdTitle(pane);
}

async function takeSnapshot(index) {
  const pane = state.panes[index];
  if (!pane || !pane.cam) return;

  // go2rtc のスナップショット API。現在表示中のストリームのフレームを取得。
  const src = currentSource(pane);
  if (!src) return;
  const url = new URL(
    'api/frame.jpeg?src=' + encodeURIComponent(src),
    state.base + '/'
  );

  flashOverlay(pane, window.i18n.t('viewer.js.snapshot.capturing'));

  try {
    // fetch して Blob 化 → a[download] で保存（別オリジンでもダウンロード名を付けられる）。
    const res = await fetch(url.toString(), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = objUrl;
    a.download = buildSnapshotFilename(pane.cam, pane.quality);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);

    flashOverlay(pane, window.i18n.t('viewer.js.snapshot.saved'), 1200);
  } catch (err) {
    // fetch が CORS 等で失敗する場合のフォールバック: 新規タブで直接開く。
    window.open(url.toString(), '_blank', 'noopener');
    flashOverlay(pane, window.i18n.t('viewer.js.snapshot.openedTab'), 1600);
    console.warn('snapshot fetch 失敗。直接表示にフォールバック:', err);
  }
}

function buildSnapshotFilename(cam, quality) {
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
    `_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const safeId = String(cam.id).replace(/[^\w.-]/g, '_');
  const label = quality === 'hd' ? 'HD' : 'SD';
  return `${safeId}_${label}_${stamp}.jpeg`;
}

async function toggleFullscreen(index) {
  const pane = state.panes[index];
  if (!pane || !pane.cam) return;

  const target = pane.wrap; // 映像ラッパをフルスクリーン化（バッジ等も含む）。
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (target.requestFullscreen) {
      await target.requestFullscreen();
    } else if (target.webkitRequestFullscreen) {
      // Safari 系フォールバック。
      target.webkitRequestFullscreen();
    }
  } catch (err) {
    console.warn('フルスクリーン切替に失敗:', err);
  }
}

// 一時的なオーバーレイ表示（撮影フィードバック等）。
function flashOverlay(pane, text, hideAfterMs) {
  pane.overlayText.textContent = text;
  pane.overlay.hidden = false;
  if (hideAfterMs) {
    clearTimeout(pane._overlayTimer);
    pane._overlayTimer = setTimeout(() => {
      pane.overlay.hidden = true;
    }, hideAfterMs);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 接続状態インジケータ
// ───────────────────────────────────────────────────────────────────────────

async function updateConnectionStatus() {
  setConnStatus('unknown', window.i18n.t('common.connStatus.checking'));
  try {
    const res = await fetch(new URL('api/streams', state.base + '/').toString(), {
      cache: 'no-cache',
    });
    if (res.ok) {
      setConnStatus('ok', window.i18n.t('common.go2rtc.connStatus.ok'));
    } else {
      setConnStatus('warn', window.i18n.t('common.go2rtc.connStatus.warn', { status: res.status }));
    }
  } catch (_) {
    setConnStatus('error', window.i18n.t('common.go2rtc.connStatus.error'));
  }
}

function setConnStatus(kind, label) {
  const el = els.connStatus;
  el.classList.remove(
    'conn-status--ok',
    'conn-status--warn',
    'conn-status--error',
    'conn-status--unknown'
  );
  el.classList.add(`conn-status--${kind}`);
  el.querySelector('.conn-label').textContent = label;
}

// ───────────────────────────────────────────────────────────────────────────
// 初期化
// ───────────────────────────────────────────────────────────────────────────

async function init() {
  // go2rtc 由来の benign な破棄時ログ抑制を、映像生成より前に有効化。
  installBenignLogFilter();

  let normalized;
  try {
    normalized = await loadCameras();
  } catch (err) {
    console.error(err);
    showFatal(window.i18n.t('viewer.js.fatal.camerasLoad.title'), String(err.message || err));
    return;
  }

  state.cameras = normalized.cameras;
  state.cameraById = new Map(state.cameras.map((c) => [c.id, c]));
  state.base = resolveGo2rtcBase(normalized.meta);

  // カメラ 0 件なら空状態を出して終了。
  if (!state.cameras.length) {
    els.emptyState.hidden = false;
    return;
  }
  els.emptyState.hidden = true;

  // 接続状態チェック（非同期・ブロックしない）。
  updateConnectionStatus();

  try {
    await loadVideoStreamComponent(state.base);
  } catch (err) {
    console.error(err);
    showFatal(
      window.i18n.t('viewer.js.fatal.componentLoad.title'),
      window.i18n.t('viewer.js.fatal.componentLoad.desc', { message: err.message, base: state.base })
    );
    return;
  }

  // 永続化された設定を復元。
  state.layout = loadLayoutPref();
  state.assign = resolveInitialAssign(state.layout);

  // レイアウト切替 UI。
  els.layoutSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.layout-btn');
    if (!btn) return;
    const next = parseInt(btn.dataset.layout, 10);
    if (LAYOUTS.includes(next) && next !== state.layout) {
      applyLayout(next);
    }
  });

  // 初回レイアウト適用（ペイン生成・映像マウント）。
  applyLayout(state.layout, { persist: false });

  // 再読み込み: ストリームを破棄してからページ再読込（明示破棄でリーク防止）。
  els.reloadBtn.addEventListener('click', () => {
    for (const pane of state.panes) destroyVideo(pane);
    location.reload();
  });

  // 離脱時にも全ストリームを破棄（タブ閉じ・遷移時の接続リーク防止）。
  window.addEventListener('pagehide', () => {
    for (const pane of state.panes) destroyVideo(pane);
  }, { once: true });

  // 言語切替: t() で生成した動的文字列（ドロップダウンの選択肢ラベル・プレース
  // ホルダ・HD ボタンの title 等）を再生成する。data-i18n の静的要素は i18n.js が
  // 自動で再翻訳するため、ここでは JS 由来の文字列だけを張り直す。
  window.i18n.onChange(() => {
    for (const pane of state.panes) {
      // 選択肢ラベルを再生成し、現在の選択を維持。
      const current = pane.select.value;
      populateSelect(pane);
      syncSelect(pane, current);
      // 未割当・RTSP未設定ペインのプレースホルダ等を載せ直す（再接続はしない）。
      // 映像ありのペインは早期 return されるため、HD title を直接更新する。
      mountCamera(pane, state.assign[pane.index] || null, { force: false });
      refreshHdTitle(pane);
    }
    // 接続状態ラベルも現在の言語へ更新。
    updateConnectionStatus();
  });
}

function showFatal(title, desc) {
  els.emptyState.hidden = false;
  els.emptyState.querySelector('.empty-title').textContent = title;
  els.emptyState.querySelector('.empty-desc').textContent = desc;
}

// DOM 準備後に起動。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
