const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const ip = require('ip');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// Database Setup
const dbPath = path.join(__dirname, '../data/reddit.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database ' + dbPath + ': ' + err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Subreddits
        db.run(`CREATE TABLE IF NOT EXISTS subreddits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            description TEXT,
            password TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Posts
        db.run(`CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subreddit_id INTEGER,
            title TEXT,
            content TEXT,
            author TEXT,
            password TEXT,
            upvotes INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(subreddit_id) REFERENCES subreddits(id)
        )`);

        // Comments
        db.run(`CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            parent_id INTEGER DEFAULT NULL,
            content TEXT,
            author TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(post_id) REFERENCES posts(id)
        )`);

        // Votes
        db.run(`CREATE TABLE IF NOT EXISTS votes (
            id INTEGER PRIMARY KEY,
            target_type TEXT, 
            target_id INTEGER,
            user_ip TEXT,
            value INTEGER
        )`);

        // Seed default subreddit if empty
        db.get("SELECT count(*) as count FROM subreddits", (err, row) => {
            if (row.count === 0) {
                // Default subs with 'admin' password for now, or empty.
                db.run(`INSERT INTO subreddits (name, description, password) VALUES ('general', 'General discussion', 'admin'), ('random', 'Random stuff', 'admin')`);
                console.log("Seeded default subreddits.");
            }
        });
    });
}

// API Routes

// 1. Get all subreddits
app.get('/api/subreddits', (req, res) => {
    db.all("SELECT id, name, description FROM subreddits", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ data: rows });
    });
});

// 2. Create subreddit
app.post('/api/subreddits', (req, res) => {
    const { name, description, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: "Name and Password are required" });

    db.run("INSERT INTO subreddits (name, description, password) VALUES (?, ?, ?)", [name, description, password], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name });
    });
});

// 2.1 Delete subreddit
app.delete('/api/subreddits/:id', (req, res) => {
    const subId = req.params.id;
    const { password } = req.body;

    db.get("SELECT password FROM subreddits WHERE id = ?", [subId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Subreddit not found" });

        if (row.password !== password) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        // Cleanup: Delete posts (and their comments)
        // 1. Find all posts
        db.all("SELECT id FROM posts WHERE subreddit_id = ?", [subId], (err, posts) => {
            if (err) console.error("Error finding posts to delete:", err);

            // Delete comments for these posts
            if (posts && posts.length > 0) {
                const postIds = posts.map(p => p.id).join(',');
                db.run(`DELETE FROM comments WHERE post_id IN (${postIds})`);
            }

            // Delete posts
            db.run("DELETE FROM posts WHERE subreddit_id = ?", [subId], (e) => {
                if (e) console.error(e);

                // Finally delete subreddit
                db.run("DELETE FROM subreddits WHERE id = ?", [subId], (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ message: "Subreddit deleted" });
                });
            });
        });
    });
});

// 3. Get posts for a subreddit
app.get('/api/r/:subreddit_name', (req, res) => {
    const subName = req.params.subreddit_name;
    db.get("SELECT id FROM subreddits WHERE name = ?", [subName], (err, sub) => {
        if (err || !sub) return res.status(404).json({ error: "Subreddit not found" });

        db.all("SELECT * FROM posts WHERE subreddit_id = ? ORDER BY created_at DESC", [sub.id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ data: rows });
        });
    });
});

const multer = require('multer');

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../public/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Keep original extension, prepend generic id or timestamp to avoid collisions
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ... existing code ...

// 4. Create post (with optional file attachment)
app.post('/api/r/:subreddit_name', upload.single('attachment'), (req, res) => {
    const subName = req.params.subreddit_name;
    let { title, content, author, password } = req.body;

    if (!password) {
        return res.status(400).json({ error: "Password is required." });
    }

    // Default Title: YYYY-MM-DD HH:MM:SS
    if (!title || title.trim() === '') {
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        title = now.getFullYear() + "-" +
            String(now.getMonth() + 1).padStart(2, '0') + "-" +
            String(now.getDate()).padStart(2, '0') + " " +
            String(now.getHours()).padStart(2, '0') + ":" +
            String(now.getMinutes()).padStart(2, '0') + ":" +
            String(now.getSeconds()).padStart(2, '0');
    }

    // Ensure content is string (it might be undefined if empty form data)
    content = content || '';

    // Handle file attachment
    if (req.file) {
        const fileUrl = `/uploads/${req.file.filename}`;
        const isVideo = req.file.mimetype.startsWith('video/');

        if (isVideo) {
            content += `\n\n![video](${fileUrl})`;
        } else {
            content += `\n\n![image](${fileUrl})`;
        }
    }

    db.get("SELECT id FROM subreddits WHERE name = ?", [subName], (err, sub) => {
        if (err || !sub) return res.status(404).json({ error: "Subreddit not found" });

        db.run("INSERT INTO posts (subreddit_id, title, content, author, password) VALUES (?, ?, ?, ?, ?)",
            [sub.id, title, content, author, password], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID });
            });
    });
});

// 5. Get single post with comments
app.get('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    db.get("SELECT * FROM posts WHERE id = ?", [postId], (err, post) => {
        if (err || !post) return res.status(404).json({ error: "Post not found" });

        db.all("SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC", [postId], (err, comments) => {
            if (err) return res.status(500).json({ error: err.message });

            // Build comment tree (simple list for now, UI can handle tree)
            res.json({ post, comments });
        });
    });
});

// 6. Create comment
app.post('/api/comments', (req, res) => {
    const { post_id, parent_id, content, author } = req.body;
    db.run("INSERT INTO comments (post_id, parent_id, content, author) VALUES (?, ?, ?, ?)",
        [post_id, parent_id, content, author], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

// 7. Delete post (with password check)
app.delete('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    const { password } = req.body;

    db.get("SELECT password FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Post not found" });

        // Simple string comparison for portable/demo version.
        // In production, use bcrypt.compare()
        if (row.password !== password) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        // Delete comments first (cleanup)
        db.run("DELETE FROM comments WHERE post_id = ?", [postId], (err) => {
            if (err) console.error("Error deleting comments:", err);

            // Delete post
            db.run("DELETE FROM posts WHERE id = ?", [postId], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: "Deleted successfully" });
            });
        });
    });
});

// 7.1 Update post (with password check)
app.put('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    const { title, content, password } = req.body;

    if (!password) {
        return res.status(400).json({ error: "Password is required" });
    }

    db.get("SELECT password FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Post not found" });

        if (row.password !== password) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        db.run("UPDATE posts SET title = ?, content = ? WHERE id = ?", [title, content, postId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Updated successfully" });
        });
    });
});

// 7.2 Admin Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin123') {
        res.json({ success: true, message: "Logged in as admin" });
    } else {
        res.status(401).json({ success: false, error: "Invalid credentials" });
    }
});

// 8. Export all posts to Markdown files
app.post('/api/export', (req, res) => {
    // Basic protection (optional but good practice)
    const { adminPassword } = req.body;
    if (adminPassword !== 'admin123') {
        return res.status(403).json({ error: "Admin access required" });
    }

    const exportDir = path.join(__dirname, '../exports');

    if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
    }

    const query = `
        SELECT 
            posts.id, posts.title, posts.content, posts.author, posts.created_at,
            subreddits.name as subreddit_name
        FROM posts 
        LEFT JOIN subreddits ON posts.subreddit_id = subreddits.id
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        if (!rows || rows.length === 0) {
            return res.json({ message: "내보낼 게시글이 없습니다.", count: 0 });
        }

        let successCount = 0;
        rows.forEach(post => {
            const subName = post.subreddit_name || 'unknown';
            const subDir = path.join(exportDir, subName);
            if (!fs.existsSync(subDir)) {
                fs.mkdirSync(subDir, { recursive: true });
            }

            let safeTitle = post.title.replace(/[\/\?<>\\:\*\|"]/g, '_').trim();
            if (!safeTitle) safeTitle = `unnamed_post_${post.id}`;
            
            let safeDate = post.created_at ? post.created_at.substring(0, 10).replace(/[: ]/g, '-') : 'unknown-date';
            let safeAuthor = post.author ? post.author.replace(/[\/\?<>\\:\*\|"]/g, '_') : '알수없음';
            
            const fileName = `${safeTitle}_${safeDate}_${safeAuthor}.md`;
            const filePath = path.join(subDir, fileName);

            const mdContent = `---
title: "${post.title.replace(/"/g, '\\"')}"
author: "${post.author}"
subreddit: "r/${subName}"
date: "${post.created_at}"
---

# ${post.title}

${post.content || ''}
`;

            try {
                fs.writeFileSync(filePath, mdContent, 'utf-8');
                successCount++;
            } catch (fileErr) {
                console.error(`파일 저장 실패 (${fileName}):`, fileErr.message);
            }
        });

        res.json({ 
            message: `성공적으로 추출된 게시글 수: ${successCount} 개`, 
            count: successCount,
            path: exportDir
        });
    });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    const localIp = ip.address();
    console.log(`
    ===========================================
      USB Reddit Server Running!
    ===========================================
      - Local:   http://localhost:${PORT}
      - Network: http://${localIp}:${PORT}
    ===========================================
    `);
});
