@echo off
rem ============================================================
rem  YouTube DualView - 最新版に更新 ＋ 自動更新の登録
rem  GitHub の最新の Release を build\chrome-mv3-prod（ブラウザが読み込んでいるフォルダ）に入れ、
rem  Windows にサインインするたびに同じことを自動で行うよう登録する。
rem  初回に1度実行すれば、以後は何もしなくてよい（中身は scripts\auto-update.mjs）。
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title YouTube DualView - 最新版に更新

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js が見つかりません。Node.js をインストールしてください。
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\auto-update.mjs" --install
if errorlevel 1 (
  echo.
  echo 何かキーを押すと閉じます。
  pause >nul
  exit /b 1
)

echo.
echo ============================================================
echo  ブラウザを開き直すと新しい版に切り替わります。
echo  すぐ切り替えるなら、拡張機能の管理画面で DualView の再読み込みボタンを押す。
echo  次回からは、Windows にサインインしたときに自動で更新されます。
echo  何かキーを押すと閉じます。
echo ============================================================
pause >nul
