@echo off
REM 设置控制台代码页为 UTF-8
chcp 65001 > nul

REM 清屏，避免编码混乱
cls

REM 设置环境变量
set PYTHONIOENCODING=utf-8
set NODE_NO_WARNINGS=1
set LANG=zh_CN.UTF-8
set LC_ALL=zh_CN.UTF-8

echo ========================================
echo    爆炸猫 - 控制台客户端
echo    Exploding Kittens - Console Client
echo ========================================
echo.
echo 用法 Usage:
echo   start-console.bat [server_address]
echo.
echo 示例 Examples:
echo   start-console.bat
echo   start-console.bat 192.168.1.213:3004
echo   start-console.bat http://game.server.com:3004
echo.
echo 正在启动... Starting...
echo.

REM 切换到脚本所在目录
cd /d "%~dp0"

REM 检查文件是否存在
if not exist "console-client.js" (
    echo Error: console-client.js not found!
    echo Please make sure you are running this script from the project directory.
    pause
    exit /b 1
)

REM 检查 node_modules 是否存在
if not exist "node_modules" (
    echo.
    echo Warning: node_modules folder not found!
    echo Installing dependencies...
    echo.
    call npm install
    echo.
    if errorlevel 1 (
        echo Error: Failed to install dependencies!
        pause
        exit /b 1
    )
)

REM 传递所有命令行参数给 node 脚本
node "console-client.js" %*

pause
