@echo off
title USB-Reddit Server
cls

echo ===========================================
echo   Starting USB-Reddit...
echo ===========================================

:: 1. Check if node_modules exists
IF NOT EXIST "node_modules" GOTO INSTALL_DEPS

:: 2. Check if dependencies are valid for this OS
echo [Info] Checking dependencies...
call node server/check_deps.js
IF %ERRORLEVEL% NEQ 0 GOTO REINSTALL_DEPS

GOTO RUN_SERVER

:INSTALL_DEPS
echo [Info] node_modules not found. Installing...
call npm install
GOTO RUN_SERVER

:REINSTALL_DEPS
echo [Warning] Dependencies mismatch detected (OS changed?).
echo [Info] Re-installing dependencies...
rmdir /s /q node_modules
call npm install
GOTO RUN_SERVER

:RUN_SERVER
:: 3. Run Server
echo [Info] Launching Server...
node server/server.js
pause
