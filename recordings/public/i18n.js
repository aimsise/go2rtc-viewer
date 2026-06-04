// i18n.js — recordings (generated). Lightweight JA/EN i18n for the no-build vanilla UI.
// Loaded as a CLASSIC script BEFORE the page module script, so window.i18n.t /
// .apply are available to the page JS. Static text uses data-i18n / data-i18n-title /
// data-i18n-placeholder / data-i18n-aria-label attributes; dynamic JS strings call
// window.i18n.t('key', {var: val}) with {var} placeholders. See CLAUDE.md.
'use strict';
(function () {
  const DICT = {
  "ja": {
    "common.connStatus.checking": "接続確認中…",
    "rec.chip.online.title": "接続中",
    "rec.chip.recording.title": "録画中",
    "rec.connStatus.error": "バックエンド未接続",
    "rec.connStatus.ok": "バックエンド接続OK",
    "rec.connStatus.title": "録画バックエンド接続状態",
    "rec.connStatus.warn": "応答 {status}",
    "rec.empty.hint.backend": "{base}（バックエンド: {msg}）",
    "rec.empty.hint.base": "指定した日付・時間帯・チャンネルに該当する録画はありませんでした。",
    "rec.empty.hint.retry": "{base} 日付や時間帯、チャンネル/種別の選択を見直してください。",
    "rec.err.connectFailed": "接続できませんでした",
    "rec.fmt.duration.hm": "{h}時間{m}分",
    "rec.fmt.duration.ms": "{m}分{s}秒",
    "rec.fmt.duration.s": "{s}秒",
    "rec.footer.note": "録画は DVR / NVR (ONVIF) / ローカル録画から取得。LAN 内専用・インターネット非公開。",
    "rec.header.live.label": "ライブ視聴",
    "rec.header.live.title": "ライブ映像ビューアを開く",
    "rec.header.subtitle": "DVR / NVR (ONVIF) / LAN内専用",
    "rec.header.title": "録画 検索・閲覧",
    "rec.list.col.act": "操作",
    "rec.list.col.ch": "ch",
    "rec.list.col.dur": "長さ",
    "rec.list.col.end": "終了",
    "rec.list.col.size": "サイズ",
    "rec.list.col.start": "開始",
    "rec.list.col.type": "種別",
    "rec.page.title": "録画 検索・閲覧 — 防犯カメラ",
    "rec.player.close.label": "閉じる",
    "rec.player.close.title": "閉じる",
    "rec.player.download.label": "ダウンロード",
    "rec.player.download.title": "この録画をダウンロード",
    "rec.player.error.overlay": "この録画を再生できませんでした。バックエンドが MP4 変換に対応しているか、対象の録画が存在するか確認してください。ダウンロードはお試しいただけます。",
    "rec.player.title": "ch{ch}  {start} 〜 {end}  ({dur})",
    "rec.result.summary.none": "0 件 — {date} {begin} 〜 {end}",
    "rec.result.summary.some": "{count} 件の録画 — {date} {begin} 〜 {end}",
    "rec.row.download.label": "DL",
    "rec.row.download.title": "MP4 でダウンロード",
    "rec.row.play.label": "再生",
    "rec.row.play.title": "この録画を再生",
    "rec.search.begin.label": "開始時刻",
    "rec.search.busy.label": "検索中…",
    "rec.search.channels.label": "チャンネル",
    "rec.search.chips.loading": "読込中…",
    "rec.search.date.label": "日付",
    "rec.search.empty.title": "録画が見つかりませんでした",
    "rec.search.end.label": "終了時刻",
    "rec.search.err.failed.desc": "{err} — バックエンド ({base}) が起動しているか確認してください。",
    "rec.search.err.failed.title": "検索に失敗しました",
    "rec.search.err.noChannel.desc": "少なくとも 1 つのチャンネルを選択してください。",
    "rec.search.err.noChannel.title": "チャンネル未選択",
    "rec.search.err.noDate.desc": "検索する日付を指定してください。",
    "rec.search.err.noDate.title": "日付を選択してください",
    "rec.search.loading.desc": "{date} / {ch} ch を照会しています。",
    "rec.search.loading.title": "録画を検索中…",
    "rec.search.submit": "検索",
    "rec.search.today.label": "今日",
    "rec.search.today.title": "今日の日付に設定",
    "rec.search.types.label": "録画種別",
    "rec.source.dvr": "DVR / NVR (ONVIF)",
    "rec.source.local": "ローカル録画",
    "rec.timeline.seg.aria": "ch{ch} {start} から {dur} の録画。再生する。",
    "rec.timeline.seg.title": "ch{ch} {start}〜{end} ({dur})",
    "rec.timeline.title": "タイムライン",
    "rec.type.alarm": "アラーム",
    "rec.type.manual": "手動",
    "rec.type.motion": "動体",
    "rec.type.timing": "定時"
  },
  "en": {
    "common.connStatus.checking": "Checking connection…",
    "rec.chip.online.title": "Online",
    "rec.chip.recording.title": "Recording",
    "rec.connStatus.error": "Backend not connected",
    "rec.connStatus.ok": "Backend connected",
    "rec.connStatus.title": "Recording backend connection status",
    "rec.connStatus.warn": "Response {status}",
    "rec.empty.hint.backend": "{base} (Backend: {msg})",
    "rec.empty.hint.base": "No recordings matched the selected date, time range, and channels.",
    "rec.empty.hint.retry": "{base} Try adjusting the date, time range, or channel/type selection.",
    "rec.err.connectFailed": "Couldn't connect",
    "rec.fmt.duration.hm": "{h}h {m}m",
    "rec.fmt.duration.ms": "{m}m {s}s",
    "rec.fmt.duration.s": "{s}s",
    "rec.footer.note": "Recordings sourced from DVR / NVR (ONVIF) / local recording. LAN only, not exposed to the internet.",
    "rec.header.live.label": "Live View",
    "rec.header.live.title": "Open the live video viewer",
    "rec.header.subtitle": "DVR / NVR (ONVIF) / LAN only",
    "rec.header.title": "Recordings — Search & View",
    "rec.list.col.act": "Actions",
    "rec.list.col.ch": "Ch",
    "rec.list.col.dur": "Length",
    "rec.list.col.end": "End",
    "rec.list.col.size": "Size",
    "rec.list.col.start": "Start",
    "rec.list.col.type": "Type",
    "rec.page.title": "Recordings — Search & View — Security Camera",
    "rec.player.close.label": "Close",
    "rec.player.close.title": "Close",
    "rec.player.download.label": "Download",
    "rec.player.download.title": "Download this recording",
    "rec.player.error.overlay": "Couldn't play this recording. Check that the backend supports MP4 conversion and that the recording exists. You can still try downloading it.",
    "rec.player.title": "ch{ch}  {start} – {end}  ({dur})",
    "rec.result.summary.none": "0 results — {date} {begin} – {end}",
    "rec.result.summary.some": "{count} recordings — {date} {begin} – {end}",
    "rec.row.download.label": "DL",
    "rec.row.download.title": "Download as MP4",
    "rec.row.play.label": "Play",
    "rec.row.play.title": "Play this recording",
    "rec.search.begin.label": "Start time",
    "rec.search.busy.label": "Searching…",
    "rec.search.channels.label": "Channel",
    "rec.search.chips.loading": "Loading…",
    "rec.search.date.label": "Date",
    "rec.search.empty.title": "No recordings found",
    "rec.search.end.label": "End time",
    "rec.search.err.failed.desc": "{err} — Check that the backend ({base}) is running.",
    "rec.search.err.failed.title": "Search failed",
    "rec.search.err.noChannel.desc": "Select at least one channel.",
    "rec.search.err.noChannel.title": "No channel selected",
    "rec.search.err.noDate.desc": "Specify the date you want to search.",
    "rec.search.err.noDate.title": "Please select a date",
    "rec.search.loading.desc": "Querying {date} / {ch} ch.",
    "rec.search.loading.title": "Searching recordings…",
    "rec.search.submit": "Search",
    "rec.search.today.label": "Today",
    "rec.search.today.title": "Set to today's date",
    "rec.search.types.label": "Recording type",
    "rec.source.dvr": "DVR / NVR (ONVIF)",
    "rec.source.local": "Local recording",
    "rec.timeline.seg.aria": "ch{ch} {start}, {dur} recording. Play.",
    "rec.timeline.seg.title": "ch{ch} {start}–{end} ({dur})",
    "rec.timeline.title": "Timeline",
    "rec.type.alarm": "Alarm",
    "rec.type.manual": "Manual",
    "rec.type.motion": "Motion",
    "rec.type.timing": "Scheduled"
  }
};

  const LS_KEY = 'seccam.lang';
  const SUPPORTED = ['ja', 'en'];

  function detect() {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    } catch (_) {}
    // Default to English; users pick Japanese via the header toggle (persisted in localStorage).
    return 'en';
  }

  let lang = detect();

  function interpolate(str, vars) {
    if (!vars) return str;
    return String(str).replace(/\{([^}]+)\}/g, function (mm, k) {
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : mm;
    });
  }

  function t(key, vars) {
    const table = DICT[lang] || DICT.ja;
    let s = (table && table[key] != null) ? table[key] : (DICT.ja[key] != null ? DICT.ja[key] : key);
    return interpolate(s, vars);
  }

  function applyTo(el) {
    const k = el.getAttribute('data-i18n');
    if (k != null) el.textContent = t(k);
    const pairs = [['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria-label', 'aria-label']];
    for (let i = 0; i < pairs.length; i++) {
      const ak = el.getAttribute(pairs[i][0]);
      if (ak != null) el.setAttribute(pairs[i][1], t(ak));
    }
  }

  function apply(root) {
    root = root || document;
    if (root.nodeType === 1) {
      if (root.hasAttribute('data-i18n') || root.hasAttribute('data-i18n-title') ||
          root.hasAttribute('data-i18n-placeholder') || root.hasAttribute('data-i18n-aria-label')) applyTo(root);
    }
    const nodes = (root.querySelectorAll ? root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]') : []);
    for (let i = 0; i < nodes.length; i++) applyTo(nodes[i]);
    document.documentElement.setAttribute('lang', lang);
    const titleKey = document.documentElement.getAttribute('data-title-key');
    if (titleKey) document.title = t(titleKey);
    const btns = document.querySelectorAll('.lang-switch .lang-btn[data-lang]');
    for (let i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-lang') === lang));
  }

  function setLang(l) {
    if (SUPPORTED.indexOf(l) === -1 || l === lang) return;
    lang = l;
    try { localStorage.setItem(LS_KEY, lang); } catch (_) {}
    apply(document);
    window.dispatchEvent(new CustomEvent('seccam:langchange', { detail: { lang: lang } }));
  }

  function wire() {
    const btns = document.querySelectorAll('.lang-switch .lang-btn[data-lang]');
    for (let i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { setLang(this.getAttribute('data-lang')); });
    }
    apply(document);
  }

  window.i18n = {
    t: t,
    apply: apply,
    setLang: setLang,
    onChange: function (fn) { window.addEventListener('seccam:langchange', fn); },
    get lang() { return lang; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

})();
