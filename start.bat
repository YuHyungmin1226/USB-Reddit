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

if not exist "!LOCAL_NODE!" (
    echo [Info] node.exe not found. Checking for archives...
    
    if exist "bin\node-*.zip" (
        for %%F in (bin\node-*.zip) do (
            echo [Info] Found compressed Node.js: %%F
            echo [Info] Extracting...
            powershell -Command "Expand-Archive -Path '%%F' -DestinationPath 'bin\tmp_extract' -Force"
            
            for /r "bin\tmp_extract" %%N in (node.exe) do (
                if exist "%%N" move /y "%%N" "bin\node.exe" >nul
            )
            for /r "bin\tmp_extract" %%N in (npm.cmd) do (
                if exist "%%N" move /y "%%N" "bin\npm.cmd" >nul
            )
            
            rmdir /s /q "bin\tmp_extract"
            echo [Success] Extraction complete.
        )
    )
)

if exist "!LOCAL_NODE!" (
    echo [Info] Using local Node.js: !LOCAL_NODE!
    set "PATH=%~dp0bin;!PATH!"
    set "NODE_BIN=%~dp0bin\node.exe"
) else (
    where node >nul 2>nul
    if !ERRORLEVEL! EQU 0 (
        echo [Info] Using system Node.js.
    ) else (
        echo [Error] Node.js not found! Please put zip file in bin folder.
        pause
        exit /b 1
    )
)

REM 2. OS Swap for node_modules
if exist "node_modules\.os_mac" (
    echo [Info] Mac node_modules detected. Swapping to Windows...
    if exist "node_modules_mac" rmdir /s /q node_modules_mac
    ren node_modules node_modules_mac
)

if not exist "node_modules" (
    if exist "node_modules_win" (
        ren node_modules_win node_modules
    ) else (
        echo [Warning] node_modules folder missing.
    )
)

REM 3. Run Server
echo [Info] Launching Server...
if not exist "data" mkdir "data"
if not exist "exports" mkdir "exports"
if not exist "public\uploads" mkdir "public\uploads"

"!NODE_BIN!" server/server.js
if !ERRORLEVEL! NEQ 0 (
    echo.
    echo [Error] Server exited unexpectedly.
    pause
    exit /b 1
)

pause
exit /b 0
