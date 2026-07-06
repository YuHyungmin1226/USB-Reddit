const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load config (with friendly error handling)
const configPath = path.join(__dirname, '../config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (err) {
    if (err.code === 'ENOENT') {
        console.error(`설정 파일을 찾을 수 없습니다: ${configPath}`);
        console.error('config.json 파일을 생성한 뒤 서버를 다시 시작하세요.');
    } else {
        console.error(`설정 파일(config.json) 파싱 오류: ${err.message}`);
        console.error('config.json 의 JSON 형식을 확인하세요.');
    }
    process.exit(1);
}

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

// Timing-safe comparison of the admin password (length-guarded)
function verifyAdmin(provided) {
    if (typeof provided !== 'string') return false;
    const expected = config.admin.password;
    if (typeof expected !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Dependency-free in-memory rate limiter (per-IP sliding window).
// Returns an express middleware. `max` requests allowed per `windowMs`.
function rateLimit({ windowMs, max, message }) {
    const hits = new Map(); // ip -> [timestamps]
    return (req, res, next) => {
        const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
        const now = Date.now();
        const arr = (hits.get(key) || []).filter(ts => now - ts < windowMs);
        if (arr.length >= max) {
            hits.set(key, arr);
            return res.status(429).json({ error: message || "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });
        }
        arr.push(now);
        hits.set(key, arr);
        // Opportunistic cleanup to avoid unbounded growth
        if (hits.size > 5000) {
            for (const [k, v] of hits) {
                const live = v.filter(ts => now - ts < windowMs);
                if (live.length === 0) hits.delete(k); else hits.set(k, live);
            }
        }
        next();
    };
}

const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: "로그인 시도가 너무 많습니다. 1분 후 다시 시도하세요." });
const sensitiveLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });

const SUBREDDIT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;
const RESERVED_SUBREDDITS = new Set(['general', 'random']);

function normalizeSubredditName(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isValidSubredditName(name) {
    return SUBREDDIT_NAME_RE.test(name);
}

function isReservedSubreddit(name) {
    return RESERVED_SUBREDDITS.has(String(name || '').toLowerCase());
}

function getVoteTargetTable(targetType) {
    if (targetType === 'post') return 'posts';
    if (targetType === 'comment') return 'comments';
    return null;
}

function sanitizePathSegment(value, fallback = 'unknown') {
    const cleaned = String(value || '')
        .trim()
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^\.+/, '');
    return cleaned || fallback;
}

function cleanupUploadedFiles(files) {
    (files || []).forEach((file) => {
        if (!file || !file.path) return;
        fs.unlink(file.path, () => {});
    });
}

