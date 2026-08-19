@echo off
rem ============================================================
rem  YouTube DualView - 開発サーバー起動
rem  デスクトップのショートカットから呼ばれる。
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

if not exist "node_modules\" (
  echo [INFO] node_modules がありません。pnpm install を実行します...
  call pnpm install || goto :failed
)

echo.
echo   拡張の読み込み先: %CD%\build\chrome-mv3-dev
echo   brave://extensions ^> 開発者モード ^> パッケージ化されていない拡張機能を読み込む
echo   起動: YouTube動画ページで Alt+Y
echo.
echo   ※ manifest 系（package.json の manifest ブロック）を変えたら
echo     拡張カードの再読み込みボタンを押すこと
echo.

call pnpm dev

:failed
echo.
echo ============================================================
echo  pnpm dev が終了しました。何かキーを押すと閉じます。
echo ============================================================
pause >nul
