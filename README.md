# DualView for YouTube

[![CI](https://github.com/yuya6703-dot/YouTube-DualView/actions/workflows/ci.yml/badge.svg)](https://github.com/yuya6703-dot/YouTube-DualView/actions/workflows/ci.yml)

メインモニタでYouTubeをフルスクリーン再生しつつ、サブモニタの独立ウィンドウから
関連動画・コメント・検索・次に再生キューなどを操作するChrome拡張機能。

Manifest V3 / [Plasmo Framework](https://www.plasmo.com/) / React / TypeScript。

> YouTube（Google LLC）とは関係のない非公式のツールです。

## 主な機能

- **再生コントロール** — 再生/一時停止・シーク・音量・再生速度（0.1刻み）
- **関連動画** — メイン画面をスクロールせず一覧表示。全画面のまま動画を切り替え
- **コメント** — 自動読み込み・返信表示・いいね・新規投稿・返信投稿。
  URLは別タブで開き、タイムスタンプはその位置へジャンプ
- **次に再生キュー** — ドラッグで並べ替え、動画終了で自動再生
- **タイムスタンプメモ** — 再生位置に紐づくメモとジャンプ
- **検索** — サブ画面から検索してメイン画面に反映
- **表示のカスタマイズ** — 半々表示・文字サイズ・日本語/英語切り替え

## プライバシー

情報を一切収集しません。設定・キュー・メモはブラウザ内にのみ保存され、
外部サーバーへ通信するコードは実装されていません。
詳細は[プライバシーポリシー](docs/privacy-policy.md)を参照。

## セットアップ

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
| `pnpm verify` | 型検査 + peer依存検査 + 本番ビルド + 本番依存の脆弱性監査 |

詳しい設計判断・進捗・既知の罠は開発者向けの引き継ぎ資料（PROJECT.md）を参照。
