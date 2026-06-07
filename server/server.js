const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const ip = require('ip');
const fs = require('fs');

// Load config
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const crypto = require('crypto');

// Password hashing with Node.js built-in scrypt (no external deps)
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyAndUpgrade(password, stored, updateFn) {
    if (!stored || !stored.includes(':')) {
        if (password === stored) {
            if (updateFn) updateFn(hashPassword(password));
            return true;
        }
        return false;
    }
    const [salt, key] = stored.split(':');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    if (hash.length !== key.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(key));
}

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// Database Setup
const dbDir = path.join(__dirname, '../data');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'reddit.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database ' + dbPath + ': ' + err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run("PRAGMA foreign_keys = ON");
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
            file_url TEXT DEFAULT NULL,
            file_type TEXT DEFAULT NULL,
            attachments TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(subreddit_id) REFERENCES subreddits(id) ON DELETE CASCADE
        )`);

        db.run("ALTER TABLE posts ADD COLUMN file_url TEXT DEFAULT NULL", () => {});
        db.run("ALTER TABLE posts ADD COLUMN file_type TEXT DEFAULT NULL", () => {});
        db.run("ALTER TABLE posts ADD COLUMN attachments TEXT DEFAULT NULL", () => {});

        // Comments
        db.run(`CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            parent_id INTEGER DEFAULT NULL,
            content TEXT,
            author TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
        )`);

        // Votes (drop legacy table, recreate with unique constraint)
        db.run(`DROP TABLE IF EXISTS votes`);
        db.run(`CREATE TABLE votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_type TEXT NOT NULL,
            target_id INTEGER NOT NULL,
            user_ip TEXT NOT NULL,
            value INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_unique ON votes(target_type, target_id, user_ip)`);

        // Seed default subreddit if empty
        db.get("SELECT count(*) as count FROM subreddits", (err, row) => {
            if (row.count === 0) {
                // Default sub with 'admin' password
                db.run(`INSERT INTO subreddits (name, description, password) VALUES ('general', 'General discussion', 'admin')`);
                console.log("Seeded default subreddit.");
            }
        });
    });
}

function parseAttachments(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(item => item && item.url);
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter(item => item && item.url) : [];
    } catch (err) {
        return [];
    }
}

function attachmentsForPost(post) {
    const attachments = parseAttachments(post.attachments);
    if (attachments.length > 0) return attachments;
    if (post.file_url) {
        return [{ url: post.file_url, type: post.file_type || '' }];
    }
    return [];
}

function normalizePost(post) {
    if (!post) return post;
    return {
        ...post,
        attachments: attachmentsForPost(post)
    };
}

function attachmentMarkdown(attachment) {
    const label = attachment.type && attachment.type.startsWith('video/') ? 'video' : 'image';
    return `![${label}](${attachment.url})`;
}

function stripAttachmentMarkers(content, attachments) {
    let result = content || '';
    [...attachments].reverse().forEach((attachment) => {
        const escaped = attachment.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\n\\n!\\[(?:video|image)\\]\\(${escaped}\\)\\s*$`);
        result = result.replace(regex, '');
    });
    return result;
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

    const hashedPwd = hashPassword(password);
    db.run("INSERT INTO subreddits (name, description, password) VALUES (?, ?, ?)", [name, description, hashedPwd], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name });
    });
});

// 2.1 Delete subreddit
app.delete('/api/subreddits/:id', (req, res) => {
    const subId = req.params.id;
    const { password, adminPassword } = req.body;

    // Admin can bypass subreddit password
    if (adminPassword && adminPassword === config.admin.password) {
        return deleteSubreddit(res);
    }

    db.get("SELECT password FROM subreddits WHERE id = ?", [subId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Subreddit not found" });

        if (!verifyAndUpgrade(password, row.password, (h) => db.run("UPDATE subreddits SET password = ? WHERE id = ?", [h, subId]))) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        deleteSubreddit(res);
    });

    function deleteSubreddit(response) {
        db.run("DELETE FROM votes WHERE target_type='post' AND target_id IN (SELECT id FROM posts WHERE subreddit_id = ?)", [subId], (e) => {
            if (e) console.error("Error deleting votes:", e);
            db.run("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE subreddit_id = ?)", [subId], (e) => {
                if (e) console.error("Error deleting comments:", e);
                db.run("DELETE FROM posts WHERE subreddit_id = ?", [subId], (e) => {
                    if (e) console.error("Error deleting posts:", e);
                    db.run("DELETE FROM subreddits WHERE id = ?", [subId], (err) => {
                        if (err) return response.status(500).json({ error: err.message });
                        response.json({ message: "Subreddit deleted" });
                    });
                });
            });
        });
    }
});

