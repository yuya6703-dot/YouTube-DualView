---
title: Privacy Policy — DualView for YouTube
---

# プライバシーポリシー / Privacy Policy

**DualView for YouTube**

最終更新日 / Last updated: 2026-08-20

---

## 日本語

### 収集する情報

**この拡張機能は、利用状況の収集・アクセス解析・クラッシュレポートの送信を
一切行いません。** 開発者を含む第三者が、あなたの利用状況を知る手段はありません。

**コメントの翻訳機能（任意・既定でオフ）を除き、外部サーバーへ通信する
コードは実装されていません。**

### コメントの翻訳機能について

サブ画面のコメントには「翻訳」ボタンがあります。これは**あなたが設定画面で
DeepL（翻訳サービス）のAPIキーを登録した場合にだけ表示され**、
**あなたがコメントごとに個別にボタンを押した時にだけ**動作します。

- 送信されるのは、あなたが翻訳ボタンを押した**そのコメントの本文だけ**です
- 自動翻訳・一括送信は行いません。ボタンを押していないコメントの内容は送信されません
- 送信先はDeepL（DeepL SE, ドイツ）のAPIサーバーです。DeepLでのデータの
  扱いについては [DeepLのプライバシーポリシー](https://www.deepl.com/ja/privacy)
  を参照してください。特に無料枠のAPIキーを使う場合、送信した文章が
  DeepL側の翻訳品質向上に利用される場合があります（DeepLの規約による）
- APIキーを設定していなければ、この機能は完全に無効で、何も送信されません
- APIキー自体もあなたのブラウザ内（`chrome.storage`）にのみ保存され、
  開発者を含む第三者には送られません

### 保存される情報とその保存場所

この拡張機能は、以下の情報をあなたのブラウザ内（`chrome.storage`）にのみ保存します。
これらがあなたのコンピュータから外へ出ることはありません。

| 保存する内容 | 目的 |
|---|---|
| 設定（音量・再生速度の刻み幅・自動再生の可否・表示言語など） | 次回起動時に設定を復元するため |
| 「次に再生」キュー | ブラウザを閉じても再生予定リストを保持するため |
| タイムスタンプメモ | あなたが書いたメモを保持するため |
| サブ画面のウィンドウ位置・サイズ・分割比率・文字サイズ | 前回と同じ配置で開くため |

これらはすべて、ブラウザから拡張機能を削除すると同時に消去されます。

### 権限を必要とする理由

| 権限 | 理由 |
|---|---|
| `storage` | 上記の設定・キュー・メモをあなたのブラウザ内に保存するため |
| `tabs` | 操作対象のYouTubeタブを特定し、サブ画面ウィンドウを開閉するため |
| `https://www.youtube.com/*` | YouTubeのページ上で、再生操作・関連動画やコメントの読み取りを行うため |
| `https://api-free.deepl.com/*` | コメントの「翻訳」ボタンを押した時だけ、DeepLの翻訳APIへ接続するため |

この拡張機能がアクセスするのはYouTubeと、翻訳機能を使った場合のDeepLのみです。

### 外部サービスとの関係

この拡張機能は、YouTube（Google LLC）とは**一切関係のない非公式のツール**です。
Google LLCによる承認・提携・後援を受けていません。

拡張機能内に表示されるサムネイル画像やプロフィール画像は、YouTubeのページ上に
既に存在する画像をそのまま表示しているものです。

### お問い合わせ

不具合の報告やご質問は、GitHubのIssueページからお願いします。
<https://github.com/yuya6703-dot/YouTube-DualView/issues>

---

## English

### Information We Collect

**This extension does not collect usage analytics, and has no crash or usage
reporting.** Neither the developer nor any third party has any way to learn
how you use it.

**Aside from the optional, off-by-default comment translation feature, there
is no code in this extension that contacts any external server.**

### About the Comment Translation Feature

The Popout shows a "Translate" button on comments. It **only appears once
you've entered a DeepL (translation service) API key on the settings page**,
and **only acts when you press it on a specific comment**.

- Only the text of the comment you clicked "Translate" on is sent — nothing else
- No automatic or bulk translation happens. Comments you never click stay untouched
- It's sent to DeepL's (DeepL SE, Germany) API servers. See
  [DeepL's privacy policy](https://www.deepl.com/en/privacy) for how they
  handle it — notably, text sent through a free-tier API key may be used by
  DeepL to improve translation quality, per DeepL's own terms
- With no API key configured, this feature is fully inactive and nothing is sent
- The API key itself is stored only in your browser (`chrome.storage`) and is
  never sent anywhere except to DeepL when you translate a comment

### What Is Stored, and Where

The extension stores the following in your browser only (`chrome.storage`).
None of it ever leaves your computer.

| Stored data | Purpose |
|---|---|
| Settings (volume, speed step, autoplay preference, display language, etc.) | To restore your preferences next time |
| "Up next" queue | To keep your planned playlist across browser restarts |
| Timestamp notes | To keep the notes you wrote |
| Sub-window position, size, split ratio, font size | To reopen with the same layout |

All of it is deleted when you remove the extension from your browser.

### Why Each Permission Is Needed

| Permission | Reason |
|---|---|
| `storage` | To save the settings, queue, and notes above inside your browser |
| `tabs` | To identify which YouTube tab to control, and to open/close the sub window |
| `https://www.youtube.com/*` | To control playback and read related videos and comments on YouTube pages |
| `https://api-free.deepl.com/*` | To reach DeepL's translation API, only when you press "Translate" on a comment |

This extension only ever accesses YouTube, and DeepL if you use the translation feature.

### Relationship to External Services

This is an **unofficial tool with no affiliation to YouTube** (Google LLC).
It is not endorsed by, partnered with, or sponsored by Google LLC.

Thumbnails and profile images shown inside the extension are the same images
already present on the YouTube page.

### Contact

Please report issues or ask questions via GitHub Issues:
<https://github.com/yuya6703-dot/YouTube-DualView/issues>
