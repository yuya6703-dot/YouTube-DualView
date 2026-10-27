@echo off
rem ============================================================
rem  YouTube DualView - 開発サーバー起動
rem  デスクトップのショートカットから呼ばれる。
rem  起動するたびに最新のコードを取り込んで（git pull）からビルドする。
rem  このウィンドウは開いたままにすること（閉じると差分ビルドが止まる）。
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title YouTube DualView - pnpm dev

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js が見つかりません。Node.js 20.9以上をインストールしてください。
  echo.
  pause
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number);process.exit(Math.sign(v[0]*1000+v[1]-20009)===-1?1:0)"
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js 20.9以上が必要です。現在: 
  node --version
  echo.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] pnpm が見つかりません。次を実行してください:
  echo         npm install -g pnpm
  echo.
  pause
  exit /b 1
)

set "PNPM_MAJOR=0"
for /f "tokens=1 delims=." %%V in ('pnpm --version') do set "PNPM_MAJOR=%%V"
if %PNPM_MAJOR% LSS 11 (
  echo.
  echo [ERROR] pnpm 11以上が必要です。現在:
  pnpm --version
  echo         npm install -g pnpm@11
  echo.
  pause
  exit /b 1
)

rem 取り込み前のコミット。取り込みで依存関係（package.json / lockfile）が変わったかを見るのに使う。
rem git が無い・リポジトリでない場合は空のままで、取り込みを飛ばして今のコードで起動する。
set "BEFORE="
where git >nul 2>nul && for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "BEFORE=%%H"

rem ★ ここから最後までを1つの ( ) にまとめているのは、git pull がこの dev.cmd 自身を
rem   書き換えても実行が崩れないようにするため。cmd はバッチを1行ずつファイルから読み直しながら
rem   実行するが、( ) の中は最初にまとめて読み込む。最後は必ず exit /b で抜けて、続きを読ませない。
rem ★ --ff-only なので、手元の変更を上書きしたりマージを作ったりはしない。取り込めなくても
rem   （オフライン、手元の変更と衝突しているなど）今のコードのまま起動する。
rem ★ ( ) の中の echo に半角の丸かっこを書かないこと（ブロックがそこで閉じてしまう）。
rem   フォルダのパスのように読み込み前に展開される値も、かっこを含み得るので引用符で囲む。
(
  set "NEED_INSTALL="
  if not exist "node_modules\" set "NEED_INSTALL=1"

  if defined BEFORE (
    echo [INFO] 最新のコードを取り込んでいます...
    git pull --ff-only || echo [WARN] 最新のコードを取り込めませんでした。今のコードのまま起動します。
    git diff --quiet %BEFORE% HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml || set "NEED_INSTALL=1"
  ) else (
    echo [WARN] git が使えないため、最新のコードの取り込みを飛ばします。
  )

  if defined NEED_INSTALL (
    echo [INFO] 依存パッケージを入れています（pnpm install）...
    call pnpm install || (
      echo.
      echo ============================================================
      echo  pnpm install に失敗しました。何かキーを押すと閉じます。
      echo ============================================================
      pause >nul
      exit /b 1
    )
  )

  echo.
  echo   拡張の読み込み先: "%CD%\build\chrome-mv3-dev"
  echo   brave://extensions ^> 開発者モード ^> パッケージ化されていない拡張機能を読み込む
  echo   起動: YouTube動画ページで Alt+Y
  echo   更新: このウィンドウを閉じて開き直すと、最新のコードを取り込んでから起動する
  echo         （更新したら YouTube のタブも再読み込みする）
  echo.
  echo   ※ manifest 系（package.json の manifest ブロック）を変えたら
  echo     拡張カードの再読み込みボタンを押すこと
  echo.

  call pnpm dev

  echo.
  echo ============================================================
  echo  pnpm dev が終了しました。何かキーを押すと閉じます。
  echo ============================================================
  pause >nul
  exit /b
)
