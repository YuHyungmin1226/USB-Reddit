#!/bin/bash

# Ensure we are in the script's directory
cd "$(dirname "$0")"

# Colors for better visibility
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}===========================================${NC}"
echo -e "${BLUE}   Starting USB-Reddit (macOS)...         ${NC}"
echo -e "${BLUE}===========================================${NC}"

# 1. Check for Node.js
if ! command -v node &> /dev/null
then
    echo -e "${RED}[Error] Node.js is not installed!${NC}"
    echo "Please install Node.js from https://nodejs.org/"
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi

echo -e "${GREEN}[Info] Node.js version: $(node -v)${NC}"

# 2. Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}[Info] node_modules not found. Installing dependencies (using local cache)...${NC}"
    npm install --cache .npm-cache --no-audit --no-fund
    if [ $? -ne 0 ]; then
        echo -e "${RED}[Error] npm install failed.${NC}"
        echo -e "${YELLOW}[Tip] If you see 'EACCES' or 'permission denied', try running this command in a new terminal:${NC}"
        echo -e "      sudo chown -R \$(whoami) ~/.npm"
        echo ""
        echo "Alternatively, you can try running: npm install --cache .npm-cache"
        echo "Press any key to exit..."
        read -n 1
        exit 1
    fi
else
    # 3. Check if dependencies are valid (sqlite3 check)
    echo -e "${GREEN}[Info] Checking dependencies...${NC}"
    node server/check_deps.js
    if [ $? -ne 0 ]; then
        echo -e "${YELLOW}[Warning] Dependencies mismatch detected (Architecture changed?).${NC}"
        echo -e "${YELLOW}[Info] Re-installing dependencies (using local cache)...${NC}"
        rm -rf node_modules
        npm install --cache .npm-cache --no-audit --no-fund
        if [ $? -ne 0 ]; then
             echo -e "${RED}[Error] npm install failed during re-installation.${NC}"
             exit 1
        fi
    fi
fi

# 4. Ensure necessary directories exist
mkdir -p data exports public/uploads

# 5. Run Server
echo -e "${BLUE}[Info] Launching Server...${NC}"
node server/server.js

# Keep window open if server crashes
if [ $? -ne 0 ]; then
    echo -e "${RED}[Error] Server crashed or stopped unexpectedly.${NC}"
    echo "Press any key to exit..."
    read -n 1
fi
