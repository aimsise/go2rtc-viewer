[English](README.md) | **日本語**

# 録画 (Playback) 機能 — DVR 録画ビューア

このディレクトリは、防犯 DVR（**塚本無線 OEM の XVR**, IP `192.0.2.14`）まわりの
**録画の検索・ダウンロード・閲覧**機能を提供します。ルート直下の go2rtc **ライブ
ビューアとは独立**したバックエンド（Node 標準モジュール + `ffmpeg`）で、別ポート
`http://localhost:3914` で動作し、録画データはこの `recordings/` 配下に蓄積します。

> **重要 — このDVRの録画HTTP-APIは現行ファームで実用にならないことが実機調査で確定しています。**
> `R.SearchRecord`（netsdk 検索API）は「成功」応答を返しても **常に 0 件**、
> `cgi-bin/flv.cgi`（録画DL）は **全パラメータで HTTP 404** です（[なぜ DVR
> から直接DLできないのか](#なぜ-dvr-から直接dlできないのか実機調査の結論) 参照）。
> そのため**実際に動く録画機能は、DVR の録画元カメラ `192.0.2.146` の RTSP を
> 自前でセグメント録画する方式**です。DVR netsdk / flv.cgi クライアントは「将来別
> ファーム／別機種で復活した時のため」に同梱していますが、本機（FW 3.2.2.6F）では
> インデックスが返らない点を理解した上で使ってください。

> **⚠️ セキュリティ警告（必読）**: 対象機器は **`admin` / パスワード空** で運用されています。
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
- [DVR 録画 API 仕様（実機調査の要約）](#dvr-録画-api-仕様実機調査の要約)
  - [認証](#認証)
  - [録画検索 `R.SearchRecord`](#録画検索-rsearchrecord)
  - [録画再生 / DL `flv.cgi`](#録画再生--dl-flvcgi)
  - [構成取得に使える同系エンドポイント](#構成取得に使える同系エンドポイント)
  - [チャンネル構成](#チャンネル構成)
- [なぜ DVR から直接DLできないのか（実機調査の結論）](#なぜ-dvr-から直接dlできないのか実機調査の結論)
- [トラブルシュート](#トラブルシュート)
- [セキュリティ警告（必読）](#セキュリティ警告必読)
- [ファイル構成](#ファイル構成)

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 対象 DVR | 塚本無線 OEM XVR（`192.0.2.14`, FW 3.2.2.6F / 2022） |
| 認証 | HTTP Basic, `admin` / パスワード空（環境変数で上書き可） |
| バックエンド | Node.js（標準モジュールのみ）+ `ffmpeg`。追加 npm 依存なし |
| ポート | `http://localhost:3914`（go2rtc の `1984` とは別。共存可能） |
| 録画の実体 | DVR ch0 の元カメラ = **WTW-IPC `192.0.2.146`** の RTSP |
| 蓄積先 | この `recordings/` 配下（`data/` などの出力は `.gitignore` 済み） |
| 視聴範囲 | **LAN 内のみ**（インターネット公開は想定していません） |

このバックエンドができること:

1. **DVR netsdk 検索 / flv.cgi DL クライアント + Web UI（best-effort／本機では 0 件・404）**
   `R.SearchRecord` を正しいリクエスト形式（フル日時・正しい `Channel`/`Type`）で
   叩く薄いクライアントと、結果をブラウザで検索 → 再生 → MP4 DL する Web UI を
   同梱します。**本機では成功応答でも 0 件**、`flv.cgi` は **404** ですが、別機種・別
   ファームでインデックスが返る環境では録画一覧／DL に使えます（[API 仕様](#dvr-録画-api仕様実機調査の要約) 参照）。
2. **DVR の状態取得**（`/netsdk/Stat` 等で HDD / 接続 IPC / 録画状態を表示）。

> **このリポジトリには自動録画機能（レコーダー）は含まれていません。** 本機のように
> DVR の HTTP 録画 API が機能しない環境で録画を残したい場合は、go2rtc ライブと同じ
> カメラ `192.0.2.146` の RTSP を `ffmpeg` で手動キャプチャしてください（例:
> `ffmpeg -i rtsp://<cam>/ch0_0.264 -c copy -f segment -segment_time 600 out_%Y%m%d_%H%M%S.mp4`）。
> 「DVR の中の録画ファイルそのもの」を取り出すには、**Windows 実機の純正クライアント /
> IE + ActiveX OCX** が必要です（本機の Web UI は Flash + OCX 前提の旧式設計で、
> `curl`/`ffmpeg` では再現できません）。

---

## 前提条件

- **macOS (Apple Silicon / arm64)**
- **Node.js** がインストール済みであること（追加の npm パッケージは不要）:

  ```sh
  command -v node
  ```

- **`ffmpeg`** が導入済みであること（録画・MP4 変換・サムネイル生成に必須）:

  ```sh
  command -v ffmpeg
  ```

  表示されない場合は [Homebrew](https://brew.sh/) で導入してください:

  ```sh
  brew install ffmpeg
  ```

- DVR（`192.0.2.14`）および録画元カメラ（`192.0.2.146`）と**同じ LAN** に接続
  されていること。
- ブラウザは MP4 (H.264) を再生できる最新のもの（Safari / Chrome / Firefox / Edge）。

---

## 起動と停止

このディレクトリのサーバはルートの go2rtc とは独立しています。**両方を同時に
動かして構いません**（ポートが別: 録画 = `3914`, ライブ = `1984`）。

**起動:**

```sh
# リポジトリのルートから
node recordings/server.js
# → http://localhost:3914 を既定ブラウザで開く
```

- 起動すると `http://localhost:3914` で録画 UI / API が待ち受けます。
- ポートを変えたいときは `PORT` 環境変数で上書きできます（[設定](#設定環境変数)）。

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
   - 自前録画（`recordings/` に蓄積済みのクリップ）が一覧表示されます。
   - 各クリップに**開始時刻・長さ・サイズ・サムネイル**が表示されます。
2. 一覧から再生したいクリップを選ぶと、ブラウザ内の `<video>` で再生します
   （自前録画は MP4 / H.264 なので追加プラグイン不要）。
3. **ダウンロード**ボタンで MP4 をローカル保存できます。

> **DVR 直接検索について**: UI には DVR の `R.SearchRecord` を直接叩くモードも
> ありますが、本機では[前述の理由](#なぜ-dvr-から直接dlできないのか実機調査の結論)
> で**常に 0 件**になります。実データは自前録画側で確認してください。

---

## 使い方（CLI）

ブラウザを使わず、端末から DVR の録画検索・DL を試せます。CLI は
`recordings/download-cli.js` です（`server.js` は Web UI 用のサーバで、サブコマンドは
持ちません）。フラグは `--help` を正とします。代表的な操作:

```sh
# 使い方
node recordings/download-cli.js --help

# DVR の録画検索（当日。本機では常に 0 件）
node recordings/download-cli.js --list

# 範囲を指定して検索・DL を試行する
#   日時はフル日時 "YYYY-MM-DD HH:MM:SS"（時刻のみは Search Failed! になる）
#   --chn は UI 表示と同じ 1 起点（--chn 1 = UI の ch1）
node recordings/download-cli.js --chn 1 \
  --begin "2026-06-02 00:00:00" --end "2026-06-02 23:59:59"
```

> 注: 重要なのは「**日時はフル日時文字列**」と「**`--chn` は UI 表示と同じ 1 起点**」と
> いう DVR 仕様（[API 仕様](#dvr-録画-api仕様実機調査の要約)）です。DVR の状態（疎通・
> 認証・HDD/IPC/録画状態）は Web UI（`server.js`）側でも確認できます。

---

## 設定（環境変数）

認証情報と接続先は**環境変数で上書き**できます。**ソースには既定値以外の機密を
書かない**でください（パスワードを設定したら環境変数で渡す）。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `DVR_HOST` | `192.0.2.14` | DVR の IP / ホスト名 |
| `DVR_USER` | `admin` | DVR の Basic 認証ユーザー |
| `DVR_PASS` | （空） | DVR の Basic 認証パスワード |
| `BIND_ADDR` | `127.0.0.1` | 待受アドレス。既定は localhost 限定。LAN 公開時のみ `0.0.0.0` |
| `PORT` | `3914` | 録画サーバの待ち受けポート |

使用例:

```sh
# パスワードを設定済みの環境で、別ポートで起動する例
DVR_PASS='********' PORT=4000 node recordings/server.js
```

> **強く推奨**: DVR / カメラのパスワードは必ず設定し、`DVR_PASS` などの環境変数で
> 渡してください。空パスワード運用の危険は [セキュリティ警告](#セキュリティ警告必読)
> を参照。

---

## 動作の仕組み（アーキテクチャ）

DVR 自身の録画 HTTP-API は本機で機能しない（[後述](#なぜ-dvr-から直接dlできないのか実機調査の結論)）
ため、**録画の実体は DVR ch0 の元カメラ `192.0.2.146` の RTSP** を自前で録る方式
を採ります。go2rtc ライブビューアと同じカメラ・同じ RTSP を共有します。

```
                         (best-effort / 本機では 0件・404)
        ┌───────────── HTTP Basic ─────────────┐
        │  netsdk R.SearchRecord / flv.cgi      │
        ▼                                       │
┌──────────────────┐                            │
│  DVR (XVR)        │  ch0 の録画元 = 同一カメラ  │
│  192.0.2.14     │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
└──────────────────┘
                                  RTSP / H.265 (実用経路)
┌──────────────────┐ ───────────────────────────▶ ┌──────────────────────────────┐
│  WTW-IPC カメラ   │   ch0_0.264 (メイン 4K)        │  録画サーバ (localhost:3914) │
│  192.0.2.146    │   ch0_1.264 (サブ 800x448)     │  ┌────────────────────────┐  │
│  admin / 空        │                               │  │ ffmpeg                 │  │
└──────────────────┘                               │  │ ・時間セグメント録画    │  │
                                                    │  │ ・FLV/HEVC → MP4(H.264) │  │
                                                    │  │ ・サムネイル(JPEG)生成  │  │
                                                    │  └───────────┬────────────┘  │
                                                    │  recordings/ に蓄積・索引化   │
                                                    └──────────────┬───────────────┘
                                                                   │ HTTP (MP4 / JSON)
                                                                   ▼
                                                     ┌──────────────────────────┐
                                                     │  ブラウザ                  │
                                                     │  localhost:3914 の録画UI   │
                                                     │  <video> で MP4 再生 / DL  │
                                                     └──────────────────────────┘
```

- **入力（実用）**: `rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_0.264`（メイン 4K, HEVC）/
  `.../ch0_1.264`（サブ 800×448, HEVC）。
- **変換**: `ffmpeg` で時間セグメント録画し、ブラウザ再生用に H.264 MP4 を生成、
  サムネイル（JPEG）も作成します。索引（時刻・長さ・サイズ）はサーバが保持します。
- **入力（best-effort）**: DVR `192.0.2.14` の netsdk `R.SearchRecord`（録画一覧）/
  `flv.cgi`（DL）。**本機では 0 件 / 404** ですが、対応ファーム機ではここから一覧・
  DL できる設計にしてあります。
- **出力**: 録画クリップ（MP4）と JSON メタデータを `recordings/` 配下に置き、
  `http://localhost:3914` から配信します。

---

## DVR 録画 API 仕様（実機調査の要約）

以下は **`192.0.2.14`（XVR, FW 3.2.2.6F）で実機確認した仕様**です。DVR 直接検索
クライアントを使う／別機種に移植する際の根拠として残します。**本機では検索が
0 件・`flv.cgi` が 404** である点に注意（[結論](#なぜ-dvr-から直接dlできないのか実機調査の結論)）。

### 認証

- **HTTP Basic** 固定。ユーザー `admin`、パスワード**空**。
- ヘッダ: `Authorization: Basic <base64("admin:")>`（`admin` の後にコロン、PW は空）。
- 実測で認証は強制（誤 PW / 無 PW → **401**、`admin:` 空 → **200**）。
- `POST /login`（`{DEV:"XVR",VER:"1.0",Parameter:{username:"admin",passwd:""}}`）も
  成功するが、**別途トークンは発行されない**（Basic のみ。UI は資格情報を Cookie
  `xvr_usr` / `xvr_pwd` に保存するだけ）。
- 接続先・資格情報は環境変数 `DVR_HOST` / `DVR_USER` / `DVR_PASS` で上書き可能。

### 録画検索 `R.SearchRecord`

```
POST http://192.0.2.14/netsdk/R.SearchRecord
Content-Type: application/json;charset=utf-8
Authorization: Basic <base64("admin:")>
```

リクエスト body（**この形が「成功」**。本機では 0 件で返る）:

```json
{
  "DEV": "XVR",
  "VER": "1.0",
  "API": "R.SearchRecord",
  "Parameter": {
    "Channel": ["True","True","True","True","True","True","True","True","True"],
    "Type": ["Timing","Motion","Alarm","Manual"],
    "BeginTime": "2026-06-02 00:00:00",
    "EndTime": "2026-06-03 23:59:59",
    "PageSize": "100",
    "CurrentPage": "1"
  }
}
```

確定した要点:

- **`BeginTime` / `EndTime` は「フル日時文字列 `YYYY-MM-DD HH:MM:SS`」**でなければ
  成功しません。
  - OK 例: `"2026-06-02 00:00:00"` / `"2026-06-03 23:59:59"` → `RetDetail:"Search Success!"`（`RetCode:"0"`）。
  - **NG 例**: 時刻のみ `"00:00:00"` / `"23:59:59"`、Unix 秒整数、空 `Parameter` →
    いずれも `RetDetail:"Search Failed!"`（`RetCode:"-1"`, ただし HTTP は 200）。
  - **`Reload:"True"` は付けない**（付けると逆に `Search Failed!` になる）。
- **`Channel`** は `MAX_CHN`(=9) 個の真偽配列。`True` = そのチャンネルを検索対象に
  する、の意味（ch 名や index ではない）。ch0 のみ検索するなら
  `["True","False","False","False","False","False","False","False","False"]`。
- **`Type`** はビット種別の名称配列 `{Timing, Motion, Alarm, Manual}`（整数 `15` や
  `[1,2,4,8]` でも成功はする）。
- DVR 内蔵時計はホストと一致（実測 `SystemState.DateTime = "2026/06/03 ..."`）＝
  **オフセット補正不要**。

成功レスポンスのスキーマ（**Web UI 本体 JS の復号ロジックから判明・本機では Item 無し**）:

```json
{
  "DEV": "XVR", "VER": "1.0", "API": "R.SearchRecord",
  "RetCode": "0", "RetDetail": "Search Success!",
  "ReadCnt": "<件数>",
  "DataBasePath": "<パス>",
  "Item": [
    { "Channel": "0", "TimeStart": 1717286400, "TimeEnd": 1717290000, "Type": 1 }
  ]
}
```

- `Channel` は **0 起点の番号文字列**（UI 表示は `Number(Channel)+1`）。
- `TimeStart` / `TimeEnd` は **Unix 秒（整数）**。UI は `new Date(1000*TimeStart)` で
  復元。`Duration = TimeEnd - TimeStart`。
- `Type` は**ビットマスク** `{1:Timing, 2:Motion, 4:Alarm, 8:Manual}`。
- **本機の実測**: 2024〜2026 の全期間・全 `Channel`/`Type` で常に `ReadCnt:"0"`・
  `Item` 無し・`DataBasePath:"$"`（未解決プレースホルダ）。2TB HDD が 100% 使用・
  録画中（`RecordingState:"1"`）でも 0 件。

### 録画再生 / DL `flv.cgi`

UI が生成する形式（**本機では HTTP 404**）:

```
GET http://192.0.2.14/cgi-bin/flv.cgi?u=${DVR_USER}&p=${DVR_PASS}&mode=time&chn=<ch>&begin=<UnixSec>&end=<UnixSec>&audio=54&mute=false&rnd=<乱数>
```

- `chn` は **0 起点**、`begin`/`end` は録画 Item の `TimeStart`/`TimeEnd`（**Unix 秒**）、
  `p=` は空パスワード。成功すれば時間範囲の **FLV ストリーム**が返る設計。
- **本機（FW 3.2.2.6F）では `mode=time` / `real` / `playback` ・全パラメータで 404**。
  `cgi-bin/gw.cgi` も 404。Flash 時代の遺物で、このビルドには非搭載です。

### 構成取得に使える同系エンドポイント

すべて `{DEV,VER,API,Parameter}` + Basic。**構成取得には以下を使う**（下記「SET 系
テンプレ」は使わない）:

| エンドポイント | 用途 |
| --- | --- |
| `POST /netsdk/Stat` | **最重要**。機器/HDD/IPC/録画状態が実データで返る |
| `POST /netsdk/GetChannelDetail` | 9ch の解像度・詳細 |
| `POST /netsdk/Record` | 録画スケジュール |
| `POST /netsdk/R.SEARCH.Ipc` | 接続中 IPC 一覧（ch0 = `192.0.2.146`） |
| `POST /netsdk/LogSearch` | ログ検索（本機では `SearchCnt:0`） |
| `POST /login` | 認証確認 |

> **使えないエンドポイント（注意）**: `/netsdk/Channel`, `/netsdk/General`,
> `/netsdk/Stat/Storage` などは GET/POST とも `"$.<API>"` を echo して
> `"StatusCode":"ok"` / `"Save success"` を返すだけの **SET 系テンプレ**で、構成取得
> には使えません。構成取得は `/netsdk/Stat` と `/netsdk/GetChannelDetail` を使います。

### チャンネル構成

- **9ch 構成（`MAX_CHN` = 9）**。`/netsdk/Stat`・`/netsdk/GetChannelDetail` で確認。
- **実カメラは ch0（UI 表示 ch1）のみ接続**:
  `Status:"Connect success"`, `BcamOnline:"True"`, `RecordingState:"1"`。実体は
  **`192.0.2.146` WTW-IPC**（メイン 3840×2160 HEVC / 4Mbps、サブ 800×448 HEVC /
  512kbps）。ch1〜8 は未接続。
- 録画 Item / `flv.cgi` の **ch 番号は 0 起点**（UI は +1 して表示）。

---

## なぜ DVR から直接DLできないのか（実機調査の結論）

`.14` DVR（WTW-EG2 series, FW 3.2.2.6F / 2022）では、**「録画検索 → DL」を HTTP で
再現する経路が現状ありません**。切り分け結果:

1. **疎通・認証は OK**。Basic `admin:`（空 PW）で 200（誤 PW は 401）。
2. **`R.SearchRecord` は成功応答でも常に 0 件**。`BeginTime`/`EndTime` をフル日時に
   すれば `Search Success!` になるが、全期間・全 `Channel`/`Type` で `ReadCnt:"0"`・
   `Item` 無し・`DataBasePath:"$"`（未解決）。**2TB HDD 100% 使用・録画中なのに 0 件**
   ＝この netsdk 検索 API が録画インデックスを返さない（ファーム実装上の制約／バグの
   可能性が高い）。`LogSearch` も `SearchCnt:0`。
3. **`cgi-bin/flv.cgi` は全パラメータで 404**。Web UI のトップは
   `swfobject.js`（Flash）+ ActiveX OCX（`dvr_ocx.OpenStream`）で再生する旧式設計で、
   録画再生／DL の実体は **Windows / IE 専用 OCX のバイナリ-over-HTTP プロトコル**
   （`curl`/`ffmpeg` では再現不可）。
4. **開放ポートは 80 と UDP 3702（WS-Discovery）のみ**。RTSP(554) / SDK(37777 等) /
   RTMP(1935) / ONVIF HTTP は全て閉 or 404。
   - ONVIF（Profile G）は UDP 3702 が開くため可能性はあるが、unicast の WS-Discovery
     Probe に応答なし・`/onvif/*` は 80 で全 404。実用化にはマルチキャスト 3702 での
     XAddrs 取得など追加調査が必要で、現時点未確立。

**→ 採用した代替案（実証済み）**: DVR ch0 の**録画元カメラ `192.0.2.146`（WTW-IPC）**
は port 80 + 554 で **RTSP 稼働を ffprobe で実取得確認**:

- `rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_0.264`（メイン HEVC 3840×2160 + PCM_alaw 音声）
- `rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_1.264`（サブ HEVC 800×448）

既存 go2rtc-viewer の go2rtc ライブビューアも同じ `.146` RTSP を使用中です。本録画機能は、
この **`.146` RTSP を `ffmpeg` でセグメント録画して `recordings/` に蓄積し、独自の
検索・閲覧 UI を提供**します。**DVR 内の録画ファイルそのもの**を取り出したい場合は、
**Windows 実機の純正クライアント / IE + OCX** を使ってください（本ファームの netsdk
検索 / `flv.cgi` DL は機能しないため）。

---

## トラブルシュート

### 録画一覧が空（DVR 直接検索が 0 件）

- **これは本機の仕様（既知）です。** `R.SearchRecord` は成功応答でも常に 0 件です
  （[結論](#なぜ-dvr-から直接dlできないのか実機調査の結論)）。本機から HTTP で録画を
  取り出す方法はありません。録画を残したい場合は、概要のとおりカメラの RTSP を
  `ffmpeg` で手動キャプチャしてください（本リポジトリにレコーダーは含まれません）。
- DVR の状態だけ確認したい場合は `/netsdk/Stat`（Web UI / `download-cli.js`）で
  HDD/IPC/録画状態が実データで返るかを見ます。

### `Search Failed!`（RetCode: -1）が返る

- **日時形式**を確認: `BeginTime`/`EndTime` は**フル日時 `YYYY-MM-DD HH:MM:SS`**。
  時刻のみ・Unix 秒・空 `Parameter` はすべて失敗します。
- `Reload:"True"` を**付けていないか**確認（付けると失敗します）。

### `flv.cgi` が 404（DVR 直接 DL ができない）

- **これも本機の仕様（既知）です。** `flv.cgi` は全モード・全パラメータで 404 です。
  本機では DVR から HTTP で録画を取り出せません。

### 手動 ffmpeg キャプチャができない

本リポジトリに自動録画機能はありません。概要のとおり手動で `ffmpeg` キャプチャする際の
切り分け:

- `command -v ffmpeg` で `ffmpeg` が PATH にあるか確認（無ければ `brew install ffmpeg`）。
- 元カメラに到達できるか確認:

  ```sh
  ping 192.0.2.146
  ffprobe "rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.146:554/ch0_0.264"
  ```

  ストリーム情報（HEVC / 解像度）が出れば録画元は配信できています。
- 同一 LAN にいるか（VPN / 別セグメントだと到達不可）、認証（`admin` / 空 / port 554）
  が実機と一致しているかを確認。
- 出力先 `recordings/` の書き込み権限・空き容量を確認。

### 401 Unauthorized（DVR）

- `DVR_USER` / `DVR_PASS` が実機と一致しているか確認。**パスワードを設定したら**
  `DVR_PASS` 環境変数で渡します（誤 PW / 無 PW は 401、`admin:` 空のみ 200）。

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

### 1. パスワード未設定の DVR / カメラは危険です

DVR（`192.0.2.14`）と録画元カメラ（`192.0.2.146`）は **`admin` / パスワード空**
で運用されています。これは、

- 同じ LAN（および設定ミスで外部公開された場合はインターネット）から、**誰でも
  映像・録画を覗き見、設定変更できる**状態です。
- 家庭内のプライバシーが第三者に流出する重大なリスクがあります。

👉 **DVR / カメラの管理画面から、推測されにくい強固なパスワードを必ず設定してください
（強く推奨）。** 設定後は、本機能の `DVR_PASS` 環境変数（および go2rtc 側の RTSP URL）
を更新してください。**ソースコードにパスワードを直書きしない**こと。

### 2. 認証情報は環境変数で管理する

- 接続先・資格情報は `DVR_HOST` / `DVR_USER` / `DVR_PASS`（＋ `BIND_ADDR` / `PORT`）の
  **環境変数で渡します**。機密値を含むファイルは**コミットしない**でください。
- このディレクトリの**録画出力（クリップ・サムネイル・キャッシュ）は `.gitignore`
  済み**です。録画には映像が含まれるため、誤って公開リポジトリに含めないよう注意して
  ください。

### 3. インターネットに公開しないこと

- 録画サーバ（`3914`）と DVR / カメラは **LAN 内からのアクセスのみ**を想定しています。
- **ルーターのポート転送（ポートフォワーディング）や UPnP で `3914` / `80` / `554`
  等を外部公開しないでください。**
- 録画サーバはローカルホスト（`127.0.0.1:3914`）に限定する運用を推奨します。LAN 内の
  他端末から見たい場合でも、信頼できるネットワークに限定し、ファイアウォールで保護
  してください。外出先からは VPN 経由を利用してください。

### 4. P2P / クラウド送信の確認

- 多くの中国製 DVR / IP カメラ（WTW-IPC / XVR を含む）には **P2P / クラウド機能**が
  搭載されており、設定によってはメーカーのサーバーへ映像・接続情報が送信されること
  があります。
- **管理画面で P2P / クラウド / リモートアクセス機能を無効化**し、不要な外部通信を
  遮断することを強く推奨します。可能ならルーター側で機器のインターネット向け通信を
  ブロックし、**LAN 内に隔離**してください。

---

## ファイル構成

| ファイル / ディレクトリ | 役割 |
| --- | --- |
| `recordings/server.js` | 録画バックエンド（DVR API クライアント + 静的配信サーバ）。Node 標準のみ |
| `recordings/download-cli.js` | DVR 録画の検索・DL を行う CLI（`--help` / `--list` / `--chn`） |
| `recordings/public/` | 録画 UI（検索フォーム・一覧・プレーヤー: `recordings.html` / `.css` / `.js`） |
| `recordings/data/` | 録画/クリップ等のランタイム出力（MP4 / サムネイル / 索引）。`.gitignore` 済み |
| `recordings/README.md` | 本ドキュメント |

> 出力ディレクトリ名（`data/` 等）は `server.js` の実装に準じます。録画クリップ・
> サムネイル・キャッシュ・PID/ログなどの**ランタイム出力は `.gitignore` 済み**で、
> ソース（`server.js` / `web/` / 本 README）のみが追跡対象です。

---

> 本機能はライブ視聴（go2rtc）と独立して動作します。ライブ視聴の使い方・全体の
> セキュリティ方針は、リポジトリのルート `README.ja.md` を参照してください。
