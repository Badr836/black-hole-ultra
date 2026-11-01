@echo off
chcp 65001 >nul
title BlackHole Ultra - One-click setup
echo.
echo   BlackHole Ultra Downloader
echo   Setting up the app and publishing it on your private Tailscale network.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-start.ps1"
if errorlevel 1 pause
