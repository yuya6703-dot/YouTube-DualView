# YouTube DualView

[![CI](https://github.com/yuya6703-dot/YouTube-DualView/actions/workflows/ci.yml/badge.svg)](https://github.com/yuya6703-dot/YouTube-DualView/actions/workflows/ci.yml)

メインモニタでYouTubeをフルスクリーン再生しつつ、サブモニタの独立ウィンドウから
関連動画・コメント・検索・次に再生キューなどを操作するための個人用Chrome拡張機能。

完全個人利用（Chrome Web Storeへの公開予定なし）。Manifest V3 / [Plasmo Framework](https://www.plasmo.com/) / React / TypeScript。

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
