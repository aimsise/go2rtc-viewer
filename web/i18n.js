// i18n.js — viewer + management (generated). Lightweight JA/EN i18n for the no-build vanilla UI.
// Loaded as a CLASSIC script BEFORE the page module script, so window.i18n.t /
// .apply are available to the page JS. Static text uses data-i18n / data-i18n-title /
// data-i18n-placeholder / data-i18n-aria-label attributes; dynamic JS strings call
// window.i18n.t('key', {var: val}) with {var} placeholders. See CLAUDE.md.
'use strict';
(function () {
  const DICT = {
  "ja": {
    "common.brand.title": "防犯カメラ ビューア",
    "common.camera.caption": "カメラ",
    "common.connStatus.checking": "接続確認中…",
    "common.fullscreen.text": "全画面",
    "common.go2rtc.connStatus.error": "go2rtc 未接続",
    "common.go2rtc.connStatus.ok": "go2rtc 接続OK",
    "common.go2rtc.connStatus.title": "go2rtc サーバーとの接続状態",
    "common.go2rtc.connStatus.warn": "go2rtc 応答 {status}",
    "common.hd.text": "画質HD",
    "common.help.panel.aria": "操作ガイド",
    "common.help.text": "ヘルプ",
    "common.help.title": "操作ガイド",
    "common.layout.caption": "画面分割",
    "common.layout.group.aria": "画面分割（同時に表示する数）",
    "common.reload.text": "更新",
    "common.snapshot.text": "撮影",
    "common.viewSwitch.aria": "画面切替",
    "common.viewSwitch.manage.text": "管理",
    "common.viewSwitch.manage.title": "go2rtc のストリームを管理",
    "common.viewSwitch.viewer.text": "ビューア",
    "common.viewSwitch.viewer.title": "カメラ映像を見る",
    "mgmt.add.cancel": "キャンセル",
    "mgmt.add.error.failed": "追加に失敗しました: {message}",
    "mgmt.add.error.required": "名前とソースを入力してください。",
    "mgmt.add.name.label": "名前",
    "mgmt.add.name.placeholder": "例: cam_door",
    "mgmt.add.note": "ここでの追加は go2rtc の実行中設定への即時反映です。恒久化するには go2rtc.yaml に追記してください（再起動で消えないように）。",
    "mgmt.add.src.label": "ソース",
    "mgmt.add.src.placeholder": "例: rtsp://user:pass@192.0.2.50:554/stream  または  ffmpeg:rtsp://…#video=h264",
    "mgmt.add.submit": "追加する",
    "mgmt.add.success": "「{name}」を追加しました。",
    "mgmt.addtoggle.text": "ストリーム追加",
    "mgmt.addtoggle.title": "新しいストリームを追加",
    "mgmt.brand.sub": "go2rtc / LAN内",
    "mgmt.brand.title": "ストリーム管理",
    "mgmt.card.delete.text": "削除",
    "mgmt.card.delete.title": "このストリームを削除",
    "mgmt.card.info.text": "情報",
    "mgmt.card.info.title": "状態をJSONで表示",
    "mgmt.card.links.text": "リンク",
    "mgmt.card.links.title": "各種URL一覧",
    "mgmt.card.net.text": "ネット",
    "mgmt.card.net.title": "接続経路の図",
    "mgmt.card.online.title": "現在の視聴者数",
    "mgmt.card.probe.text": "プローブ",
    "mgmt.card.probe.title": "メディア情報を解析",
    "mgmt.card.status.active": "ソース接続中",
    "mgmt.card.status.idle": "待機中",
    "mgmt.card.watch.text": "視聴",
    "mgmt.card.watch.title": "プレイヤーで再生",
    "mgmt.cfg.dirty": "● 未保存",
    "mgmt.cfg.download.text": "バックアップ",
    "mgmt.cfg.download.title": "現在の設定を .yaml でダウンロード",
    "mgmt.cfg.editor.label": "go2rtc.yaml の内容",
    "mgmt.cfg.editor.placeholder": "読み込み中…",
    "mgmt.cfg.reload.confirm": "未保存の変更が失われます。再読込しますか?",
    "mgmt.cfg.reload.text": "再読込",
    "mgmt.cfg.reload.title": "サーバから再読込（未保存は破棄）",
    "mgmt.cfg.restart.banner": "再起動中… ストリームは一時的に切断されます。",
    "mgmt.cfg.restart.confirm": "保存しました。設定を反映するには go2rtc の再起動が必要です。今すぐ再起動しますか?",
    "mgmt.cfg.save.text": "保存",
    "mgmt.cfg.save.title": "go2rtc.yaml に保存",
    "mgmt.cfg.status.loadError": "読み込み失敗: {message}",
    "mgmt.cfg.status.loaded": "読み込み完了",
    "mgmt.cfg.status.loading": "読み込み中…",
    "mgmt.cfg.status.restarted": "再起動しました",
    "mgmt.cfg.status.saveError": "保存失敗: {message}",
    "mgmt.cfg.status.saved": "保存しました",
    "mgmt.cfg.status.savedNotApplied": "保存済み（未反映：反映には再起動が必要）",
    "mgmt.cfg.status.saving": "保存中…",
    "mgmt.cfg.warn": "⚠ 保存するとファイル全体が上書きされます（コメントは保持されますが、構文エラーやうっかり削除もそのまま反映されます）。反映には go2rtc の再起動が必要で、ストリームが一時的に切断されます。初回編集前に「バックアップ」を推奨します。",
    "mgmt.conn.restarting": "go2rtc 再起動中…",
    "mgmt.delete.confirm": "ストリーム「{name}」を削除します。よろしいですか?\n（go2rtc.yaml に記載されたストリームは go2rtc 再起動で復活します）",
    "mgmt.delete.error": "削除に失敗しました: {message}",
    "mgmt.doc.title": "ストリーム管理 — 防犯カメラ",
    "mgmt.empty.desc": "go2rtc にストリームが登録されていません。「ストリーム追加」または go2rtc.yaml をご確認ください。",
    "mgmt.empty.title": "ストリームがありません",
    "mgmt.footer.link.add": "設定で追加（add）",
    "mgmt.footer.link.go2rtc": "go2rtc 標準UI",
    "mgmt.help.delete.desc": "一覧から削除（go2rtc.yaml記載分は再起動で復活）",
    "mgmt.help.delete.label": "削除",
    "mgmt.help.foot": "この画面は go2rtc API（:1984）を読み書きします。標準UIは下部リンクから。",
    "mgmt.help.info.desc": "ストリームの状態を JSON で表示",
    "mgmt.help.info.label": "情報",
    "mgmt.help.links.desc": "RTSP/HLS 等の各種URL一覧",
    "mgmt.help.links.label": "リンク",
    "mgmt.help.modes.heading": "再生モード",
    "mgmt.help.modes.note": "「視聴」で開くプレイヤーの再生方式。チェックした順（WebRTC→MSE→HLS→MJPEG）に試行します。低遅延優先なら WebRTC、互換性優先なら MSE/HLS。",
    "mgmt.help.net.desc": "接続経路（producer/consumer）の図",
    "mgmt.help.net.label": "ネット",
    "mgmt.help.probe.desc": "コーデック等のメディア情報を解析表示",
    "mgmt.help.probe.label": "プローブ",
    "mgmt.help.title": "各項目の意味を表示",
    "mgmt.help.viewers.desc": "そのストリームを今見ている数（右上のバッジ）",
    "mgmt.help.viewers.label": "視聴者",
    "mgmt.help.watch.desc": "go2rtc のプレイヤーで再生（再生モードを反映）",
    "mgmt.help.watch.label": "視聴",
    "mgmt.log.auto": "自動更新",
    "mgmt.log.copy.text": "コピー",
    "mgmt.log.copy.title": "表示中のログをコピー",
    "mgmt.log.empty": "ログがありません（フィルタを確認してください）",
    "mgmt.log.level.all": "全レベル",
    "mgmt.log.level.debug": "debug 以上",
    "mgmt.log.level.error": "error のみ",
    "mgmt.log.level.info": "info 以上",
    "mgmt.log.level.label": "表示する最小レベル",
    "mgmt.log.level.warn": "warn 以上",
    "mgmt.log.newest": "新しい順",
    "mgmt.log.refresh.text": "更新",
    "mgmt.log.refresh.title": "今すぐ更新",
    "mgmt.log.search.placeholder": "検索（message / context）",
    "mgmt.log.status.count": "{count} 行 · {time}",
    "mgmt.log.status.error": "接続できません",
    "mgmt.modes.caption": "再生モード（「視聴」に適用）",
    "mgmt.modes.group.label": "再生モード",
    "mgmt.net.caption": "go2rtc ネットワーク図（producer / consumer の接続経路） —",
    "mgmt.net.frame.title": "go2rtc ネットワーク図",
    "mgmt.net.open": "別タブで開く ↗",
    "mgmt.reload.title": "ストリーム一覧を更新します",
    "mgmt.source.waiting": "待機中（視聴を開始するとソースへ接続します）",
    "mgmt.tab.config": "設定",
    "mgmt.tab.log": "ログ",
    "mgmt.tab.net": "ネットワーク",
    "mgmt.tab.streams": "ストリーム",
    "mgmt.tabbar.label": "管理メニュー",
    "mgmt.version.configpath": " / 設定: {path}",
    "mgmt.version.error": "go2rtc 情報を取得できません",
    "mgmt.version.loading": "go2rtc に接続中…",
    "mgmt.version.prefix": "go2rtc v{version}",
    "viewer.brand.sub": "ローカル専用 / LAN内",
    "viewer.empty.desc": "cameras.json を確認してください。",
    "viewer.empty.title": "カメラがありません",
    "viewer.footer": "go2rtc 経由で H.265 → H.264 トランスコード配信 / WebRTC 優先・MSE フォールバック",
    "viewer.grid.aria": "カメラ枠一覧",
    "viewer.help.camSelect.desc": "その枠に映すカメラを選ぶ（同じカメラは他の枠から自動で外れます）",
    "viewer.help.camSelect.term": "カメラ選択",
    "viewer.help.foot": "映像は go2rtc 経由（H.265→H.264）。録画はしません。",
    "viewer.help.fullscreen.desc": "その映像だけを画面いっぱいに表示（Escで戻る）",
    "viewer.help.fullscreen.term": "全画面",
    "viewer.help.hd.desc": "高画質に切替（もう一度押すとSDに戻る・HD無しは押せません）",
    "viewer.help.hd.term": "画質HD",
    "viewer.help.layout.desc": "同時に表示する数（1=単画面 / 2=横2 / 4=2×2 / 6=3×2）",
    "viewer.help.layout.term": "画面分割",
    "viewer.help.legend.connErr.desc": "go2rtc を起動してください",
    "viewer.help.legend.connErr.term": "未接続",
    "viewer.help.legend.connOk.desc": "go2rtc と通信できています",
    "viewer.help.legend.connOk.term": "接続OK",
    "viewer.help.legend.live.desc": "映像を受信中（右上）",
    "viewer.help.legend.quality.chip": "画質",
    "viewer.help.legend.quality.desc": "今の画質（左上）",
    "viewer.help.legend.sub": "表示の見方",
    "viewer.help.snapshot.desc": "今の映像を1枚の画像（JPEG）で保存",
    "viewer.help.snapshot.term": "撮影",
    "viewer.js.fatal.camerasLoad.title": "cameras.json を読み込めませんでした。",
    "viewer.js.fatal.componentLoad.desc": "{message} — go2rtc ({base}) が起動しているか確認してください。",
    "viewer.js.fatal.componentLoad.title": "go2rtc の映像コンポーネントを読み込めませんでした。",
    "viewer.js.hd.titleBackToSd": "SD（軽量）に戻す",
    "viewer.js.hd.titleNoHd": "HD ストリーム未設定",
    "viewer.js.option.unassigned": "— カメラ未割当 —",
    "viewer.js.option.unconfigured": "（RTSP未設定）",
    "viewer.js.placeholder.rtspUnset": "RTSP 未設定（映像なし）",
    "viewer.js.snapshot.capturing": "撮影中…",
    "viewer.js.snapshot.openedTab": "別タブで表示",
    "viewer.js.snapshot.saved": "保存しました",
    "viewer.layout.btn.word": "画面",
    "viewer.layout.btn1.title": "1画面：1台を大きく表示",
    "viewer.layout.btn2.title": "2画面：横に2台を並べて表示",
    "viewer.layout.btn4.title": "4画面：2×2で4台を表示",
    "viewer.layout.btn6.title": "6画面：3×2で6台を表示",
    "viewer.pane.addr.title": "カメラのIPアドレス",
    "viewer.pane.controls.aria": "この映像の操作",
    "viewer.pane.controls.caption": "操作",
    "viewer.pane.fullscreen.title": "この映像を全画面表示（Escで戻る）",
    "viewer.pane.hd.title": "HD（高画質）に切替",
    "viewer.pane.placeholder.unassigned": "カメラ未割当",
    "viewer.pane.qualityBadge.title": "現在の画質（SD=軽量 / HD=高画質）",
    "viewer.pane.select.aria": "この枠に表示するカメラを選ぶ",
    "viewer.pane.select.title": "この枠に表示するカメラを選びます",
    "viewer.pane.snapshot.title": "今の映像を1枚JPEGで保存",
    "viewer.reload.title": "カメラ一覧と映像を更新します（ページを再読み込み）"
  },
  "en": {
    "common.brand.title": "Security Camera Viewer",
    "common.camera.caption": "Camera",
    "common.connStatus.checking": "Checking connection…",
    "common.fullscreen.text": "Fullscreen",
    "common.go2rtc.connStatus.error": "go2rtc not connected",
    "common.go2rtc.connStatus.ok": "go2rtc connected",
    "common.go2rtc.connStatus.title": "Connection status with the go2rtc server",
    "common.go2rtc.connStatus.warn": "go2rtc responded {status}",
    "common.hd.text": "HD",
    "common.help.panel.aria": "User guide",
    "common.help.text": "Help",
    "common.help.title": "User guide",
    "common.layout.caption": "Layout",
    "common.layout.group.aria": "Layout (number shown at once)",
    "common.reload.text": "Reload",
    "common.snapshot.text": "Snapshot",
    "common.viewSwitch.aria": "Switch view",
    "common.viewSwitch.manage.text": "Manage",
    "common.viewSwitch.manage.title": "Manage go2rtc streams",
    "common.viewSwitch.viewer.text": "Viewer",
    "common.viewSwitch.viewer.title": "View camera streams",
    "mgmt.add.cancel": "Cancel",
    "mgmt.add.error.failed": "Add failed: {message}",
    "mgmt.add.error.required": "Enter a name and a source.",
    "mgmt.add.name.label": "Name",
    "mgmt.add.name.placeholder": "e.g. cam_door",
    "mgmt.add.note": "Adding here applies immediately to the running go2rtc config. To make it permanent, add it to go2rtc.yaml so it survives a restart.",
    "mgmt.add.src.label": "Source",
    "mgmt.add.src.placeholder": "e.g. rtsp://user:pass@192.0.2.50:554/stream  or  ffmpeg:rtsp://…#video=h264",
    "mgmt.add.submit": "Add",
    "mgmt.add.success": "Added \"{name}\".",
    "mgmt.addtoggle.text": "Add Stream",
    "mgmt.addtoggle.title": "Add a new stream",
    "mgmt.brand.sub": "go2rtc / LAN only",
    "mgmt.brand.title": "Stream Management",
    "mgmt.card.delete.text": "Delete",
    "mgmt.card.delete.title": "Delete this stream",
    "mgmt.card.info.text": "Info",
    "mgmt.card.info.title": "Show status as JSON",
    "mgmt.card.links.text": "Links",
    "mgmt.card.links.title": "List of URLs",
    "mgmt.card.net.text": "Network",
    "mgmt.card.net.title": "Connection path diagram",
    "mgmt.card.online.title": "Current viewer count",
    "mgmt.card.probe.text": "Probe",
    "mgmt.card.probe.title": "Analyze media info",
    "mgmt.card.status.active": "Source connected",
    "mgmt.card.status.idle": "Idle",
    "mgmt.card.watch.text": "Watch",
    "mgmt.card.watch.title": "Play in the player",
    "mgmt.cfg.dirty": "● Unsaved",
    "mgmt.cfg.download.text": "Backup",
    "mgmt.cfg.download.title": "Download the current config as .yaml",
    "mgmt.cfg.editor.label": "go2rtc.yaml contents",
    "mgmt.cfg.editor.placeholder": "Loading…",
    "mgmt.cfg.reload.confirm": "Unsaved changes will be lost. Reload anyway?",
    "mgmt.cfg.reload.text": "Reload",
    "mgmt.cfg.reload.title": "Reload from server (discards unsaved changes)",
    "mgmt.cfg.restart.banner": "Restarting… Streams are temporarily disconnected.",
    "mgmt.cfg.restart.confirm": "Saved. Applying the config requires a go2rtc restart. Restart now?",
    "mgmt.cfg.save.text": "Save",
    "mgmt.cfg.save.title": "Save to go2rtc.yaml",
    "mgmt.cfg.status.loadError": "Load failed: {message}",
    "mgmt.cfg.status.loaded": "Loaded",
    "mgmt.cfg.status.loading": "Loading…",
    "mgmt.cfg.status.restarted": "Restarted",
    "mgmt.cfg.status.saveError": "Save failed: {message}",
    "mgmt.cfg.status.saved": "Saved",
    "mgmt.cfg.status.savedNotApplied": "Saved (not applied: a restart is required)",
    "mgmt.cfg.status.saving": "Saving…",
    "mgmt.cfg.warn": "⚠ Saving overwrites the entire file (comments are kept, but syntax errors and accidental deletions are written as-is too). Applying changes requires a go2rtc restart, which briefly disconnects streams. We recommend \"Backup\" before your first edit.",
    "mgmt.conn.restarting": "Restarting go2rtc…",
    "mgmt.delete.confirm": "Delete the stream \"{name}\"? Are you sure?\n(Streams defined in go2rtc.yaml return when go2rtc restarts.)",
    "mgmt.delete.error": "Delete failed: {message}",
    "mgmt.doc.title": "Stream Management — Security Camera",
    "mgmt.empty.desc": "No streams are registered in go2rtc. Use \"Add Stream\" or check go2rtc.yaml.",
    "mgmt.empty.title": "No streams",
    "mgmt.footer.link.add": "Add via config (add)",
    "mgmt.footer.link.go2rtc": "go2rtc default UI",
    "mgmt.help.delete.desc": "Remove from the list (entries in go2rtc.yaml return after restart)",
    "mgmt.help.delete.label": "Delete",
    "mgmt.help.foot": "This page reads and writes the go2rtc API (:1984). The default UI is linked at the bottom.",
    "mgmt.help.info.desc": "Show stream status as JSON",
    "mgmt.help.info.label": "Info",
    "mgmt.help.links.desc": "List of URLs (RTSP/HLS, etc.)",
    "mgmt.help.links.label": "Links",
    "mgmt.help.modes.heading": "Play Modes",
    "mgmt.help.modes.note": "Playback method for the player opened by \"Watch\". Tried in the checked order (WebRTC→MSE→HLS→MJPEG). Choose WebRTC for low latency, MSE/HLS for compatibility.",
    "mgmt.help.net.desc": "Diagram of the connection path (producer/consumer)",
    "mgmt.help.net.label": "Network",
    "mgmt.help.probe.desc": "Analyze and show media info such as codecs",
    "mgmt.help.probe.label": "Probe",
    "mgmt.help.title": "Show what each item means",
    "mgmt.help.viewers.desc": "Number currently watching this stream (top-right badge)",
    "mgmt.help.viewers.label": "Viewers",
    "mgmt.help.watch.desc": "Play in the go2rtc player (uses the selected play modes)",
    "mgmt.help.watch.label": "Watch",
    "mgmt.log.auto": "Auto-refresh",
    "mgmt.log.copy.text": "Copy",
    "mgmt.log.copy.title": "Copy the visible log",
    "mgmt.log.empty": "No logs (check your filters)",
    "mgmt.log.level.all": "All levels",
    "mgmt.log.level.debug": "debug and up",
    "mgmt.log.level.error": "error only",
    "mgmt.log.level.info": "info and up",
    "mgmt.log.level.label": "Minimum level to show",
    "mgmt.log.level.warn": "warn and up",
    "mgmt.log.newest": "Newest first",
    "mgmt.log.refresh.text": "Reload",
    "mgmt.log.refresh.title": "Refresh now",
    "mgmt.log.search.placeholder": "Search (message / context)",
    "mgmt.log.status.count": "{count} lines · {time}",
    "mgmt.log.status.error": "Can't connect",
    "mgmt.modes.caption": "Play modes (applied to \"Watch\")",
    "mgmt.modes.group.label": "Play modes",
    "mgmt.net.caption": "go2rtc network diagram (producer / consumer connection paths) —",
    "mgmt.net.frame.title": "go2rtc network diagram",
    "mgmt.net.open": "Open in new tab ↗",
    "mgmt.reload.title": "Refresh the stream list",
    "mgmt.source.waiting": "Idle (connects to the source when you start watching)",
    "mgmt.tab.config": "Config",
    "mgmt.tab.log": "Log",
    "mgmt.tab.net": "Network",
    "mgmt.tab.streams": "Streams",
    "mgmt.tabbar.label": "Management menu",
    "mgmt.version.configpath": " / Config: {path}",
    "mgmt.version.error": "Can't fetch go2rtc info",
    "mgmt.version.loading": "Connecting to go2rtc…",
    "mgmt.version.prefix": "go2rtc v{version}",
    "viewer.brand.sub": "Local only / LAN",
    "viewer.empty.desc": "Please check cameras.json.",
    "viewer.empty.title": "No cameras",
    "viewer.footer": "Transcoded via go2rtc (H.265 to H.264) / WebRTC first, MSE fallback",
    "viewer.grid.aria": "Camera panes",
    "viewer.help.camSelect.desc": "Pick the camera for that pane (the same camera leaves other panes automatically)",
    "viewer.help.camSelect.term": "Camera select",
    "viewer.help.foot": "Video runs through go2rtc (H.265 to H.264). No recording.",
    "viewer.help.fullscreen.desc": "Show just that stream full screen (Esc to exit)",
    "viewer.help.fullscreen.term": "Fullscreen",
    "viewer.help.hd.desc": "Switch to high quality (press again for SD; disabled without an HD stream)",
    "viewer.help.hd.term": "HD",
    "viewer.help.layout.desc": "How many shown at once (1=single / 2=row of 2 / 4=2x2 / 6=3x2)",
    "viewer.help.layout.term": "Layout",
    "viewer.help.legend.connErr.desc": "Please start go2rtc",
    "viewer.help.legend.connErr.term": "Not connected",
    "viewer.help.legend.connOk.desc": "Communicating with go2rtc",
    "viewer.help.legend.connOk.term": "Connected",
    "viewer.help.legend.live.desc": "Receiving video (top right)",
    "viewer.help.legend.quality.chip": "Quality",
    "viewer.help.legend.quality.desc": "Current quality (top left)",
    "viewer.help.legend.sub": "Reading the display",
    "viewer.help.snapshot.desc": "Save the current frame as a JPEG image",
    "viewer.help.snapshot.term": "Snapshot",
    "viewer.js.fatal.camerasLoad.title": "Could not load cameras.json.",
    "viewer.js.fatal.componentLoad.desc": "{message} — please check that go2rtc ({base}) is running.",
    "viewer.js.fatal.componentLoad.title": "Could not load the go2rtc video component.",
    "viewer.js.hd.titleBackToSd": "Back to SD (light)",
    "viewer.js.hd.titleNoHd": "No HD stream configured",
    "viewer.js.option.unassigned": "— No camera —",
    "viewer.js.option.unconfigured": "(RTSP not set)",
    "viewer.js.placeholder.rtspUnset": "RTSP not set (no video)",
    "viewer.js.snapshot.capturing": "Capturing…",
    "viewer.js.snapshot.openedTab": "Opened in new tab",
    "viewer.js.snapshot.saved": "Saved",
    "viewer.layout.btn.word": "views",
    "viewer.layout.btn1.title": "1 view: show one camera large",
    "viewer.layout.btn2.title": "2 views: two cameras side by side",
    "viewer.layout.btn4.title": "4 views: four cameras in 2x2",
    "viewer.layout.btn6.title": "6 views: six cameras in 3x2",
    "viewer.pane.addr.title": "Camera IP address",
    "viewer.pane.controls.aria": "Controls for this stream",
    "viewer.pane.controls.caption": "Controls",
    "viewer.pane.fullscreen.title": "Show this stream full screen (Esc to exit)",
    "viewer.pane.hd.title": "Switch to HD (high quality)",
    "viewer.pane.placeholder.unassigned": "No camera assigned",
    "viewer.pane.qualityBadge.title": "Current quality (SD=light / HD=high)",
    "viewer.pane.select.aria": "Choose the camera for this pane",
    "viewer.pane.select.title": "Choose the camera shown in this pane",
    "viewer.pane.snapshot.title": "Save the current frame as a JPEG",
    "viewer.reload.title": "Reload the camera list and streams (reloads the page)"
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
