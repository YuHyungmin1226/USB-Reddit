try {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(':memory:');
    db.close();
    console.log("[Success] Dependencies check passed.");
    process.exit(0);
} catch (e) {
    console.error("\n[Error] Dependencies check failed!");
    console.error("Message:", e.message);
    
    if (e.message.includes('not a valid Win32 application') || e.message.includes('ELF') || e.message.includes('mach-o')) {
        console.error("\n[Reason] Binary mismatch detected. The 'sqlite3' module was built for a different OS or architecture.");
    } else if (e.code === 'MODULE_NOT_FOUND') {
        console.error("\n[Reason] Some modules are missing.");
    }
    
    console.error("\n[Action] Re-installing dependencies is required.");
    process.exit(1);
}
