@echo off
setlocal enabledelayedexpansion
title USB-Reddit Server (Windows)

chcp 65001 >nul

cd /d "%~dp0"

rem Colors via ANSI escape codes (works in Windows 10+)
set "GREEN=[32m"
set "BLUE=[34m"
set "YELLOW=[33m"
set "RED=[31m"
set "NC=[0m"

echo %BLUE%===========================================%NC%
echo %BLUE%   Starting USB-Reddit (Windows)...         %NC%
echo %BLUE%===========================================%NC%

REM 1. Detect and Extract Node.js
set "NODE_BIN=node"
set "LOCAL_NODE=bin\node.exe"

if exist "!LOCAL_NODE!" (
    echo %GREEN%[Info] Using local Node.js: !LOCAL_NODE!%NC%
    set "PATH=%~dp0bin;!PATH!"
    set "NODE_BIN=%~dp0bin\node.exe"
) else (
    where node >nul 2>nul
    if !ERRORLEVEL! EQU 0 (
        echo %GREEN%[Info] Using system Node.js.%NC%
    ) else (
        echo %RED%[Error] Node.js not found! Please ensure bin\node.exe exists.%NC%
        pause
        exit /b 1
    )
)

echo %GREEN%[Info] Node.js version: %NC%
"!NODE_BIN!" --version

REM 2. Perfect Portable Module Swapping (Zero Install)
echo %YELLOW%[Info] Verifying portable dependencies...%NC%

rem Hide current node_modules if it's not the target Windows one
if exist "node_modules" (
    if not exist "node_modules\.os_win" (
        if exist "node_modules\.os_mac_x64" (
            ren node_modules node_modules_mac_x64
        ) else if exist "node_modules\.os_mac_arm64" (
            ren node_modules node_modules_mac_arm64
        ) else (
            rem Unknown state, assume mac x64 to be safe
            ren node_modules node_modules_mac_x64
        )
    )
)

rem Swap the target node_modules in
if exist "node_modules_win" (
    if exist "node_modules" (
        rmdir /s /q node_modules
    )
    ren node_modules_win node_modules
)

if not exist "node_modules" (
    echo %RED%[Error] Portable node_modules not found!%NC%
    echo Please ensure the USB has the pre-bundled node_modules folders.
    pause
    exit /b 1
)

rem Ensure .os_win marker exists
if not exist "node_modules\.os_win" (
    echo win > "node_modules\.os_win"
)

REM 3. Ensure necessary directories exist
if not exist "data" mkdir "data"
if not exist "data\uploads" mkdir "data\uploads"
if not exist "exports" mkdir "exports"

REM 4. Launch Server
echo %BLUE%[Info] Launching Server...%NC%
"!NODE_BIN!" server/server.js
if !ERRORLEVEL! NEQ 0 goto :SERVER_ERROR
echo %GREEN%[Info] Server shut down normally.%NC%
pause
exit /b 0

:SERVER_ERROR
echo.
echo %RED%[Error] Server crashed or stopped unexpectedly.%NC%
pause
exit /b 1
