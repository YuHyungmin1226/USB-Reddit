@echo off
setlocal
title USB-Reddit Server

:: Ensure we are in the script's directory
cd /d "%~dp0"

echo ===========================================
echo   Starting USB-Reddit...
echo ===========================================

:: 1. Detect Node.js
set "NODE_PATH="

:: Try local bin first
if exist "bin\node.exe" (
    echo [Info] Local Node.js detected in bin folder.
    set "PATH=%~dp0bin;%PATH%"
    set "NODE_PATH=Local"
    goto NODE_FOUND
)

:: Try system path
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [Info] System Node.js detected.
    set "NODE_PATH=System"
    goto NODE_FOUND
)

:NODE_NOT_FOUND
echo [Error] Node.js를 찾을 수 없습니다!
echo.
echo 이 프로젝트는 휴대용(Portable) 모드를 지원합니다:
echo 1. https://nodejs.org/ko/download/prebuilt-binaries 에서 "Windows Binary (.zip)"를 다운로드하세요.
echo 2. 압축을 푼 뒤 모든 파일을 프로젝트의 "bin" 폴더에 넣으세요.
echo 3. 그 후 이 파일을 다시 실행해 주세요.
echo.
pause
exit /b 1

:NODE_FOUND
echo [Info] Node.js version:
node -v
if errorlevel 1 (
    echo [Error] Node.exe 실행에 실패했습니다.
    pause
    exit /b 1
)

:: 2. Check if node_modules exists
if exist "node_modules" goto CHECK_DEPS

echo [Info] node_modules folder is missing.
goto INSTALL_DEPS

:CHECK_DEPS
echo [Info] Checking dependencies (sqlite3)...
node server/check_deps.js
if %ERRORLEVEL% neq 0 (
    echo [Warning] Dependency check failed.
    goto REINSTALL_DEPS
)
goto RUN_SERVER

:INSTALL_DEPS
echo [Info] Installing dependencies...
echo [Info] npm version:
call npm -v
if %ERRORLEVEL% NEQ 0 (
    echo [Error] npm을 실행할 수 없습니다. bin 폴더에 npm.cmd가 있는지 확인하세요.
    pause
    exit /b 1
)
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [Error] npm install 실패. 인터넷 연결을 확인하세요.
    pause
    exit /b 1
)
goto RUN_SERVER

:REINSTALL_DEPS
echo [Warning] Dependencies mismatch detected (OS changed?).
echo [Info] Re-installing dependencies...
if exist "node_modules" rmdir /s /q node_modules
call npm install
goto RUN_SERVER

:RUN_SERVER
:: 4. Run Server
echo [Info] Launching Server...
node server/server.js
if %ERRORLEVEL% NEQ 0 (
    echo [Error] 서버가 예기치 않게 종료되었습니다.
    pause
)
pause