// 3. Get posts for a subreddit
app.get('/api/r/:subreddit_name', (req, res) => {
    const subName = req.params.subreddit_name;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    db.get("SELECT id FROM subreddits WHERE name = ?", [subName], (err, sub) => {
        if (err || !sub) return res.status(404).json({ error: "Subreddit not found" });

        const countQuery = `SELECT COUNT(*) as total FROM posts WHERE subreddit_id = ?`;
        db.get(countQuery, [sub.id], (err, countRow) => {
            if (err) return res.status(500).json({ error: err.message });

            const query = `
                SELECT posts.*, subreddits.name as subreddit_name,
                    (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) as comment_count,
                    (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type='post' AND target_id=posts.id) as upvotes
                FROM posts 
                LEFT JOIN subreddits ON posts.subreddit_id = subreddits.id 
                WHERE posts.subreddit_id = ? 
                ORDER BY posts.created_at DESC
                LIMIT ? OFFSET ?
            `;
            db.all(query, [sub.id, limit, offset], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({
                    data: rows.map(normalizePost),
                    pagination: {
                        page,
                        limit,
                        total: countRow.total,
                        totalPages: Math.ceil(countRow.total / limit)
                    }
                });
            });
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

// 4. Create post (with optional file attachments)
app.post('/api/r/:subreddit_name', upload.array('attachment'), (req, res) => {
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

    const attachments = (req.files || []).map(file => ({
        url: `/uploads/${file.filename}`,
        type: file.mimetype
    }));
    attachments.forEach((attachment) => {
        content += `\n\n${attachmentMarkdown(attachment)}`;
    });

    db.get("SELECT id FROM subreddits WHERE name = ?", [subName], (err, sub) => {
        if (err || !sub) return res.status(404).json({ error: "Subreddit not found" });

        const hashedPwd = hashPassword(password);
        const firstAttachment = attachments[0] || null;
        const fileUrl = firstAttachment ? firstAttachment.url : null;
        const fileType = firstAttachment ? firstAttachment.type : null;
        const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;
        db.run("INSERT INTO posts (subreddit_id, title, content, author, password, file_url, file_type, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [sub.id, title, content, author, hashedPwd, fileUrl, fileType, attachmentsJson], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID, file_url: fileUrl, file_type: fileType, attachments });
            });
    });
});

// 5. Get single post with comments
app.get('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    db.get(`SELECT posts.*,
        (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type='post' AND target_id=posts.id) as upvotes
        FROM posts WHERE id = ?`, [postId], (err, post) => {
        if (err || !post) return res.status(404).json({ error: "Post not found" });

        db.all("SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC", [postId], (err, comments) => {
            if (err) return res.status(500).json({ error: err.message });

            res.json({ post: normalizePost(post), comments });
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

// 6.1 Delete comment (Admin only)
app.delete('/api/comments/:id', (req, res) => {
    const commentId = req.params.id;
    const { adminPassword } = req.body;

    if (adminPassword !== config.admin.password) {
        return res.status(403).json({ error: "Admin access required" });
    }

    db.run("DELETE FROM comments WHERE id = ?", [commentId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Comment deleted successfully" });
    });
});

// 7. Delete post (with password check or admin bypass)
app.delete('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    const { password, adminPassword } = req.body;

    // Admin can bypass post password
    if (adminPassword && adminPassword === config.admin.password) {
        return deletePost(postId, res);
    }

    db.get("SELECT password FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Post not found" });

        if (!verifyAndUpgrade(password, row.password, (h) => db.run("UPDATE posts SET password = ? WHERE id = ?", [h, postId]))) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        deletePost(postId, res);
    });

    function deletePost(id, response) {
        db.run("DELETE FROM comments WHERE post_id = ?", [id], (err) => {
            if (err) console.error("Error deleting comments:", err);
            db.run("DELETE FROM votes WHERE target_type='post' AND target_id=?", [id], (err) => {
                if (err) console.error("Error deleting votes:", err);
                db.run("DELETE FROM posts WHERE id = ?", [id], (err) => {
                    if (err) return response.status(500).json({ error: err.message });
                    response.json({ message: "Deleted successfully" });
                });
            });
        });
    }
});

// 7.1 Update post (with password check or admin bypass)
app.put('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    const { title, content, password, adminPassword } = req.body;

    // Admin can bypass post password
    const isAdmin = adminPassword && adminPassword === config.admin.password;

    if (!password && !isAdmin) {
        return res.status(400).json({ error: "Password is required" });
    }

    if (isAdmin) {
        return updatePost();
    }

    db.get("SELECT password FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Post not found" });

        if (!verifyAndUpgrade(password, row.password, (h) => db.run("UPDATE posts SET password = ? WHERE id = ?", [h, postId]))) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        updatePost();
    });

    function updatePost() {
        db.run("UPDATE posts SET title = ?, content = ? WHERE id = ?", [title, content, postId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Updated successfully" });
        });
    }
});

// 7.2 Vote (upvote/downvote)
app.post('/api/vote', (req, res) => {
    const { target_type, target_id, value } = req.body;
    if (!target_type || !target_id || ![1, -1, 0].includes(value)) {
        return res.status(400).json({ error: "target_type, target_id, and value (1|-1|0) required" });
    }
    if (!['post', 'comment'].includes(target_type)) {
        return res.status(400).json({ error: "target_type must be 'post' or 'comment'" });
    }
    const userIp = req.ip || req.connection.remoteAddress;

    db.run(`INSERT INTO votes (target_type, target_id, user_ip, value) VALUES (?, ?, ?, ?)
            ON CONFLICT(target_type, target_id, user_ip) DO UPDATE SET value = excluded.value`,
        [target_type, target_id, userIp, value], function (err) {
            if (err) return res.status(500).json({ error: err.message });

            db.get("SELECT COALESCE(SUM(value), 0) as total FROM votes WHERE target_type=? AND target_id=?",
                [target_type, target_id], (err, row) => {
                    if (err) return res.json({ success: true });
                    res.json({ success: true, total: row.total });
                });
        });
});

// 7.3 Admin Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === config.admin.username && password === config.admin.password) {
        res.json({ success: true, message: "Logged in as admin" });
    } else {
        res.status(401).json({ success: false, error: "Invalid credentials" });
    }
});

// 8. Export all posts to Markdown files
app.post('/api/export', (req, res) => {
    // Basic protection (optional but good practice)
    const { adminPassword } = req.body;
    if (adminPassword !== config.admin.password) {
        return res.status(403).json({ error: "Admin access required" });
    }

    const exportDir = path.join(__dirname, '../exports');

    if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
    }

    const query = `
        SELECT 
            posts.id, posts.title, posts.content, posts.author, posts.created_at,
            posts.file_url, posts.file_type, posts.attachments,
            subreddits.name as subreddit_name
        FROM posts 
        LEFT JOIN subreddits ON posts.subreddit_id = subreddits.id
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        if (!rows || rows.length === 0) {
            return res.json({ message: "No posts to export.", count: 0 });
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
            let safeAuthor = post.author ? post.author.replace(/[\/\?<>\\:\*\|"]/g, '_') : 'unknown';
            
            const fileName = `${safeTitle}_${safeDate}_${safeAuthor}.md`;
            const filePath = path.join(subDir, fileName);

            const normalizedPost = normalizePost(post);
            const cleanContent = stripAttachmentMarkers(post.content || '', normalizedPost.attachments);
            const attachmentBlock = normalizedPost.attachments.map(attachmentMarkdown).join('\n\n');
            const bodyContent = attachmentBlock ? `${cleanContent}\n\n${attachmentBlock}` : cleanContent;

            const mdContent = `---
title: "${post.title.replace(/"/g, '\\"')}"
author: "${post.author}"
subreddit: "r/${subName}"
date: "${post.created_at}"
---

# ${post.title}

${bodyContent}
`;

            try {
                fs.writeFileSync(filePath, mdContent, 'utf-8');
                successCount++;
            } catch (fileErr) {
                console.error(`File save failed (${fileName}):`, fileErr.message);
            }
        });

        res.json({ 
            message: `Successfully exported: ${successCount} posts`, 
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
