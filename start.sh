#!/bin/bash

echo "==========================================="
echo "   Starting USB-Reddit..."
echo "==========================================="

# 1. Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[Info] node_modules not found. Installing..."
    npm install
else
    # 2. Check if dependencies are valid for this OS
    echo "[Info] Checking dependencies..."
    node server/check_deps.js
    if [ $? -ne 0 ]; then
        echo "[Warning] Dependencies mismatch detected (OS changed?)."
        echo "[Info] Re-installing dependencies..."
        rm -rf node_modules
        npm install
    fi
fi

# 3. Run Server
echo "[Info] Launching Server..."
node server/server.js
