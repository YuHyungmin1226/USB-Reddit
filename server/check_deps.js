try {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(':memory:');
    db.close();
    console.log("Dependencies check passed.");
    process.exit(0);
} catch (e) {
    console.error("Dependencies check failed:", e.message);
    process.exit(1);
}
