@echo off
setlocal
title USB-Reddit Server
cls

echo ===========================================
echo   Starting USB-Reddit...
echo ===========================================

:: 1. Detect Node.js
set "NODE_PATH="

:: Check if node is already in system PATH
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "NODE_PATH=System"
) else (
    :: Check if node exists in local bin folder
    if exist "%~dp0bin\node.exe" (
        echo [Info] Local Node.js detected in bin folder.
        set "PATH=%~dp0bin;%PATH%"
        set "NODE_PATH=Local"
    )
)

:: If Node.js is still not found, show error and instructions
if "%NODE_PATH%"=="" (
    echo [Error] Node.js를 찾을 수 없습니다!
    echo.
    echo 이 프로젝트는 휴대용(Portable) 모드를 지원합니다:
    echo 1. https://nodejs.org/ko/download/prebuilt-binaries 에서 "Windows Binary (.zip)"를 다운로드하세요.
    echo 2. 압축을 푼 뒤 모든 파일을 프로젝트의 "bin" 폴더에 넣으세요.
    echo 3. 그 후 이 파일을 다시 실행해 주세요.
    echo.
    pause
    exit /b 1
)

:: 2. Check if node_modules exists
if not exist "node_modules" goto INSTALL_DEPS

:: 3. Check if dependencies are valid for this OS
echo [Info] Checking dependencies...
call node server/check_deps.js
if %ERRORLEVEL% neq 0 goto REINSTALL_DEPS

goto RUN_SERVER

:INSTALL_DEPS
echo [Info] node_modules not found. Installing...
call npm install
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
pause
