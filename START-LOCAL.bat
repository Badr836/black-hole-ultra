@echo off
chcp 65001 >nul
title BlackHole Ultra - local run
echo.
echo   BlackHole Ultra Downloader - local setup
echo   Installs what is missing, builds, starts the app on http://localhost:3000
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-start.ps1"
if errorlevel 1 pause
