# Chrome Web Store 掲載情報（下書き）

ストア登録画面にコピペするための原稿。実際の登録は開発者本人が行う。

---

## 基本情報

| 項目 | 値 |
|---|---|
| 拡張機能名 | `DualView for YouTube` |
| カテゴリ | ユーザー補助 / エンターテイメント のいずれか |
| 言語 | 日本語（英語も追加登録可能） |
| プライバシーポリシーURL | `https://yuya6703-dot.github.io/YouTube-DualView/privacy-policy` |

★ プライバシーポリシーURLは **GitHub Pagesを有効化してから**確定する。
   有効化手順はこのファイル末尾を参照。

---

## 概要（短い説明・132文字以内）

### 日本語

```
メイン画面でYouTubeを全画面再生したまま、サブモニターから関連動画・コメント・検索・再生キューを操作できます。
```

（56文字）

### English

```
Watch YouTube fullscreen on one monitor while browsing related videos, comments, search, and a play queue from another.
```

（118 characters）

---

## 詳細な説明

### 日本語

```
デュアルモニター環境でYouTubeを快適に見るための拡張機能です。

メインモニターで動画を全画面再生したまま、サブモニターの独立したウィンドウから
すべての操作ができます。動画を止めたり、全画面を解除したりする必要はありません。

■ できること

・再生コントロール
　再生／一時停止、シーク、音量、再生速度（0.1刻み）をサブ画面から操作

・関連動画
　メイン画面をスクロールせずに関連動画を一覧表示。クリックでそのまま再生。
　全画面表示のまま動画を切り替えられます

・コメント
　スクロールするだけで続きを自動読み込み。返信の表示、いいね、
　新規コメントの投稿、返信の投稿にも対応
　コメント内のURLはクリックで別タブに開き、タイムスタンプはその位置へジャンプします

・次に再生キュー
　見たい動画を追加し、ドラッグで並べ替え。動画が終わると自動で次を再生

・タイムスタンプメモ
　再生位置に紐づくメモを残し、クリックでその位置へジャンプ

・検索
　サブ画面から検索し、メイン画面に結果を表示

・表示のカスタマイズ
　関連動画とコメントの半々表示、文字サイズ・カード サイズの変更、
　日本語／英語の切り替え

■ プライバシー

この拡張機能は情報を一切収集しません。設定・キュー・メモはすべて
あなたのブラウザ内にのみ保存され、外部に送信されることはありません。
外部サーバーへ通信するコードは実装されていません。

■ ご注意

・YouTube（Google LLC）とは関係のない非公式のツールです
・デスクトップ版のChrome / Braveでの利用を想定しています
・YouTube側の仕様変更により一時的に動作しなくなる場合があります。
　その際はGitHubのIssueからご報告ください

■ ソースコード

https://github.com/yuya6703-dot/YouTube-DualView
```

### English

```
A Chrome extension for watching YouTube comfortably on a dual-monitor setup.

Keep the video playing fullscreen on your main monitor while you control
everything from an independent window on your second monitor. No need to pause
the video or leave fullscreen.

■ Features

・Playback controls
　Play/pause, seek, volume, and playback speed (0.1 steps) from the sub window

・Related videos
　Browse related videos without scrolling the main page. Click to play — the
　main screen stays fullscreen while switching videos

・Comments
　Scroll to load more automatically. View replies, like comments, post new
　comments, and post replies.
　URLs in comments open in a new tab; timestamps jump the main video there

・Up-next queue
　Add videos, reorder by dragging, and play the next one automatically when
　the current video ends

・Timestamp notes
　Save notes tied to a playback position and click to jump back to it

・Search
　Search from the sub window and show results on the main screen

・Display options
　Split view for related videos and comments, adjustable font and card sizes,
　and Japanese/English UI

■ Privacy

This extension collects nothing. Your settings, queue, and notes are stored
only inside your browser and are never transmitted. There is no code in this
extension that contacts any external server.

■ Notes

・Unofficial tool, not affiliated with YouTube (Google LLC)
・Intended for desktop Chrome / Brave
・YouTube layout changes may temporarily break functionality.
　Please report issues on GitHub

■ Source code

https://github.com/yuya6703-dot/YouTube-DualView
```

---

## 権限の justification（審査で聞かれる項目）

登録画面で「なぜこの権限が必要か」を1つずつ説明する欄がある。以下をそのまま使う。

### `storage`

```
ユーザーの設定（音量、再生速度の刻み幅、表示言語など）、「次に再生」キュー、
タイムスタンプメモをブラウザ内に保存し、次回起動時に復元するために使用します。
外部への送信は行いません。
```

```
Used to save user settings (volume, speed step, display language), the up-next
queue, and timestamp notes inside the browser so they persist across sessions.
Nothing is transmitted externally.
```

### `tabs`

