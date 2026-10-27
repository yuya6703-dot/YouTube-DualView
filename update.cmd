@echo off
rem ============================================================
rem  YouTube DualView - 最新版に更新
rem  ブラウザに読み込んでいる build\chrome-mv3-prod を、最新のコードで作り直す。
rem  終わったら、拡張機能の管理画面で DualView の再読み込みボタンを押す。
rem  （開発中の差分ビルドは dev.cmd。こちらは普段使いの本番ビルド用）
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title YouTube DualView - 最新版に更新

where pnpm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] pnpm が見つかりません。次を実行してください:
  echo         npm install -g pnpm
  echo.
  pause
  exit /b 1
)

rem 取り込み前のコミット。取り込みで依存関係（package.json / lockfile）が変わったかを見るのに使う。
rem git が無い・リポジトリでない場合は空のままで、取り込みを飛ばして今のコードで作り直す。
set "BEFORE="
where git >nul 2>nul && for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "BEFORE=%%H"

rem ★ dev.cmd と同じ理由で、取り込みから最後までを1つの ( ) にまとめ、最後は exit /b で抜ける
rem   （git pull がこのファイル自身を書き換えても、実行が崩れないようにするため）。
rem ★ --ff-only なので、手元の変更を上書きしたりマージを作ったりはしない。
rem ★ ( ) の中の echo に半角の丸かっこを書かないこと（ブロックがそこで閉じてしまう）。
(
  set "NEED_INSTALL="
  if not exist "node_modules\" set "NEED_INSTALL=1"

  if defined BEFORE (
    echo [INFO] 最新のコードを取り込んでいます...
    git pull --ff-only || echo [WARN] 最新のコードを取り込めませんでした。今のコードのまま作り直します。
    git diff --quiet %BEFORE% HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml || set "NEED_INSTALL=1"
  ) else (
    echo [WARN] git が使えないため、最新のコードの取り込みを飛ばします。
  )

  if defined NEED_INSTALL (
    echo [INFO] 依存パッケージを入れています（pnpm install）...
    call pnpm install || (
      echo.
      echo [ERROR] pnpm install に失敗しました。何かキーを押すと閉じます。
      pause >nul
      exit /b 1
    )
  )

  echo [INFO] 拡張機能を作り直しています（pnpm build）...
  call pnpm build || (
    echo.
    echo [ERROR] ビルドに失敗しました。何かキーを押すと閉じます。
    pause >nul
    exit /b 1
  )

  echo.
  echo ============================================================
  echo  作り直しました。最後に次の2つをしてください。
  echo   1. 拡張機能の管理画面で DualView の再読み込みボタンを押す
  echo   2. YouTube のタブを再読み込みする
  echo  何かキーを押すと閉じます。
  echo ============================================================
  pause >nul
  exit /b
)
