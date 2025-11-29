@echo off
REM 使用 Windows Terminal 启动（最佳 UTF-8 支持）

REM 检查是否安装了 Windows Terminal
where wt >nul 2>nul
if %errorlevel% neq 0 (
    echo Windows Terminal 未安装，使用 PowerShell 启动...
    powershell -ExecutionPolicy Bypass -File start-console.ps1
    exit /b
)

REM 使用 Windows Terminal 启动
wt -w 0 new-tab --title "Exploding Kittens" pwsh -NoExit -Command "& { chcp 65001 > $null; $OutputEncoding = [System.Text.Encoding]::UTF8; node console-client.js }"
