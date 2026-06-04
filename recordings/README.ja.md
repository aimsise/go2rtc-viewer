[English](README.md) | **日本語**

# 録画 (Playback) 機能 — ONVIF Profile G 録画ビューア

このディレクトリは、NVR/DVR の**録画の検索・再生・ダウンロード**を **ONVIF Profile G**（ベンダー非依存の標準。Recording Search + Replay Control + Device Management）で提供します。ルート直下の go2rtc **ライブビューアとは独立**したバックエンド（Node 標準モジュール + `ffmpeg`）で、別ポート `http://localhost:3914` で動作し、書き出したクリップをこの `recordings/` 配下に蓄積します。

既定バックエンド（`RECORDINGS_BACKEND=onvif`）は、Profile G に準拠した任意の NVR/DVR と ONVIF で通信します。**ベンダー固有のレガシー netsdk/`flv.cgi` クライアント**（塚本無線 OEM の XVR など向け）は `RECORDINGS_BACKEND=netsdk` でオプトインのフォールバックとして残しています（[レガシー netsdk/flv.cgi フォールバック](#レガシー-netsdkflvcgi-フォールバック) 参照）。

> **重要 — best-effort。実機の Profile G ハードウェアでは未検証です。**
> これは仕様準拠の ONVIF Profile G クライアントですが、実機の Profile G NVR/DVR に対して
> エンドツーエンドの検証は**できていません**。手元の唯一の機体は **`/onvif/*` の全パスで 404**、
> unicast の WS-Discovery Probe にも応答しません（[手元の機体が使えない理由](#手元の機体が使えない理由実機調査の結論) 参照）。
> プロトコル処理（WS-Security PasswordDigest、SOAP エンベロープ、レスポンス解析、Fault 処理）は
> 単体テスト済みですが、お使いの機器での実動作は確認が取れるまで未検証扱いとしてください。
> レガシー netsdk 経路も本機では未検証（検索は 0 件、`flv.cgi` は 404）です。

> **⚠️ セキュリティ警告（必読）**: 対象機器は **`admin` / パスワード空** で運用されている場合があります。
> 詳細とリスク・対策は [セキュリティ警告](#セキュリティ警告必読) を必ず読んでください。

---

## 目次

- [概要](#概要)
- [前提条件](#前提条件)
- [起動と停止](#起動と停止)
- [使い方（Web UI）](#使い方web-ui)
- [使い方（CLI）](#使い方cli)
- [設定（環境変数）](#設定環境変数)
- [動作の仕組み（アーキテクチャ）](#動作の仕組みアーキテクチャ)
  - [ONVIF Profile G フロー](#onvif-profile-g-フロー)
  - [認証とクロックスキュー](#認証とクロックスキュー)
  - [チャンネル ↔ RecordingToken 対応と UTC 時刻](#チャンネル--recordingtoken-対応と-utc-時刻)
  - [再生区間の書き出し — 方式 (A) とフォールバック (B)](#再生区間の書き出し--方式-a-とフォールバック-b)
- [レガシー netsdk/flv.cgi フォールバック](#レガシー-netsdkflvcgi-フォールバック)
- [手元の機体が使えない理由（実機調査の結論）](#手元の機体が使えない理由実機調査の結論)
- [トラブルシュート](#トラブルシュート)
- [セキュリティ警告（必読）](#セキュリティ警告必読)
- [ファイル構成](#ファイル構成)

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 既定バックエンド | **ONVIF Profile G**（Recording Search `tse` + Replay Control `trp` + Device Management `tds`）— ベンダー非依存 |
| レガシーバックエンド | netsdk `R.SearchRecord` / `flv.cgi`（塚本無線 OEM XVR など）。`RECORDINGS_BACKEND=netsdk` でオプトイン |
| 認証 | WS-Security UsernameToken（PasswordDigest）→ HTTP-Digest → Basic のラダー（ONVIF）／HTTP Basic（レガシー netsdk） |
| バックエンド | Node.js（標準モジュールのみ — `node:http`/`https`/`crypto`/`url`/`fs`/`path`/`child_process`）+ `ffmpeg`。追加 npm 依存なし |
| ポート | `http://localhost:3914`（go2rtc の `1984` とは別。共存可能） |
| 書き出しパイプライン | ONVIF `GetReplayUri` → RTSP → `ffmpeg -c copy` → ブラウザ再生可能な MP4 |
| 蓄積先 | この `recordings/` 配下（`data/` などの出力は `.gitignore` 済み） |
| 視聴範囲 | **LAN 内のみ**（インターネット公開は想定していません） |

このバックエンドができること:

1. **Profile G NVR/DVR の録画検索**（`FindRecordings` / `GetRecordingSearchResults`）を既存 Web UI で
   検索 → 再生 → MP4 DL。
2. **時間区間の再生／書き出し**（`GetReplayUri` で RTSP 再生 URI を取得し、`ffmpeg -c copy` で MP4 に remux）。
3. **機器状態の取得**（`probe()`: 疎通、選択された認証方式、機器時刻／スキュー、検出したサービス XAddr、録画件数）。

> **このリポジトリには自動録画機能（レコーダー）は含まれていません。** これは*ビューア／書き出し*で、
> NVR/DVR に既に存在する録画を取り出します。機器の ONVIF Profile G 実装が録画を公開していない場合
> （または下記のとおり何も動かないレガシー機の場合）は、元カメラの RTSP を `ffmpeg` で手動セグメント
> 録画してください。例:
> `ffmpeg -i rtsp://<cam>/ch0_0.264 -c copy -f segment -segment_time 600 out_%Y%m%d_%H%M%S.mp4`

---

## 前提条件

- **macOS (Apple Silicon / arm64)**
- **Node.js** がインストール済みであること（追加の npm パッケージは不要）:

  ```sh
  command -v node
  ```

- **`ffmpeg`** が導入済みであること（書き出し時の RTSP → MP4 remux に必須）:

  ```sh
  command -v ffmpeg
  ```

  表示されない場合は [Homebrew](https://brew.sh/) で導入してください:

  ```sh
  brew install ffmpeg
  ```

- NVR/DVR（`ONVIF_HOST`）と**同じ LAN** に接続されていること。
- ブラウザは MP4 (H.264/H.265) を再生できる最新のもの（Safari / Chrome / Firefox / Edge）。

---

## 起動と停止

このディレクトリのサーバはルートの go2rtc とは独立しています。**両方を同時に動かして
構いません**（ポートが別: 録画 = `3914`, ライブ = `1984`）。

**起動:**

```sh
# リポジトリのルートから
node recordings/server.js
# → http://localhost:3914 を既定ブラウザで開く
```

- 起動すると `http://localhost:3914` で録画 UI / API が待ち受けます。
- ポートを変えたいときは `PORT` 環境変数で上書きできます（[設定](#設定環境変数)）。
- 起動ログには有効なバックエンド（既定 `onvif`）が表示され、ONVIF モードでは検出した
  サービス XAddr と選択された認証方式も表示します。

**停止:**

- フォアグラウンド起動なら、その端末で `Ctrl+C`。
- バックグラウンド起動した場合は、起動した端末のプロセスを終了してください
  （例: `node recordings/server.js &` で起動したなら `kill %1`）。

> ライブ視聴（go2rtc）の起動・停止は、ルートの `./start.sh` / `./stop.sh` を使います。
> 録画サーバとは独立しているため、片方だけ起動／停止しても問題ありません。

---

## 使い方（Web UI）

ブラウザで `http://localhost:3914` を開きます。

1. **チャンネル**と**日時範囲（開始 / 終了）**を指定して **検索** します。
   - NVR/DVR 上で指定範囲と重なる録画が一覧表示されます。
   - 各項目に**開始時刻・長さ・種別チップ**が表示されます（ONVIF のカバレッジは録画単位で、
     イベント単位ではありません。下記の注を参照）。
2. 一覧から再生したい項目を選ぶと、ブラウザ内の `<video>` で再生します（バックエンドが
   ONVIF の RTSP 再生をその場で MP4 に remux します）。
3. **ダウンロード**ボタンで MP4 をローカル保存できます。

> **ONVIF の録画種別について**: ONVIF Profile G が公開するのは録画*カバレッジ*（最早／最遅、
> トラック）で、Timing/Motion/Alarm/Manual のイベントビットマスクではありません。そのため各項目は
> 既定で **`Timing`** 種別になり、種別チップ／タイムラインがそのまま描画されます。これは録画単位の
> カバレッジで、イベント単位のメタデータではありません。

---

## 使い方（CLI）

ブラウザを使わず、端末から録画検索・DL を試せます。CLI は
`recordings/download-cli.js` です（`server.js` は Web UI 用のサーバで、サブコマンドは
持ちません）。フラグは `--help` を正とします。代表的な操作:

```sh
# 使い方
node recordings/download-cli.js --help

# 録画一覧（当日）
node recordings/download-cli.js --list

# 範囲を指定して検索・DL する
#   --chn は UI 表示と同じ 1 起点（--chn 1 = UI の ch1）
node recordings/download-cli.js --chn 1 \
  --begin "2026-06-02 00:00:00" --end "2026-06-02 23:59:59"
```

> CLI もサーバと同じ `RECORDINGS_BACKEND` 切替に従います。ONVIF モードでは Profile G
> クライアントで一覧／検索し、再生 RTSP URI → `ffmpeg`（シーク可能なファイル出力、
> `-movflags +faststart`）で DL します。

---

## 設定（環境変数）

認証情報と接続先は**環境変数で渡します**（git 管理外の `.env` から読み込み。リポジトリ
ルートの `.env.example` 参照）。**ソースには機密を書かない**でください。

バックエンドは `ONVIF_*` を先に読み、未設定なら**レガシーの `DVR_*` にフォールバック**します
（既存の `.env` が移行なしで動くように）。`ONVIF_PASS ?? DVR_PASS ?? ''` により、空パスワード
許容のセマンティクスは維持されます。

### バックエンドの選択

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `RECORDINGS_BACKEND` | `onvif` | `onvif`（既定・ONVIF Profile G）または `netsdk`（レガシー `flv.cgi` フォールバック） |

### ONVIF Profile G（既定バックエンド）

| 環境変数 | 既定値 | フォールバック | 説明 |
| --- | --- | --- | --- |
| `ONVIF_HOST` | （空） | `DVR_HOST` | NVR/DVR の IP / ホスト名（`:port` 可。既定 port 80） |
| `ONVIF_USER` | `admin` | `DVR_USER` | ユーザー名（WS-Security / HTTP-Digest / Basic 共通） |
| `ONVIF_PASS` | （空） | `DVR_PASS` | パスワード（空文字も可） |
| `ONVIF_DEVICE_PATH` | `/onvif/device_service` | — | Device サービスの入口パス（非標準機の上書き用）— *任意* |
| `ONVIF_PORT` | host から or `80` | — | `host:port` 指定が無い場合の明示 ONVIF ポート — *任意* |
| `ONVIF_HONOR_XADDR` | `false` | — | `true` = `GetServices` が広告する XAddr をそのまま使用。既定は設定 `host:port` に書換え（XAddr 書換えリスクの緩和）— *任意* |
| `ONVIF_API_TIMEOUT_MS` | `15000` | `DVR_API_TIMEOUT_MS` | SOAP リクエストのタイムアウト（超過で 504） |

### レガシー / 共通

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `DVR_HOST` / `DVR_USER` / `DVR_PASS` | `192.0.2.x`（プレースホルダ）/ `admin` /（空） | **レガシー** netsdk 資格情報。上記 `ONVIF_*` のフォールバックも兼ねる |
| `DVR_DEV` / `DVR_VER` / `DVR_MAX_CHN` | `XVR` / `1.0` / `9` | **レガシー・netsdk 専用。** ONVIF モードでは未使用（ch 数は RecordingToken マップから導出） |
| `BIND_ADDR` | `127.0.0.1` | 待受アドレス。既定は localhost 限定。LAN 公開時のみ `0.0.0.0` |
| `PORT` | `3914` | 録画サーバの待ち受けポート |
| `FFMPEG_PATH` | （PATH） | `ffmpeg` が PATH 外にある場合の場所 |

使用例:

```sh
# ONVIF バックエンド、パスワード設定済み、別ポート
ONVIF_HOST=192.0.2.20 ONVIF_PASS='********' PORT=4000 node recordings/server.js

# レガシー netsdk/flv.cgi フォールバックにオプトイン
RECORDINGS_BACKEND=netsdk DVR_HOST=192.0.2.14 node recordings/server.js
```

> **強く推奨**: NVR/DVR / カメラのパスワードは必ず設定し、`ONVIF_PASS`（または `DVR_PASS`）
> 環境変数で渡してください。空パスワード運用の危険は [セキュリティ警告](#セキュリティ警告必読) を参照。

---

## 動作の仕組み（アーキテクチャ）

既定の ONVIF Profile G モードでは、バックエンドが NVR/DVR と SOAP-over-HTTP で通信して
サービスを検出し、録画を検索し、RTSP 再生 URI を取得し、その RTSP を `ffmpeg -c copy` で
ブラウザ再生可能な MP4 に remux します。ブラウザはこのバックエンド自身のオリジン
（`localhost:3914`）としか通信せず、ONVIF/SOAP/RTSP の通信はすべてサーバ側です。

### ONVIF Profile G フロー

```
                              録画バックエンド (localhost:3914)
                              ┌──────────────────────────────────────────┐
  ONVIF NVR/DVR               │  recordings/onvif.js（Profile G クライアント）│
  (ONVIF_HOST)                │                                           │
  ┌──────────────┐  SOAP/HTTP │  1. GetSystemDateAndTime（unauth → skew）  │
  │  tds device  │◀──────────▶│  2. GetServices          （→ XAddrs）      │
  │  tse search  │            │  3. FindRecordings +                      │
  │  trp replay  │            │     GetRecordingSearchResults（→ tokens） │
  └──────┬───────┘            │  4. GetReplayUri         （→ rtsp:// URI） │
         │ RTSP 再生           └───────────────────┬───────────────────────┘
         │ (Range/区間)                            │ rtsp://（+区間+資格情報）
         ▼                                         ▼
                              ┌──────────────────────────────────────────┐
                              │  ffmpeg -rtsp_transport tcp -i <uri>      │
                              │         -c copy → fragmented/seekable MP4 │
                              └───────────────────┬───────────────────────┘
                                                  │ HTTP (MP4 / JSON)
                                                  ▼
                                        ┌──────────────────────┐
                                        │  ブラウザ              │
                                        │  localhost:3914 録画UI │
                                        │  <video> で MP4 再生/DL│
                                        └──────────────────────┘
```

1. **`GetSystemDateAndTime`**（未認証・`tds`）: 機器の UTC 時計を読み、WS-Security の `Created`
   タイムスタンプと全検索／再生区間に適用するスキューを算出。
2. **`GetServices`**（`tds`）: Search（`tse`）/ Replay（`trp`）/ Recording（`trc`）の XAddr を検出
   （`GetCapabilities`、さらに固定パス `/onvif/search`・`/onvif/replay` にフォールバック）。
3. **`FindRecordings`** + **`GetRecordingSearchResults`** を `Completed` までポーリング（`tse`）:
   `RecordingInformation[]`（RecordingToken, Source, EarliestRecording, LatestRecording, トラック）を収集。
   Search 非対応なら `trc GetRecordings` にフォールバック。
4. **`GetReplayUri`**（`trp`）: 選択した RecordingToken の RTSP 再生 URI を取得。
5. **`ffmpeg -c copy`**: 再生 RTSP（下記のとおり時間区間を適用）を `ffmpeg` に渡し、
   再エンコードせず remux してブラウザ再生可能な MP4 をクライアントへストリーム。

### 認証とクロックスキュー

ONVIF の認証はファームで異なるため、クライアントはラダーを用います。**WS-Security
UsernameToken（PasswordDigest）**を最初に、次に **HTTP-Digest**（RFC 2617。`401
WWW-Authenticate: Digest` で再計算）、最後に **Basic**。選択された方式は以後の呼び出しに
記憶され、`probe()`/`/api/health` で公開されます。PasswordDigest は
`Base64(SHA1(base64decode(Nonce) + Created_utf8 + Password_utf8))` を `node:crypto` で計算します。

時計のずれ／スキューは `NotAuthorized` Fault の最大要因なので、`GetSystemDateAndTime` を
**最初に**（未認証で）呼び `deviceUTC − now` を測定し、そのスキューを `Created` ヘッダと
全検索／再生区間に加算します。

### チャンネル ↔ RecordingToken 対応と UTC 時刻

ONVIF はストリームを 0 起点のチャンネル番号ではなく不透明な **RecordingToken** で識別します。
バックエンドは録画を一度列挙し、Source 名 → EarliestRecording 順にソートして各々に**安定した
0 起点 `chn`** を割り当てます（短い TTL でサーバ側にキャッシュ）。フロントエンドは引き続き
`chn`/`channel` + Unix 秒の `begin`/`end` で会話し、バックエンドが変換します。

ONVIF の `xs:dateTime` は **UTC**（`...Z`）です。全 scope/再生時刻は測定したスキューを適用した
UTC ISO-8601 で整形します — レガシーのホストローカル `toDvrDateTime()` は ONVIF では**使いません**。

### 再生区間の書き出し — 方式 (A) とフォールバック (B)

`GetReplayUri` は録画*全体*を再生する RTSP URI を返すため、要求された `[start,end]` 区間は
RTSP レイヤで適用する必要があります。ffmpeg の RTSP デマクサは ONVIF 再生ヘッダ
（`Require: onvif-replay`, `Range: clock=`, `Rate-Control: no`）を自前で送らないため:

- **方式 (A) — 実装済みの既定。** 再生 URI にベンダーの時間範囲クエリパラメータを付加し
  （`…?token=…&starttime=20260604T080000Z&endtime=20260604T090000Z`。コンパクト ISO-8601 basic
  `YYYYMMDDThhmmssZ`）、`ffmpeg -rtsp_transport tcp -i <uri> -c copy` で取得させます。
  一般的な Hikvision/Dahua/Axis 系で動作し、既存の ffmpeg remux/teardown レッグを新規メディア
  コードなしで再利用します。
  - **制約 — リアルタイムペーシング。** 機器が速度パラメータを無視して 1×（`Rate-Control: yes`
    既定）でペースする場合、1 時間のクリップ書き出しに約 1 時間かかります。タイムライン
    スクラブ用のクリップ区間は通常短いため一般的なケースでは 1× で許容範囲。長時間／高速な
    書き出しには (B) を使用。
- **方式 (B) — ドキュメント化したフォールバック（既定では未実装）。** RTSP 制御チャネルを
  自前で組み（OPTIONS/DESCRIBE/SETUP/PLAY）、`Require: onvif-replay` + `Range: clock=<start>-<end>`
  + `Rate-Control: no` を送り、interleaved RTP をデマクスして H.264 を Annex-B に depacketize して
  ffmpeg に渡します。正確な区間**かつ**高速（`Rate-Control: no`）書き出しが可能ですが、RTP/H.264
  コードが相当量必要です。クエリパラメータの区間を無視する／`Range: clock` ヘッダを厳密に要求する
  機器でのみ使用。

> **再生に go2rtc は意図的に使いません**: go2rtc は ONVIF 再生 RTSP ヘッダ（`Require:` /
> `Range: clock` / `Rate-Control`）を注入できず、これはメンテナに却下された機能です
> （go2rtc issues #952 / #1104）。

---

## レガシー netsdk/flv.cgi フォールバック

`RECORDINGS_BACKEND=netsdk` を設定すると、元のベンダー固有経路を選択します。netsdk
`R.SearchRecord`（録画一覧）+ `cgi-bin/flv.cgi`（FLV DL）を HTTP Basic で叩き、`ffmpeg` が
FLV → MP4 を remux します。**塚本無線 OEM XVR**（`DVR_HOST`, FW 3.2.2.6F / 2022）などを対象とします。

この経路は**削除せず残し**、別機種・別ファームで動く形のクライアントを維持しています。
**手元の機体では未検証**で、`R.SearchRecord` は「成功」応答でも **0 件**、`flv.cgi` は全
パラメータで **HTTP 404** です（[下記](#手元の機体が使えない理由実機調査の結論)）。netsdk を
使う場合の要点:

- **認証**: HTTP Basic のみ、`admin` / パスワード空（`Authorization: Basic <base64("admin:")>`）。
- **`R.SearchRecord`** の body は `BeginTime`/`EndTime` に**フル日時文字列** `YYYY-MM-DD HH:MM:SS`
  が必須（時刻のみ／Unix 秒／空 `Parameter` は `Search Failed!`）。`Reload:"True"` は付けない。
  `Channel` は 9 要素の真偽配列（`MAX_CHN`）、`Type` は `{Timing,Motion,Alarm,Manual}`。DVR 時計は
  ホストと一致（オフセット補正不要）。
- **成功 Item の形**: `{ Channel:"0"(0 起点の文字列), TimeStart, TimeEnd (Unix 秒), Type (ビットマスク 1/2/4/8) }`。
- **`flv.cgi`**: `GET /cgi-bin/flv.cgi?u=&p=&mode=time&chn=<0 起点>&begin=<UnixSec>&end=<UnixSec>&…`
  → 成功時に FLV ストリーム。
- **状態エンドポイント**: `POST /netsdk/Stat`（HDD/IPC/録画状態）、`/netsdk/GetChannelDetail`、
  `/netsdk/R.SEARCH.Ipc`、`/login`。レガシーの `DVR_DEV` / `DVR_VER` / `DVR_MAX_CHN` 環境変数は
  ここでのみ有効。

---

## 手元の機体が使えない理由（実機調査の結論）

物理的に入手可能な唯一の機器 — `.14` DVR（塚本無線 OEM、WTW-EG2 series, FW 3.2.2.6F / 2022）—
では、いずれのバックエンドも実証できていません。切り分け結果:

1. **疎通・認証は OK**。Basic `admin:`（空 PW）で 200（誤 PW は 401）。
2. **netsdk `R.SearchRecord` は `Search Success!` 応答でも常に 0 件** — `ReadCnt:"0"`・`Item` 無し・
   `DataBasePath:"$"`（未解決）— 全期間・全 `Channel`/`Type` で、2TB HDD 100% 使用・録画中でも 0 件。
   `LogSearch` も `SearchCnt:0`。ファーム実装上の制約／バグの可能性が高い。
3. **`cgi-bin/flv.cgi` は全パラメータで 404**。本機の録画再生／DL は Windows / IE 専用 OCX
   （`dvr_ocx.OpenStream`）のバイナリ-over-HTTP プロトコルで、`curl`/`ffmpeg` では再現不可。
4. **開放ポートは 80 と UDP 3702（WS-Discovery）のみ**。RTSP(554) / SDK(37777) / RTMP(1935) は閉。
   **重要なのは、ここでは ONVIF over HTTP も動かないこと: `/onvif/*` は port 80 で 404、unicast の
   WS-Discovery Probe にも応答しません** — そのため ONVIF Profile G クライアントは到達できません。
   実用化にはマルチキャスト 3702 での XAddrs 取得などが必要で、未確立です。

**→ これが、ONVIF クライアントを best-effort として出荷している理由です。** 単体テスト
（PasswordDigest テストベクタ、SOAP エンベロープ描画、ONVIF サンプル XML のレスポンス解析、
Fault→typed-error）付きの仕様準拠実装ですが、実機の Profile G NVR/DVR では未検証です。お使いの
機器が準拠 Profile G レコーダーなら `ONVIF_HOST` を向ければ動作するはずです。手元の機体のように
`/onvif/*` が 404 なら、元カメラの RTSP を `ffmpeg` で手動セグメント録画する（本リポジトリに
レコーダーは含まれません）か、メーカー純正クライアントを使ってください。

---

## トラブルシュート

### 録画一覧が空（ONVIF）

- `RECORDINGS_BACKEND=onvif` であること、`ONVIF_HOST` が実在する Profile G NVR/DVR を指すことを確認。
- `/api/health`（Web UI / `download-cli.js`）を確認: 疎通、選択された認証方式、機器時刻／スキュー、
  検出 XAddr を報告します。到達可能だが録画 0 件と、未到達／未認識レスポンスは区別されます
  （バックエンドは空一覧を捏造せず診断を出します）。
- `/onvif/*` の `404` は機器が ONVIF over HTTP を実装していない意味（手元の機体と同様）—
  [上記](#手元の機体が使えない理由実機調査の結論) 参照。

### `NotAuthorized` / `Sender not authorized`（ONVIF）

- ほぼ**クロックスキュー**かパスワード誤り。クライアントは `GetSystemDateAndTime` でスキューを
  測定し WS-Security → HTTP-Digest → Basic のラダーを試みますが、`ONVIF_USER` / `ONVIF_PASS` が
  機器と一致しているか確認してください。

### 検出したサービス URL のホスト／ポートが違う

- 一部機器は `GetServices` の XAddr に自機／NAT で誤ったホストを広告します。既定では広告 XAddr を
  設定 `host:port` に書き換えます。広告ホストをそのまま使う必要がある場合のみ
  `ONVIF_HONOR_XADDR=true` を設定してください。

### 書き出しが遅い／クリップ長と同じだけかかる

- 方式 (A) の**リアルタイムペーシング**制約です: 機器が 1× でペースすると書き出しも実時間になります。
  スクラブ用には区間を短く。高速な長時間書き出しには、自前 `Rate-Control: no` の方式 (B) が
  ドキュメント化されています（既定では未実装）。

### レガシー netsdk: `Search Failed!` / `flv.cgi` 404

- [レガシー netsdk/flv.cgi フォールバック](#レガシー-netsdkflvcgi-フォールバック) 参照:
  `BeginTime`/`EndTime` はフル日時、`Reload:"True"` は付けない。手元の機体では両症状とも既知で
  修正不能な挙動です。

### ポート 3914 が競合する

```sh
lsof -i :3914
```

- 使用中なら `PORT` 環境変数で別ポートに変更して起動してください
  （例: `PORT=4000 node recordings/server.js`）。
- ライブの go2rtc（`1984` / `8555` / `8554`）とは別ポートなので、通常は競合しません。

---

## セキュリティ警告（必読）

このプロジェクトは **LAN 内の個人利用**を前提としています。以下を必ず守ってください。

### 1. パスワード未設定の NVR/DVR / カメラは危険です

NVR/DVR や元カメラが **`admin` / パスワード空** で運用されている場合:

- 同じ LAN（および設定ミスで外部公開された場合はインターネット）から、**誰でも映像・録画を
  覗き見、設定変更できる**状態です。
- 家庭内のプライバシーが第三者に流出する重大なリスクがあります。

👉 **機器の管理画面から、推測されにくい強固なパスワードを必ず設定してください（強く推奨）。**
設定後は、本機能の `ONVIF_PASS`（または `DVR_PASS`）環境変数（および go2rtc 側の RTSP URL）を
更新してください。**ソースコードにパスワードを直書きしない**こと。

### 2. 認証情報は環境変数で管理する

- 接続先・資格情報は `ONVIF_HOST` / `ONVIF_USER` / `ONVIF_PASS`（レガシー `DVR_*` も尊重）に加え
  `BIND_ADDR` / `PORT` の**環境変数で渡します**。機密値を含むファイルは**コミットしない**でください —
  値は git 管理外の `.env` にのみ置きます。
- このディレクトリの**録画出力（クリップ・サムネイル・キャッシュ）は `.gitignore` 済み**です。
  録画には映像が含まれるため、誤って公開リポジトリに含めないよう注意してください。

### 3. インターネットに公開しないこと

- 録画サーバ（`3914`）と NVR/DVR / カメラは **LAN 内からのアクセスのみ**を想定しています。
- **ルーターのポート転送（ポートフォワーディング）や UPnP で `3914` / `80` / `554` 等を外部公開
  しないでください。**
- 録画サーバはローカルホスト（`127.0.0.1:3914`）に限定する運用を推奨します。LAN 内の他端末から
  見たい場合でも、信頼できるネットワークに限定し、ファイアウォールで保護してください。外出先からは
  VPN 経由を利用してください。

### 4. P2P / クラウド送信の確認

- 多くの民生 NVR/DVR / IP カメラには **P2P / クラウド機能**が搭載されており、設定によっては
  メーカーのサーバーへ映像・接続情報が送信されることがあります。
- **管理画面で P2P / クラウド / リモートアクセス機能を無効化**し、不要な外部通信を遮断することを
  強く推奨します。可能ならルーター側で機器のインターネット向け通信をブロックし、**LAN 内に隔離**
  してください。

---

## ファイル構成

| ファイル / ディレクトリ | 役割 |
| --- | --- |
| `recordings/server.js` | 録画バックエンド（バックエンド選択 + ffmpeg remux + 静的配信サーバ）。Node 標準のみ |
| `recordings/onvif.js` | ONVIF Profile G クライアント（SOAP / WS-Security / Recording-Search / Replay-Control / Device-Management）。標準ライブラリのみ・依存なし |
| `recordings/download-cli.js` | 録画の検索・DL を行う CLI（`--help` / `--list` / `--chn`） |
| `recordings/public/` | 録画 UI（検索フォーム・一覧・プレーヤー: `recordings.html` / `.css` / `.js` / `i18n.js`） |
| `recordings/data/` | 書き出しクリップ等のランタイム出力（MP4 / キャッシュ / 索引）。`.gitignore` 済み |
| `recordings/README.ja.md` | 本ドキュメント |

> 出力ディレクトリ名（`data/` 等）は `server.js` の実装に準じます。録画クリップ・サムネイル・
> キャッシュ・PID/ログなどの**ランタイム出力は `.gitignore` 済み**で、ソース（`server.js` /
> `onvif.js` / `public/` / 本 README）のみが追跡対象です。

---

> 本機能はライブ視聴（go2rtc）と独立して動作します。ライブ視聴の使い方・全体の
> セキュリティ方針は、リポジトリのルート `README.ja.md` を参照してください。
