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
メイン画面でYouTubeを全画面再生したまま、サブモニターから関連動画・コメント・検索を操作できます。
```

（50文字）

### English

```
Watch YouTube fullscreen on one monitor while browsing related videos, comments, and search from another.
```

（104 characters）

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
　メイン画面をスクロールせずに関連動画を一覧表示（再生回数・投稿時期つき）。クリックでそのまま再生。
　全画面表示のまま動画を切り替えられます

・コメント
　スクロールするだけで最後まで自動読み込み。返信とその返信の表示、いいね、
　新規コメントの投稿、返信の投稿、長いコメントの折りたたみ、固定コメントの表示に対応
　コメント内のURLはクリックで別タブに開き、タイムスタンプはその位置へジャンプします

・コメント翻訳（任意）
　自分のDeepL APIキーを設定すると、コメントごとに翻訳と原文を切り替えられます

・検索
　サブ画面から検索し、メイン画面に結果を表示

・表示のカスタマイズ
　関連動画とコメントの半々表示、文字サイズ・カード サイズの変更、
　日本語／英語の切り替え

■ プライバシー

この拡張機能は利用状況の収集やアクセス解析を行いません。設定は
あなたのブラウザ内にのみ保存されます。任意のコメント翻訳機能を設定した場合だけ、
「翻訳」を押したコメント本文・翻訳先言語・APIキーをDeepLへ直接送信します。
自動送信・一括送信は行いません。サブ画面から投稿したコメントと返信は、
明示的に投稿ボタンを押した場合だけYouTubeへ送信されます。開発者のサーバーへの送信はありません。

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
　Scroll to load everything automatically. View replies and replies to
　replies, like comments, post new comments and replies, collapse long
　comments, and see pinned comments.
　URLs in comments open in a new tab; timestamps jump the main video there

・Comment translation (optional)
　Set your own DeepL API key to switch any comment between translation and
　the original

・Search
　Search from the sub window and show results on the main screen

・Display options
　Split view for related videos and comments, adjustable font and card sizes,
　and Japanese/English UI

■ Privacy

This extension does not collect usage analytics. Your settings are stored
only inside your browser. If you configure the optional
comment translation feature, only the comment you choose to translate, the
target language, and your API key are sent directly to DeepL. Nothing is sent
automatically or in bulk. Comments and replies composed in the Popout are sent
to YouTube only when you explicitly submit them. Nothing is sent to a server
operated by the developer.

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
ユーザーの設定（音量、再生速度の刻み幅、表示言語、サブ画面の位置など）を
ブラウザ内に保存し、次回起動時に復元するために使用します。
翻訳用APIキーと翻訳先言語だけは、ユーザーがコメントの「翻訳」を押したときに限り、
DeepLへ直接送信されます。その他の保存データは外部へ送信しません。
```

```
Used to save user settings (volume, speed step, display language, sub-window
position) inside the browser so they persist across sessions.
Only the translation API key and target language are sent externally: they go
directly to DeepL when the user chooses to translate a comment. No other stored
data is transmitted.
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
コメントの投稿を行うために必要です。この権限をYouTube以外には使用しません。
```

```
Required to control the player, read the related-video list and comments, and
post comments on YouTube video pages. This permission is not used on other sites.
```

### `host_permissions: https://api-free.deepl.com/*`

```
コメントの手動翻訳機能（設定画面でDeepL APIキーを登録した場合のみ有効）で
使用します。ユーザーがコメントごとに「翻訳」ボタンを押した時だけ、その
コメントの本文・翻訳先言語・APIキーをDeepLの翻訳APIへ送信します。
自動送信・一括送信は行いません。
APIキーを設定していない場合、この権限を使う通信は一切発生しません。
```

```
Used by the optional comment translation feature (only active once a DeepL
API key is set on the settings page). Sends a comment's text, the target
language, and the API key to DeepL's translation API only when the user presses
"Translate" on that specific comment. No automatic or bulk sending occurs.
With no API key configured, no traffic uses this permission at all.
```

### リモートコードの使用

```
使用していません。すべてのコードは拡張機能のパッケージに同梱されています。
翻訳機能ではコメントのテキスト・翻訳先言語・APIキーを送信しますが、
コードやスクリプトのダウンロード・実行は行いません。
```

---

## 「データの取り扱い」タブの申告内容

Chrome Web Storeの必須項目。以下のとおり申告する。

- 収集・取り扱うデータの種類（現在の管理画面で同等の項目を選ぶ）:
  - **認証情報** — DeepL APIキーをブラウザ内に保存し、翻訳時だけDeepLへ送信する
  - **ウェブサイトのコンテンツ** — YouTube上の動画情報・関連動画・コメントを
    サブ画面へ表示し、選択されたコメント本文だけを翻訳時にDeepLへ送信する
  - **個人的な連絡先／ユーザー生成コンテンツ** — ユーザーが拡張画面で入力した
    コメントと返信を、明示的な投稿操作によりYouTubeへ渡す。管理画面に
    「ユーザー生成コンテンツ」が独立して表示される場合はそちらも選ぶ
- 収集・取り扱わない種類: 健康情報、金融・支払情報、位置情報、ウェブ閲覧履歴、
  広告や分析目的のユーザーアクティビティ

  ★ Chrome Web Storeの公式FAQでは「取り扱い」に収集・送信・利用・共有が含まれ、
  ローカル処理・ローカル保存だけでも申告対象になる。開発者が通信を受け取らないことを
  理由に「すべて収集しない」を選ばないこと。実際の管理画面のラベルが更新されている場合は、
  [公式FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)の
  定義に従って最も近い項目を選ぶ
- 以下の3つの宣言にすべてチェックを入れる:
  - 承認された用途以外にデータを使用または転送していない
  - 第三者に販売していない
  - 信用調査や融資目的で使用または転送していない

### Limited Use申告文

```
YouTubeページとユーザー入力から取り扱う情報は、ストア掲載ページと拡張機能内で
説明した機能を提供する目的にのみ使用します。販売、広告、信用調査には使用せず、
開発者が閲覧・保管することもありません。外部への転送は、ユーザーが明示的に
投稿したコメント／返信をYouTubeへ渡す場合と、ユーザーが個別に翻訳を選んだ
コメント本文・翻訳先言語・APIキーをDeepLへ渡す場合に限ります。
```

```
Information handled from YouTube pages and user input is used only to provide
the features described in the store listing and extension UI. It is not sold
or used for advertising or creditworthiness, and the developer does not view
or retain it. External transfers are limited to comments or replies the user
explicitly submits to YouTube and the comment text, target language, and API
key sent to DeepL when the user explicitly requests an individual translation.
```

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
3. 長いコメントの折りたたみと返信の返信が展開された様子
4. 関連動画とコメントの半々表示

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
