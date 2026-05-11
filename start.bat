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

REM 2. Check Dependencies & OS Swap
:: Check if current node_modules belongs to Mac
if exist "node_modules\.os_mac" (
    echo [Info] Mac node_modules detected. Swapping to Windows...
    if exist "node_modules_mac" rmdir /s /q node_modules_mac
    ren node_modules node_modules_mac
)

:: If Windows node_modules exists, rename it to active
if exist "node_modules_win" (
    ren node_modules_win node_modules
)

if not exist "node_modules" goto :INSTALL_DEPS

echo [Info] Checking dependencies (sqlite3 check)...
"!NODE_BIN!" server/check_deps.js
if !ERRORLEVEL! NEQ 0 goto :REINSTALL_DEPS

:: Ensure .os_win marker exists
if not exist "node_modules\.os_win" (
    echo win > "node_modules\.os_win"
)
goto :RUN_SERVER

:INSTALL_DEPS
echo [Info] Installing dependencies for Windows...
where npm >nul 2>nul
if !ERRORLEVEL! NEQ 0 goto :NPM_NOT_FOUND
call npm install --no-audit --no-fund
if !ERRORLEVEL! NEQ 0 goto :INSTALL_FAILED
:: Create marker file for Windows
echo win > "node_modules\.os_win"
goto :RUN_SERVER

:REINSTALL_DEPS
echo [Warning] Dependencies are invalid or mismatch.
echo [Info] Re-installing dependencies...
if exist "node_modules" rmdir /s /q node_modules
goto :INSTALL_DEPS

:NPM_NOT_FOUND
echo [Error] npm을 찾을 수 없습니다. bin 폴더에 npm.cmd가 있는지 확인하세요.
pause
exit /b 1

:INSTALL_FAILED
echo [Error] npm install 실패. 인터넷 연결 또는 권한을 확인하세요.
pause
exit /b 1

:RUN_SERVER
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
