@echo off
setlocal enabledelayedexpansion
title USB-Reddit Server (Windows)

chcp 65001 >nul

cd /d "%~dp0"

echo ===========================================
echo   Starting USB-Reddit (Windows)...
echo ===========================================

REM 1. Detect and Extract Node.js
set "NODE_BIN=node"
set "LOCAL_NODE=bin\node.exe"

if exist "!LOCAL_NODE!" (
    echo [Info] Using local Node.js: !LOCAL_NODE!
    set "PATH=%~dp0bin;!PATH!"
    set "NODE_BIN=%~dp0bin\node.exe"
) else (
    where node >nul 2>nul
    if !ERRORLEVEL! EQU 0 (
        echo [Info] Using system Node.js.
    ) else (
        echo [Error] Node.js not found! Please ensure bin\node.exe exists.
        pause
        exit /b 1
    )
)

REM 2. Perfect Portable Module Swapping (Zero Install)
echo [Info] Verifying portable dependencies...

:: Rename current node_modules to its correct architecture if needed
if exist "node_modules\.os_mac_x64" (
    ren node_modules node_modules_mac_x64
) else if exist "node_modules\.os_mac_arm64" (
    ren node_modules node_modules_mac_arm64
) else if exist "node_modules\.os_win" (
    :: Already Windows, no action needed for hiding
)

:: If Windows node_modules is hidden, swap it to active
if exist "node_modules_win" (
    if exist "node_modules" rmdir /s /q node_modules
    ren node_modules_win node_modules
)

if not exist "node_modules" (
    echo [Error] Portable node_modules not found!
    echo Please ensure the USB has the pre-bundled node_modules folders.
    pause
    exit /b 1
)

:: Ensure .os_win marker exists
if not exist "node_modules\.os_win" (
    echo win > "node_modules\.os_win"
)

REM 3. Launch Server
echo [Info] Launching Server...
if not exist "data" mkdir "data"
if not exist "exports" mkdir "exports"
if not exist "public\uploads" mkdir "public\uploads"

"!NODE_BIN!" server/server.js
if !ERRORLEVEL! NEQ 0 goto :SERVER_ERROR
echo [Info] 서버가 정상적으로 종료되었습니다.
pause
exit /b 0

:SERVER_ERROR
echo.
echo [Error] Server exited unexpectedly.
pause
exit /b 1
