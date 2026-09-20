# DualView for YouTube

[![CI](https://github.com/yuya6703-dot/YouTube-DualView/actions/workflows/ci.yml/badge.svg)](https://github.com/yuya6703-dot/YouTube-DualView/actions/workflows/ci.yml)

メインモニタでYouTubeをフルスクリーン再生しつつ、サブモニタの独立ウィンドウから
関連動画・コメント・検索などを操作するChrome拡張機能。

Manifest V3 / [Plasmo Framework](https://www.plasmo.com/) / React / TypeScript。

> YouTube（Google LLC）とは関係のない非公式のツールです。

## 主な機能

- **再生コントロール** — 再生/一時停止・シーク・音量・再生速度（0.1刻み）
- **関連動画** — メイン画面をスクロールせず一覧表示（再生回数・投稿時期つき。広告カードは除外）。全画面のまま動画を切り替え
- **コメント** — 最後まで自動読み込み・返信と返信の返信・いいね・新規投稿・返信投稿・
  長いコメントの折りたたみ・固定コメントの表示。URLは別タブで開き、
  タイムスタンプはその位置へジャンプ
- **コメント翻訳（任意）** — 自分のDeepL APIキーを設定すると、コメントごとに翻訳/原文を切り替え
- **検索** — サブ画面から検索してメイン画面に反映
- **表示のカスタマイズ** — 半々表示・文字サイズ・日本語/英語切り替え

## プライバシー

利用状況の収集やアクセス解析は行いません。設定はブラウザ内にのみ保存されます。
任意のコメント翻訳機能を設定した場合だけ、「翻訳」を押したコメント本文・翻訳先言語・
APIキーをDeepLへ直接送信します。自動送信・一括送信は行いません。
詳細は[プライバシーポリシー](docs/privacy-policy.md)を参照。

## インストール（ビルド済み）

1. [Releases](https://github.com/yuya6703-dot/YouTube-DualView/releases) から `chrome-mv3-prod.zip` をダウンロードして展開する
2. `brave://extensions`（または `chrome://extensions`）で開発者モードを有効にする
3. 「パッケージ化されていない拡張機能を読み込む」で展開したフォルダを選択する
4. YouTubeの動画ページで拡張アイコンをクリック（または `Alt + Y`）するとサブ画面が開く

Chrome Web Store での配布は準備済みですが、現時点では未公開です。

## セットアップ（開発）

```bash
pnpm install
pnpm approve-builds --all   # 初回のみ。ネイティブ依存のビルドを許可する
pnpm dev
```

`brave://extensions`（または `chrome://extensions`）で開発者モードを有効にし、
「パッケージ化されていない拡張機能を読み込む」で `build/chrome-mv3-dev` を選択する。

## スクリプト

| コマンド | 内容 |
|---|---|
| `pnpm dev` | 開発サーバー起動（差分ビルド） |
| `pnpm build` | 本番ビルド（`build/chrome-mv3-prod`） |
| `pnpm typecheck` | 型検査のみ |
| `pnpm test` | コメント読み込みの回帰テスト（jsdom上で実際のコンテンツスクリプトを実行） |
| `pnpm package` | 配布用zip（`build/chrome-mv3-prod.zip`） |
| `pnpm verify` | 型検査 + 回帰テスト + peer依存検査 + 本番ビルド + 本番依存の脆弱性監査（CIと同一） |

## 非表示にしている機能

「次に再生キュー」（並べ替え・自動連続再生）と「タイムスタンプメモ」は実装済みですが、
現在は `src/lib/features.ts` のフラグで非表示にしています。必要なら `true` に戻すだけで復活します。

詳しい設計判断・進捗・既知の罠は開発者向けの引き継ぎ資料（PROJECT.md）を参照。
