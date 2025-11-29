# PowerShell 启动脚本（UTF-8 支持最好）

# 设置控制台输出编码为 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 设置环境变量
$env:LANG = "zh_CN.UTF-8"
$env:LC_ALL = "zh_CN.UTF-8"
$env:NODE_NO_WARNINGS = "1"

# 清屏
Clear-Host

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "    爆炸猫 - 控制台客户端" -ForegroundColor Yellow
Write-Host "    Exploding Kittens" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "正在启动... Starting..." -ForegroundColor Green
Write-Host ""

# 启动 Node.js 应用
node console-client.js

Write-Host ""
Write-Host "按任意键退出..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