function getLocalAddress() {
    const networks = os.networkInterfaces();
    for (const addresses of Object.values(networks)) {
        for (const address of addresses || []) {
            if (address && address.family === 'IPv4' && !address.internal) {
                return address.address;
            }
        }
    }
    return '127.0.0.1';
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// Frontend is served from the same origin via express.static, so wide-open
// CORS is unnecessary. Allow same-origin only (no cross-origin headers).
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

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

        // Votes (preserve data across restarts; unique constraint enforced via index)
        db.run(`CREATE TABLE IF NOT EXISTS votes (
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
            if (err) {
                console.error("Error checking subreddits count:", err.message);
                return;
            }
            if (row && row.count === 0) {
                // Default sub uses the admin password hash; it is also protected from deletion.
                db.run("INSERT INTO subreddits (name, description, password) VALUES (?, ?, ?)", ['general', 'General discussion', hashPassword(config.admin.password)]);
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
    const normalized = {
        ...post,
        attachments: attachmentsForPost(post)
    };
    // Never expose the password hash in API responses
    delete normalized.password;
    return normalized;
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
    const subredditName = normalizeSubredditName(name);

    if (!subredditName || !password) {
        return res.status(400).json({ error: "Name and password are required" });
    }
    if (!isValidSubredditName(subredditName)) {
        return res.status(400).json({ error: "Subreddit names must be 1-32 characters and use only letters, numbers, underscores, or hyphens" });
    }
    if (isReservedSubreddit(subredditName)) {
        return res.status(400).json({ error: "That subreddit name is reserved" });
    }

    const hashedPwd = hashPassword(password);
    db.run("INSERT INTO subreddits (name, description, password) VALUES (?, ?, ?)", [subredditName, description, hashedPwd], function (err) {
        if (err) {
            if (err.code === 'SQLITE_CONSTRAINT') {
                return res.status(409).json({ error: "That subreddit name is already in use" });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, name: subredditName });
    });
});

// 2.1 Delete subreddit
app.delete('/api/subreddits/:id', sensitiveLimiter, (req, res) => {
    const subId = req.params.id;
    const { password, adminPassword } = req.body;

    db.get("SELECT name, password FROM subreddits WHERE id = ?", [subId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Subreddit not found" });
        if (isReservedSubreddit(row.name)) {
            return res.status(403).json({ error: "Reserved subreddits cannot be deleted" });
        }

        // Admin can bypass subreddit password
        if (adminPassword && verifyAdmin(adminPassword)) {
            return deleteSubreddit(res);
        }

        if (!verifyAndUpgrade(password, row.password, (h) => db.run("UPDATE subreddits SET password = ? WHERE id = ?", [h, subId]))) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        deleteSubreddit(res);
    });

    function deleteSubreddit(response) {
        db.serialize(() => {
            db.run("BEGIN");
            const fail = (err) => {
                db.run("ROLLBACK");
                return response.status(500).json({ error: err.message });
            };
            // votes has no FK -> must delete manually. comments/posts cascade via FK,
            // but we delete explicitly to keep behaviour deterministic.
            db.run("DELETE FROM votes WHERE target_type='post' AND target_id IN (SELECT id FROM posts WHERE subreddit_id = ?)", [subId], (e) => {
                if (e) return fail(e);
                db.run("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE subreddit_id = ?)", [subId], (e) => {
                    if (e) return fail(e);
                    db.run("DELETE FROM posts WHERE subreddit_id = ?", [subId], (e) => {
                        if (e) return fail(e);
                        db.run("DELETE FROM subreddits WHERE id = ?", [subId], (e) => {
                            if (e) return fail(e);
                            db.run("COMMIT", (e) => {
                                if (e) return fail(e);
                                response.json({ message: "Subreddit deleted" });
                            });
                        });
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
                SELECT posts.id, posts.subreddit_id, posts.title, posts.content,
                    posts.author, posts.file_url,
                    posts.file_type, posts.attachments, posts.created_at,
                    subreddits.name as subreddit_name,
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

// Map trusted MIME types to safe extensions (do NOT trust originalname)
const MIME_EXT_MAP = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/ogg': '.ogv',
    'video/quicktime': '.mov'
};

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
        // Re-issue a safe extension based on MIME type, never the original name.
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = MIME_EXT_MAP[file.mimetype] || '';
        cb(null, uniqueSuffix + ext);
    }
});

// Only allow image/* and video/* MIME types
function fileFilter(req, file, cb) {
    if (/^image\//.test(file.mimetype) || /^video\//.test(file.mimetype)) {
        return cb(null, true);
    }
    cb(new Error("이미지 또는 비디오 파일만 업로드할 수 있습니다."), false);
}

function safeFileFilter(req, file, cb) {
    const isImage = /^image\//.test(file.mimetype);
    const isVideo = /^video\//.test(file.mimetype);
    const isSvg = file.mimetype === 'image/svg+xml';
    if ((isImage || isVideo) && !isSvg) {
        return cb(null, true);
    }
    cb(new Error("Only non-SVG image and video files can be uploaded."), false);
}

const upload = multer({
    storage: storage,
    fileFilter: safeFileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB per file
        files: 10
    }
});

// Wrap multer middleware so upload errors return a 400 instead of crashing.
function uploadAttachments(req, res, next) {
    upload.array('attachment')(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                return res.status(400).json({ error: `파일 업로드 오류: ${err.message}` });
            }
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}

// ... existing code ...

function safeUploadAttachments(req, res, next) {
    upload.array('attachment')(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                return res.status(400).json({ error: `Upload failed: ${err.message}` });
            }
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}

// 4. Create post (with optional file attachments)
app.post('/api/r/:subreddit_name', sensitiveLimiter, safeUploadAttachments, (req, res) => {
    const subName = req.params.subreddit_name;

    let { title, content, author, password } = req.body;
    const fail = (status, message) => {
        cleanupUploadedFiles(req.files);
        return res.status(status).json(typeof message === 'string' ? { error: message } : message);
    };

    db.get("SELECT id FROM subreddits WHERE name = ?", [subName], (lookupErr, sub) => {
        if (lookupErr) return fail(500, lookupErr.message);
        if (!sub) return fail(404, "Subreddit not found");
        if (!password) return fail(400, "Password is required.");

        // Default title: YYYY-MM-DD HH:MM:SS in Asia/Seoul.
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

        const hashedPwd = hashPassword(password);
        const firstAttachment = attachments[0] || null;
        const fileUrl = firstAttachment ? firstAttachment.url : null;
        const fileType = firstAttachment ? firstAttachment.type : null;
        const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;
        db.run("INSERT INTO posts (subreddit_id, title, content, author, password, file_url, file_type, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [sub.id, title, content, author, hashedPwd, fileUrl, fileType, attachmentsJson], function (insertErr) {
                if (insertErr) return fail(500, insertErr.message);
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
    if (!post_id || !content || (typeof content === 'string' && content.trim() === '')) {
        return res.status(400).json({ error: "post_id와 content는 필수입니다." });
    }
    db.run("INSERT INTO comments (post_id, parent_id, content, author) VALUES (?, ?, ?, ?)",
        [post_id, parent_id, content, author], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

// 6.1 Delete comment (Admin only)
app.delete('/api/comments/:id', sensitiveLimiter, (req, res) => {
    const commentId = req.params.id;
    const { adminPassword } = req.body;

    if (!verifyAdmin(adminPassword)) {
        return res.status(403).json({ error: "Admin access required" });
    }

    db.run("DELETE FROM comments WHERE id = ?", [commentId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Comment deleted successfully" });
    });
});

// 7. Delete post (with password check or admin bypass)
app.delete('/api/posts/:id', sensitiveLimiter, (req, res) => {
    const postId = req.params.id;
    const { password, adminPassword } = req.body;

    db.get("SELECT password FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Post not found" });

        // Admin can bypass post password
        if (adminPassword && verifyAdmin(adminPassword)) {
            return deletePost(postId, res);
        }

        if (!verifyAndUpgrade(password, row.password, (h) => db.run("UPDATE posts SET password = ? WHERE id = ?", [h, postId]))) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        deletePost(postId, res);
    });

    function deletePost(id, response) {
        db.serialize(() => {
            db.run("BEGIN");
            const fail = (err) => {
                db.run("ROLLBACK");
                return response.status(500).json({ error: err.message });
            };
            // comments cascade via FK; votes have no FK so delete manually.
            db.run("DELETE FROM comments WHERE post_id = ?", [id], (e) => {
                if (e) return fail(e);
                db.run("DELETE FROM votes WHERE target_type='post' AND target_id=?", [id], (e) => {
                    if (e) return fail(e);
                    db.run("DELETE FROM posts WHERE id = ?", [id], (e) => {
                        if (e) return fail(e);
                        db.run("COMMIT", (e) => {
                            if (e) return fail(e);
                            response.json({ message: "Deleted successfully" });
                        });
                    });
                });
            });
        });
    }
});

// 7.1 Update post (with password check or admin bypass)
app.put('/api/posts/:id', sensitiveLimiter, (req, res) => {
    const postId = req.params.id;
    const { title, content, password, adminPassword } = req.body;

    // Admin can bypass post password
    const isAdmin = adminPassword && verifyAdmin(adminPassword);

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
            if (this.changes === 0) return res.status(404).json({ error: "Post not found" });
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
    if (!Number.isInteger(target_id)) {
        return res.status(400).json({ error: "target_id must be an integer" });
    }
    const userIp = req.ip || (req.socket && req.socket.remoteAddress);
    const voteTargetTable = getVoteTargetTable(target_type);

    db.get(`SELECT id FROM ${voteTargetTable} WHERE id = ?`, [target_id], (lookupErr, row) => {
        if (lookupErr) return res.status(500).json({ error: lookupErr.message });
        if (!row) return res.status(404).json({ error: `${target_type} not found` });

        db.run(`INSERT INTO votes (target_type, target_id, user_ip, value) VALUES (?, ?, ?, ?)
                ON CONFLICT(target_type, target_id, user_ip) DO UPDATE SET value = excluded.value`,
            [target_type, target_id, userIp, value], function (voteErr) {
                if (voteErr) return res.status(500).json({ error: voteErr.message });

                db.get("SELECT COALESCE(SUM(value), 0) as total FROM votes WHERE target_type=? AND target_id=?",
                    [target_type, target_id], (totalErr, totalRow) => {
                        if (totalErr) return res.json({ success: true });
                        res.json({ success: true, total: totalRow.total });
                    });
            });
    });
});

// 7.3 Admin Login (timing-safe compare + rate limited)
app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (username === config.admin.username && verifyAdmin(password)) {
        res.json({ success: true, message: "Logged in as admin" });
    } else {
        res.status(401).json({ success: false, error: "Invalid credentials" });
    }
});

// 8. Export all posts to Markdown files
app.post('/api/export', (req, res) => {
    // Basic protection (optional but good practice)
    const { adminPassword } = req.body;
    if (!verifyAdmin(adminPassword)) {
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
        let failCount = 0;
        rows.forEach(post => {
            const subName = post.subreddit_name || 'unknown';
            const safeSubDirName = sanitizePathSegment(subName, 'unknown');
            const subDir = path.join(exportDir, safeSubDirName);
            if (!fs.existsSync(subDir)) {
                fs.mkdirSync(subDir, { recursive: true });
            }

            // Guard against null/empty title to avoid crashes
            const rawTitle = post.title || '';
            let safeTitle = rawTitle.replace(/[\/\?<>\\:\*\|"]/g, '_').trim();
            if (!safeTitle) safeTitle = 'unnamed_post';

            let safeDate = post.created_at ? post.created_at.substring(0, 10).replace(/[: ]/g, '-') : 'unknown-date';
            let safeAuthor = post.author ? post.author.replace(/[\/\?<>\\:\*\|"]/g, '_') : 'unknown';

            // Include post.id to prevent overwriting files with identical names
            const fileName = `${safeTitle}_${safeDate}_${safeAuthor}_${post.id}.md`;
            const filePath = path.join(subDir, fileName);

            const normalizedPost = normalizePost(post);
            const cleanContent = stripAttachmentMarkers(post.content || '', normalizedPost.attachments);
            const attachmentBlock = normalizedPost.attachments.map(attachmentMarkdown).join('\n\n');
            const bodyContent = attachmentBlock ? `${cleanContent}\n\n${attachmentBlock}` : cleanContent;

            const mdContent = `---
title: "${rawTitle.replace(/"/g, '\\"')}"
author: "${post.author || ''}"
subreddit: "r/${subName}"
date: "${post.created_at || ''}"
---

# ${rawTitle}

${bodyContent}
`;

            try {
                fs.writeFileSync(filePath, mdContent, 'utf-8');
                successCount++;
            } catch (fileErr) {
                failCount++;
                console.error(`File save failed (${fileName}):`, fileErr.message);
            }
        });

        res.json({
            message: `Successfully exported: ${successCount} posts`,
            count: successCount,
            failed: failCount,
            path: exportDir
        });
    });
});

// Start Server
const server = app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalAddress();
    console.log(`
    ===========================================
      USB Reddit Server Running!
    ===========================================
      - Local:   http://localhost:${PORT}
      - Network: http://${localIp}:${PORT}
    ===========================================
    `);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[오류] 포트 ${PORT} 이(가) 이미 사용 중입니다.`);
        console.error('다른 프로그램이 해당 포트를 점유하고 있습니다.');
        console.error(`다른 포트로 실행하려면 환경변수 PORT 를 지정하세요. 예: PORT=3001 node server/server.js\n`);
        process.exit(1);
    }
    console.error('서버 시작 중 오류가 발생했습니다:', err.message);
    process.exit(1);
});