```
操作対象となるYouTubeのタブを特定し、そのタブへ再生コマンドを送るために
使用します。また、サブ画面ウィンドウの開閉と、対象タブが閉じられた際の
サブ画面の自動クローズに使用します。タブの閲覧履歴の収集は行いません。
```

```
Used to identify which YouTube tab to control and to send playback commands to
it, and to open/close the sub window (including closing it automatically when
the target tab is closed). Browsing history is not collected.
```

### `host_permissions: https://www.youtube.com/*`

```
YouTubeの動画ページ上で、プレイヤーの操作、関連動画一覧とコメントの読み取り、
コメントの投稿を行うために必要です。YouTube以外のサイトにはアクセスしません。
```

```
Required to control the player, read the related-video list and comments, and
post comments on YouTube video pages. No other site is accessed.
```

### `host_permissions: https://api-free.deepl.com/*`

```
コメントの手動翻訳機能（設定画面でDeepL APIキーを登録した場合のみ有効）で
使用します。ユーザーがコメントごとに「翻訳」ボタンを押した時だけ、その
コメントの本文をDeepLの翻訳APIへ送信します。自動送信・一括送信は行いません。
APIキーを設定していない場合、この権限を使う通信は一切発生しません。
```

```
Used by the optional comment translation feature (only active once a DeepL
API key is set on the settings page). Sends a comment's text to DeepL's
translation API only when the user presses "Translate" on that specific
comment. No automatic or bulk sending occurs. With no API key configured,
no traffic uses this permission at all.
```

### リモートコードの使用

```
使用していません。すべてのコードは拡張機能のパッケージに同梱されています。
翻訳機能で送信するのはコメントのテキストのみで、コードやスクリプトの
ダウンロード・実行は行いません。
```

---

## 「データの取り扱い」タブの申告内容

Chrome Web Storeの必須項目。以下のとおり申告する。

- 収集するデータの種類: **すべて「収集しない」**
  （個人情報、健康情報、金融情報、認証情報、個人的な連絡先、位置情報、
  ユーザーアクティビティ、ウェブ閲覧履歴 — いずれもチェックしない）

  ★ 翻訳機能で送信するコメント本文は「ユーザーが個別に選んだ操作の結果として、
  第三者の翻訳サービスへ都度送るデータ」であり、Chrome Web Storeが言う
  「収集（collect）」＝開発者側が集める・保持するデータには該当しない
  （開発者はこの通信を一切経由・記録しない）。この整理で「収集しない」の
  申告と矛盾しないが、**審査時に指摘された場合は、この翻訳機能の存在と
  動作条件を追加で説明できるようにしておくこと**
- 以下の3つの宣言にすべてチェックを入れる:
  - 承認された用途以外にデータを使用または転送していない
  - 第三者に販売していない
  - 信用調査や融資目的で使用または転送していない

---

## 必要な画像素材

| 用途 | サイズ | 状態 |
|---|---|---|
| ストアアイコン | 128×128 | ✅ `assets/icon.png`(512×512)から自動生成済み |
| スクリーンショット | 1280×800 または 640×400 | ⬜ **未作成**（最低1枚、最大5枚） |
| 小さいプロモーションタイル | 440×280 | ⬜ 任意 |
| マーキーのプロモーションタイル | 1400×560 | ⬜ 任意 |

### スクリーンショットの推奨内容

実際の画面を撮る必要があるため、開発者本人の作業が必要。以下が撮れると伝わりやすい:

1. メイン画面が全画面再生中で、サブ画面に関連動画が並んでいる様子（この拡張の主目的）
2. コメント欄（返信の展開や投稿欄が見えている状態）
3. 「次に再生」キューにドラッグで並べ替えできる様子
4. タイムスタンプメモ
5. 関連動画とコメントの半々表示

---

## GitHub Pages の有効化手順（プライバシーポリシー公開）

プライバシーポリシーはURLとして公開されている必要がある。
`docs/privacy-policy.md` を GitHub Pages で公開するのが最も手軽。

1. <https://github.com/yuya6703-dot/YouTube-DualView/settings/pages> を開く
2. 「Source」で **Deploy from a branch** を選ぶ
3. Branch: **main** / フォルダ: **/docs** を選んで **Save**
4. 数分待つと以下のURLで公開される:
   `https://yuya6703-dot.github.io/YouTube-DualView/privacy-policy`
5. ブラウザで開けることを確認してから、ストア登録画面に貼る

---

## デベロッパー登録

Chrome Web Storeで公開するには、Googleアカウントでのデベロッパー登録が必要
（初回のみ登録料 $5）。

<https://chrome.google.com/webstore/devconsole>

★ 支払いを伴う手続きのため、開発者本人が行うこと。

---

## 提出用パッケージの作り方

```bash
pnpm build
```

`build/chrome-mv3-prod` をZIP圧縮したものをアップロードする。
（Plasmoは `pnpm package` でZIPを直接生成することもできる）
