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

# 1. Detect Architecture and Handle Portable Node.js
ARCH=$(uname -m)
NODE_LOCAL=""

# Define paths
ARM_TAR="./bin/node-arm64.tar.gz"
X64_TAR="./bin/node-x64.tar.gz"
ARM_BIN="./bin/node-darwin-arm64"
X64_BIN="./bin/node-darwin-x64"

if [ "$ARCH" = "arm64" ]; then
    if [ ! -f "$ARM_BIN" ] && [ -f "$ARM_TAR" ]; then
        echo -e "${YELLOW}[Info] Extracting portable Node.js for Apple Silicon...${NC}"
        tar -xzf "$ARM_TAR" -C bin/ --strip-components 2 "*/bin/node"
        mv "bin/node" "$ARM_BIN"
    fi
    [ -f "$ARM_BIN" ] && NODE_LOCAL="$ARM_BIN"
    TARGET_MODULES="node_modules_mac_arm64"
    MARKER=".os_mac_arm64"
elif [ "$ARCH" = "x86_64" ]; then
    if [ ! -f "$X64_BIN" ] && [ -f "$X64_TAR" ]; then
        echo -e "${YELLOW}[Info] Extracting portable Node.js for Intel...${NC}"
        tar -xzf "$X64_TAR" -C bin/ --strip-components 2 "*/bin/node"
        mv "bin/node" "$X64_BIN"
    fi
    [ -f "$X64_BIN" ] && NODE_LOCAL="$X64_BIN"
    TARGET_MODULES="node_modules_mac_x64"
    MARKER=".os_mac_x64"
fi

if [ -n "$NODE_LOCAL" ]; then
    echo -e "${GREEN}[Info] Portable Node.js active ($ARCH).${NC}"
    mkdir -p .tmp_bin
    ln -sf "$(pwd)/$NODE_LOCAL" .tmp_bin/node
    export PATH="$(pwd)/.tmp_bin:$PATH"
fi

if ! command -v node &> /dev/null
then
    echo -e "${RED}[Error] Node.js is not installed and no portable binary found!${NC}"
    echo "Please download the portable binary to the 'bin' folder."
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi

echo -e "${GREEN}[Info] Node.js version: $(node -v)${NC}"

# 2. Perfect Portable Module Swapping (Zero Install)
echo -e "${YELLOW}[Info] Verifying portable dependencies...${NC}"

# Hide current node_modules if it's not the target one
if [ -d "node_modules" ]; then
    if [ ! -f "node_modules/$MARKER" ]; then
        if [ -f "node_modules/.os_win" ]; then
            mv node_modules node_modules_win
        elif [ -f "node_modules/.os_mac_x64" ]; then
            mv node_modules node_modules_mac_x64
        elif [ -f "node_modules/.os_mac_arm64" ]; then
            mv node_modules node_modules_mac_arm64
        else
            # Unknown state, just assume it's windows to be safe
            mv node_modules node_modules_win
        fi
    fi
fi

# Swap the target node_modules in
if [ -d "$TARGET_MODULES" ]; then
    if [ -d "node_modules" ]; then
        rm -rf node_modules
    fi
    mv "$TARGET_MODULES" node_modules
fi

if [ ! -d "node_modules" ]; then
    echo -e "${RED}[Error] Portable node_modules not found for $ARCH!${NC}"
    echo "Please ensure the USB has the pre-bundled node_modules folders."
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi

# Ensure marker exists
touch "node_modules/$MARKER"

# 3. Ensure necessary directories exist
mkdir -p data exports public/uploads

# 4. Run Server
echo -e "${BLUE}[Info] Launching Server...${NC}"
node server/server.js

# Keep window open if server crashes
if [ $? -ne 0 ]; then
    echo -e "${RED}[Error] Server crashed or stopped unexpectedly.${NC}"
    echo "Press any key to exit..."
    read -n 1
fi
