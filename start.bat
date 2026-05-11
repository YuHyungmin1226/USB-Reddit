@echo off
setlocal enabledelayedexpansion
title USB-Reddit Server

:: Use UTF-8 for console
chcp 65001 >nul

cd /d "%~dp0"

echo ===========================================
echo   Starting USB-Reddit...
echo ===========================================

:: 1. Detect Node.js
set "NODE_PATH_MODE="

if exist "bin\node.exe" goto :SET_LOCAL_NODE
where node >nul 2>nul
if !ERRORLEVEL! EQU 0 goto :SET_SYSTEM_NODE
goto :NODE_NOT_FOUND

:SET_LOCAL_NODE
echo [Info] Local Node.js detected in bin folder.
set "PATH=%~dp0bin;!PATH!"
set "NODE_PATH_MODE=Local"
goto :NODE_DETECTED

:SET_SYSTEM_NODE
echo [Info] System Node.js detected.
set "NODE_PATH_MODE=System"
goto :NODE_DETECTED

:NODE_NOT_FOUND
echo [Error] Node.js를 찾을 수 없습니다!
echo.
echo 이 프로젝트는 휴대용(Portable) 모드를 지원합니다:
echo 1. https://nodejs.org/ko/download/prebuilt-binaries 에서 "Windows Binary (.zip)"를 다운로드하세요.
echo 2. 압축을 푼 뒤 모든 파일을 프로젝트의 "bin" 폴더에 넣으세요.
echo    (node.exe 파일이 bin 폴더 바로 안에 보여야 합니다.)
echo 3. 그 후 이 파일을 다시 실행해 주세요.
echo.
pause
exit /b 1

:NODE_DETECTED
echo [Info] Node.js version:
node -v
if errorlevel 1 (
    echo [Error] Node.exe 실행에 실패했습니다.
    pause
    exit /b 1
)

:: 2. Check Dependencies & OS Swap
:: Check if current node_modules belongs to Mac
if exist "node_modules\.os_mac" (
    echo [Info] Mac node_modules detected. Swapping to Windows...
    ren node_modules node_modules_mac
)

:: If Windows node_modules exists, rename it to active
if exist "node_modules_win" (
    ren node_modules_win node_modules
)

if not exist "node_modules" goto :INSTALL_DEPS

echo [Info] Checking dependencies (sqlite3 check)...
node server/check_deps.js
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
node server/server.js
if !ERRORLEVEL! NEQ 0 goto :SERVER_ERROR
echo [Info] 서버가 정상적으로 종료되었습니다.
pause
exit /b 0

:SERVER_ERROR
echo.
echo [Error] 서버가 예기치 않게 종료되었습니다.
echo [Tip] 만약 'EADDRINUSE' 오류가 보인다면, 이미 서버가 실행 중인 것입니다.
echo [Tip] 브라우저에서 http://localhost:3000 에 접속하여 확인해 보세요.
echo.
pause
exit /b 1
