/**
 * win_fix.js
 * Helper script to force restore environment and check dependencies on Windows.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const nodeModules = path.join(rootDir, 'node_modules');
const nodeModulesWin = path.join(rootDir, 'node_modules_win');
const nodeModulesMac = path.join(rootDir, 'node_modules_mac');

console.log("===========================================");
console.log("[Info] Starting Windows Environment Recovery Tool.");
console.log("===========================================");

function echo(msg) { console.log(msg); }

try {
    // 1. Check current node_modules state
    if (fs.existsSync(path.join(nodeModules, '.os_mac'))) {
        echo("[Step 1] Mac node_modules detected. Starting swap...");
        
        if (fs.existsSync(nodeModulesMac)) {
            echo("[Info] Removing existing node_modules_mac folder...");
            fs.rmSync(nodeModulesMac, { recursive: true, force: true });
        }
        
        fs.renameSync(nodeModules, nodeModulesMac);
        echo("[Success] Moved node_modules -> node_modules_mac.");
        
        if (fs.existsSync(nodeModulesWin)) {
            fs.renameSync(nodeModulesWin, nodeModules);
            echo("[Success] Moved node_modules_win -> node_modules.");
        } else {
            echo("[Warning] node_modules_win not found. Re-install might be needed.");
        }
    } else {
        echo("[Info] Already in Windows environment or no Mac marker found.");
    }

    // 2. Check sqlite3
    echo("[Step 2] Testing dependencies...");
    try {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(':memory:');
        db.close();
        echo("[Success] sqlite3 module loaded successfully.");
        
        // Create marker
        fs.writeFileSync(path.join(nodeModules, '.os_win'), 'win', 'utf8');
    } catch (err) {
        echo("[Error] Dependency test failed: " + err.message);
        echo("[Action] 'npm install' might be required.");
    }

    echo("\n[Finish] Recovery process complete.");
    echo("Please run start.bat again.");

} catch (e) {
    echo("[Critical Error] Error during recovery: " + e.message);
}
