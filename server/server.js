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

if (!config.admin || typeof config.admin.username !== 'string' || typeof config.admin.password !== 'string') {
    console.error('config.json must define admin.username and admin.password as strings.');
    process.exit(1);
}

const accessCredentials = getAccessCredentials();
if (accessCredentials.enabled && isWeakAdminPassword(accessCredentials.password)) {
    if (config.server && config.server.exposeLan === true) {
        console.error('Refusing to expose the server on the LAN with a weak app login password.');
        console.error('Set a stronger access.password in config.json or disable server.exposeLan.');
        process.exit(1);
    } else {
        console.warn('Warning: weak app login password detected. The server will only bind to localhost until you set a stronger password.');
    }
}

if (isWeakAdminPassword(config.admin.password)) {
    if (config.server && config.server.exposeLan === true) {
        console.error('Refusing to expose the server on the LAN with a weak admin password.');
        console.error('Set a stronger admin password in config.json or disable server.exposeLan.');
        process.exit(1);
    } else {
        console.warn('Warning: weak admin password detected. The server will only bind to localhost until you set a stronger password.');
    }
}

// Password hashing with Node.js built-in scrypt (no external deps)
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyAndUpgrade(password, stored, updateFn) {
    if (typeof password !== 'string' || password.length === 0 || typeof stored !== 'string' || stored.length === 0) {
        return false;
    }
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
    return verifySecret(provided, config.admin.password);
}

function verifySecret(provided, expected) {
    if (typeof provided !== 'string') return false;
    if (typeof expected !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function getAccessCredentials() {
    const access = config.access && typeof config.access === 'object' ? config.access : {};
    const username = typeof access.username === 'string' && access.username.trim()
        ? access.username
        : config.admin.username;
    const password = typeof access.password === 'string' && access.password.length > 0
        ? access.password
        : config.admin.password;

    return {
        enabled: access.enabled !== false,
        username,
        password
    };
}

function syncAccessCredentialsFromConfig() {
    const latest = getAccessCredentials();
    accessCredentials.enabled = latest.enabled;
    accessCredentials.username = latest.username;
    accessCredentials.password = latest.password;
}

function hasExplicitAccessPassword() {
    return Boolean(config.access && typeof config.access.password === 'string' && config.access.password.length > 0);
}

function writeConfigFile() {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function verifyUsername(provided, expected) {
    return verifySecret(String(provided || ''), expected);
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
const DATA_DIR = path.join(__dirname, '../data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const LEGACY_PUBLIC_UPLOADS_DIR = path.join(__dirname, '../public/uploads');
const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_POST = 4;
const MAX_UPLOADS_DIRECTORY_SIZE_BYTES = 1024 * 1024 * 1024;
const SESSION_COOKIE_NAME = 'usb_reddit_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

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
    const failures = [];
    (files || []).forEach((file) => {
        if (!file || !file.path) return;
        try {
            fs.unlinkSync(file.path);
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                failures.push({ path: file.path, error: err });
            }
        }
    });
    return failures;
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};

    return header.split(';').reduce((cookies, part) => {
        const index = part.indexOf('=');
        if (index === -1) return cookies;

        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!name) return cookies;

        try {
            cookies[name] = decodeURIComponent(value);
        } catch (err) {
            cookies[name] = value;
        }
        return cookies;
    }, {});
}

function createSession(role) {
    cleanupExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
        role,
        expiresAt: Date.now() + SESSION_DURATION_MS
    });
    return token;
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (!session || session.expiresAt <= now) {
            sessions.delete(token);
        }
    }
}

function setSessionCookie(res, token) {
    const maxAge = Math.floor(SESSION_DURATION_MS / 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function attachSession(req, res, next) {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE_NAME];
    const session = token ? sessions.get(token) : null;

    if (session && session.expiresAt > Date.now()) {
        req.sessionToken = token;
        req.session = session;
    } else if (token) {
        sessions.delete(token);
    }

    next();
}

function requireAuth(req, res, next) {
    if (!accessCredentials.enabled || req.session) {
        return next();
    }

    return res.status(401).json({ error: "Login required" });
}

function requireUploadAuth(req, res, next) {
    if (!accessCredentials.enabled || req.session) {
        return next();
    }

    return res.status(401).send("Login required");
}

function isUploadRequestPath(req) {
    const rawPath = String((req.path || req.url || '').split('?')[0]);
    const paths = [rawPath];
    try {
        paths.push(decodeURIComponent(rawPath));
    } catch (err) {}

    return paths.some((candidate) => {
        const normalized = candidate.replace(/\\/g, '/');
        return normalized === '/uploads' || normalized.startsWith('/uploads/');
    });
}

function blockUploadFallback(req, res, next) {
    if (!isUploadRequestPath(req)) return next();

    if (accessCredentials.enabled && !req.session) {
        return res.status(401).send("Login required");
    }

    return res.status(404).send('Not found');
}

function isAdminRequest(req) {
    return Boolean(req.session && req.session.role === 'admin') || verifyAdmin(req.body && req.body.adminPassword);
}

function isLanExposureEnabled() {
    return Boolean(config && config.server && config.server.exposeLan === true);
}

function getListenHost() {
    return isLanExposureEnabled() ? '0.0.0.0' : '127.0.0.1';
}

function isWeakAdminPassword(value) {
    return typeof value !== 'string' || value.trim().length < 8 || ['CHANGE_ME', 'admin', 'admin123', 'password', '123456'].includes(value);
}

function getDirectorySize(rootPath) {
    if (!fs.existsSync(rootPath)) return 0;

    let total = 0;
    const pending = [rootPath];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (err) {
            continue;
        }

        entries.forEach((entry) => {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
                return;
            }
            if (!entry.isFile()) return;
            try {
                total += fs.statSync(entryPath).size;
            } catch (err) {}
        });
    }
    return total;
}

function uploadPathFromUrl(urlValue) {
    if (typeof urlValue !== 'string' || !urlValue.trim()) return null;
    try {
        const parsed = new URL(urlValue, 'http://localhost');
        const pathname = decodeURIComponent(parsed.pathname);
        if (!pathname.startsWith('/uploads/')) return null;

        const uploadsRoot = path.resolve(UPLOADS_DIR);
        const relativeName = pathname.slice('/uploads/'.length);
        if (!relativeName || relativeName.includes('\0')) return null;

        const resolved = path.resolve(UPLOADS_DIR, relativeName);
        if (resolved !== uploadsRoot && !resolved.startsWith(`${uploadsRoot}${path.sep}`)) {
            return null;
        }
        return resolved;
    } catch (err) {
        return null;
    }
}

function collectUploadPaths(posts) {
    const paths = new Set();
    (posts || []).forEach((post) => {
        attachmentsForPost(post).forEach((attachment) => {
            const localPath = uploadPathFromUrl(attachment.url);
            if (localPath) paths.add(localPath);
        });
    });
    return [...paths];
}

function deleteUploadPaths(paths) {
    const failures = [];
    (paths || []).forEach((targetPath) => {
        if (!targetPath) return;
        try {
            fs.unlinkSync(targetPath);
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                failures.push({ path: targetPath, error: err });
            }
        }
    });
    return failures;
}

function moveFileAcrossDevices(sourcePath, targetPath) {
    try {
        fs.renameSync(sourcePath, targetPath);
    } catch (err) {
        if (!err || err.code !== 'EXDEV') throw err;
        fs.copyFileSync(sourcePath, targetPath);
        fs.unlinkSync(sourcePath);
    }
}

function migrateLegacyUploads() {
    if (!fs.existsSync(LEGACY_PUBLIC_UPLOADS_DIR)) return;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    let entries = [];
    try {
        entries = fs.readdirSync(LEGACY_PUBLIC_UPLOADS_DIR, { withFileTypes: true });
    } catch (err) {
        console.warn(`Could not read legacy upload directory: ${err.message}`);
        return;
    }

    entries.forEach((entry) => {
        if (!entry.isFile() || entry.name === '.gitkeep') return;

        const sourcePath = path.join(LEGACY_PUBLIC_UPLOADS_DIR, entry.name);
        const targetPath = path.join(UPLOADS_DIR, entry.name);
        if (fs.existsSync(targetPath)) {
            console.warn(`Skipping legacy upload migration for ${entry.name}: data/uploads already has that file name.`);
            return;
        }

        try {
            moveFileAcrossDevices(sourcePath, targetPath);
        } catch (err) {
            console.warn(`Could not migrate upload ${entry.name}: ${err.message}`);
        }
    });
}

function fileHasExpectedSignature(filePath, mimeType) {
    const bytes = Buffer.alloc(32);
    let fd;
    let bytesRead = 0;
    try {
        fd = fs.openSync(filePath, 'r');
        bytesRead = fs.readSync(fd, bytes, 0, bytes.length, 0);
    } catch (err) {
        return false;
    } finally {
        if (typeof fd === 'number') {
            try { fs.closeSync(fd); } catch (closeErr) {}
        }
    }

    const header = bytes.subarray(0, bytesRead);
    const ascii = header.toString('ascii');
    const hex = header.toString('hex');

    switch (mimeType) {
        case 'image/png':
            return hex.startsWith('89504e470d0a1a0a');
        case 'image/jpeg':
        case 'image/jpg':
            return hex.startsWith('ffd8ff');
        case 'image/gif':
            return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
        case 'image/webp':
            return ascii.startsWith('RIFF') && header.subarray(8, 12).toString('ascii') === 'WEBP';
        case 'image/bmp':
            return ascii.startsWith('BM');
        case 'video/mp4':
        case 'video/quicktime':
            return header.subarray(4, 8).toString('ascii') === 'ftyp';
        case 'video/webm':
            return hex.startsWith('1a45dfa3');
        case 'video/ogg':
            return ascii.startsWith('OggS');
        default:
            return false;
    }
}

function limitFileComponent(value, fallback, maxLength = 80) {
    const cleaned = sanitizePathSegment(value, fallback);
    return cleaned.slice(0, maxLength) || fallback;
}

function yamlQuoted(value) {
    return JSON.stringify(String(value ?? ''));
}

function sanitizeHeading(value, fallback = 'Untitled') {
    const singleLine = String(value ?? '').replace(/\r?\n+/g, ' ').trim();
    return singleLine || fallback;
}

function normalizeCreatePostPayload(body) {
    const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const pickString = (value, fieldName, fallback = '') => {
        if (value === undefined || value === null) return { value: fallback };
        if (typeof value !== 'string') {
            return { error: `${fieldName} must be a string.` };
        }
        return { value };
    };

    const titleResult = pickString(source.title, 'title', '');
    if (titleResult.error) return titleResult;

    const contentResult = pickString(source.content, 'content', '');
    if (contentResult.error) return contentResult;

    const authorResult = pickString(source.author, 'author', 'Anonymous');
    if (authorResult.error) return authorResult;

    const passwordResult = pickString(source.password, 'password', '');
    if (passwordResult.error) return passwordResult;

    if (passwordResult.value.trim() === '') {
        return { error: 'Password is required.' };
    }

    return {
        value: {
            title: titleResult.value,
            content: contentResult.value,
            author: authorResult.value.trim() || 'Anonymous',
            password: passwordResult.value
        }
    };
}

function cleanupOrphanVotes() {
    db.run("DELETE FROM votes WHERE target_type = 'post' AND target_id NOT IN (SELECT id FROM posts)");
    db.run("DELETE FROM votes WHERE target_type = 'comment' AND target_id NOT IN (SELECT id FROM comments)");
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
migrateLegacyUploads();

// Middleware
// Frontend is served from the same origin via express.static, so wide-open
// CORS is unnecessary. Allow same-origin only (no cross-origin headers).
app.use(bodyParser.json());
app.use(attachSession);

app.get('/api/session', (req, res) => {
    if (!accessCredentials.enabled) {
        return res.json({ authenticated: true, accessEnabled: false, role: 'user' });
    }

    if (!req.session) {
        return res.status(401).json({ authenticated: false, accessEnabled: true, error: "Login required" });
    }

    return res.json({ authenticated: true, accessEnabled: true, role: req.session.role });
});

app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    const isAdmin = verifyUsername(username, config.admin.username) && verifyAdmin(password);
    const isAccessUser = accessCredentials.enabled &&
        verifyUsername(username, accessCredentials.username) &&
        verifySecret(password, accessCredentials.password);

    if (!accessCredentials.enabled || isAdmin || isAccessUser) {
        const role = isAdmin ? 'admin' : 'user';
        const token = createSession(role);
        setSessionCookie(res, token);
        return res.json({ success: true, authenticated: true, role });
    }

    return res.status(401).json({ success: false, error: "Invalid credentials" });
});

app.post('/api/logout', (req, res) => {
    if (req.sessionToken) {
        sessions.delete(req.sessionToken);
    }
    clearSessionCookie(res);
    res.json({ success: true });
});

app.use('/api', requireAuth);
app.use('/uploads', requireUploadAuth, express.static(UPLOADS_DIR, {
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}), (req, res) => {
    res.status(404).send('Not found');
});
app.use(blockUploadFallback);
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// Database Setup
const dbDir = DATA_DIR;
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
        cleanupOrphanVotes();

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
    const { password } = req.body;

    db.get("SELECT name, password FROM subreddits WHERE id = ?", [subId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Subreddit not found" });
        if (isReservedSubreddit(row.name)) {
            return res.status(403).json({ error: "Reserved subreddits cannot be deleted" });
        }

        db.all("SELECT file_url, file_type, attachments FROM posts WHERE subreddit_id = ?", [subId], (postErr, postRows) => {
            if (postErr) return res.status(500).json({ error: postErr.message });
            const uploadPaths = collectUploadPaths(postRows);

            // Admin can bypass subreddit password
            if (isAdminRequest(req)) {
                return deleteSubreddit(res, uploadPaths);
            }

            if (!verifyAndUpgrade(password, row.password, (h) => db.run("UPDATE subreddits SET password = ? WHERE id = ?", [h, subId]))) {
                return res.status(403).json({ error: "Incorrect password" });
            }

            deleteSubreddit(res, uploadPaths);
        });
    });

    function deleteSubreddit(response, uploadPaths = []) {
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
                db.run("DELETE FROM votes WHERE target_type='comment' AND target_id IN (SELECT id FROM comments WHERE post_id IN (SELECT id FROM posts WHERE subreddit_id = ?))", [subId], (e) => {
                    if (e) return fail(e);
                    db.run("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE subreddit_id = ?)", [subId], (e) => {
                        if (e) return fail(e);
                        db.run("DELETE FROM posts WHERE subreddit_id = ?", [subId], (e) => {
                            if (e) return fail(e);
                                db.run("DELETE FROM subreddits WHERE id = ?", [subId], (e) => {
                                    if (e) return fail(e);
                                    db.run("COMMIT", (e) => {
                                        if (e) return fail(e);
                                        const cleanupFailures = deleteUploadPaths(uploadPaths);
                                        if (cleanupFailures.length > 0) {
                                            return response.status(500).json({ error: "Subreddit data was deleted, but one or more attachment files could not be removed." });
                                        }
                                        response.json({ message: "Subreddit deleted" });
                                    });
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
        if (!fs.existsSync(UPLOADS_DIR)) {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        }
        cb(null, UPLOADS_DIR);
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
    if (Object.prototype.hasOwnProperty.call(MIME_EXT_MAP, file.mimetype)) {
        return cb(null, true);
    }
    cb(new Error("Only supported image and video file types can be uploaded."), false);
}

const upload = multer({
    storage: storage,
    fileFilter: safeFileFilter,
    limits: {
        fileSize: MAX_ATTACHMENT_SIZE_BYTES,
        files: MAX_ATTACHMENTS_PER_POST
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

function enforceProjectedUploadQuota(req, res, next) {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('multipart/form-data')) {
        return next();
    }

    const contentLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return res.status(411).json({ error: "A valid Content-Length header is required for uploads." });
    }

    if (getDirectorySize(UPLOADS_DIR) + contentLength > MAX_UPLOADS_DIRECTORY_SIZE_BYTES) {
        return res.status(413).json({ error: "Upload storage quota exceeded. Remove older uploads before adding more files." });
    }

    next();
}

// 4. Create post (with optional file attachments)
app.post('/api/r/:subreddit_name', sensitiveLimiter, enforceProjectedUploadQuota, safeUploadAttachments, (req, res) => {
    const subName = req.params.subreddit_name;
    const fail = (status, message) => {
        const cleanupFailures = cleanupUploadedFiles(req.files);
        if (cleanupFailures.length > 0) {
            return res.status(500).json({
                error: "Upload cleanup failed. Check data/uploads and available disk space."
            });
        }
        return res.status(status).json(typeof message === 'string' ? { error: message } : message);
    };
    const payload = normalizeCreatePostPayload(req.body);
    if (payload.error) return fail(400, payload.error);

    let { title, content, author, password } = payload.value;

    db.get("SELECT id FROM subreddits WHERE name = ?", [subName], (lookupErr, sub) => {
        if (lookupErr) return fail(500, lookupErr.message);
        if (!sub) return fail(404, "Subreddit not found");

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

        const invalidUpload = (req.files || []).find((file) => !fileHasExpectedSignature(file.path, file.mimetype));
        if (invalidUpload) {
            return fail(400, "One or more uploaded files do not match their declared file type.");
        }
        if ((req.files || []).length > 0 && getDirectorySize(UPLOADS_DIR) > MAX_UPLOADS_DIRECTORY_SIZE_BYTES) {
            return fail(413, "Upload storage quota exceeded. Remove older uploads before adding more files.");
        }

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
        return res.status(400).json({ error: "post_id and non-empty content are required" });
    }
    return db.get("SELECT id FROM posts WHERE id = ?", [post_id], (postErr, postRow) => {
        if (postErr) return res.status(500).json({ error: postErr.message });
        if (!postRow) return res.status(404).json({ error: "Post not found" });

        const insertComment = () => {
            db.run("INSERT INTO comments (post_id, parent_id, content, author) VALUES (?, ?, ?, ?)",
                [post_id, parent_id || null, content, author], function (insertErr) {
                    if (insertErr) return res.status(500).json({ error: insertErr.message });
                    res.json({ id: this.lastID });
                });
        };

        if (!parent_id) {
            return insertComment();
        }

        db.get("SELECT id, post_id FROM comments WHERE id = ?", [parent_id], (parentErr, parentRow) => {
            if (parentErr) return res.status(500).json({ error: parentErr.message });
            if (!parentRow) return res.status(404).json({ error: "Parent comment not found" });
            if (Number(parentRow.post_id) !== Number(post_id)) {
                return res.status(400).json({ error: "Parent comment must belong to the same post" });
            }

            insertComment();
        });
    });
});

// 6.1 Delete comment (Admin only)
app.delete('/api/comments/:id', sensitiveLimiter, (req, res) => {
    const commentId = req.params.id;

    if (!isAdminRequest(req)) {
        return res.status(403).json({ error: "Admin access required" });
    }

    db.serialize(() => {
        db.run("BEGIN");
        const fail = (err) => {
            db.run("ROLLBACK");
            return res.status(500).json({ error: err.message });
        };

        db.run("DELETE FROM votes WHERE target_type='comment' AND target_id = ?", [commentId], (voteErr) => {
            if (voteErr) return fail(voteErr);
            db.run("DELETE FROM comments WHERE id = ?", [commentId], function (err) {
                if (err) return fail(err);
                if (this.changes === 0) {
                    db.run("ROLLBACK");
                    return res.status(404).json({ error: "Comment not found" });
                }
                db.run("COMMIT", (commitErr) => {
                    if (commitErr) return fail(commitErr);
                    res.json({ message: "Comment deleted successfully" });
                });
            });
        });
    });
});

// 7. Delete post (with password check or admin bypass)
app.delete('/api/posts/:id', sensitiveLimiter, (req, res) => {
    const postId = req.params.id;
    const { password } = req.body;

    db.get("SELECT password, file_url, file_type, attachments FROM posts WHERE id = ?", [postId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Post not found" });
        const uploadPaths = collectUploadPaths([row]);

        // Admin can bypass post password
        if (isAdminRequest(req)) {
            return deletePost(postId, res, uploadPaths);
        }

        if (!verifyAndUpgrade(password, row.password, (h) => db.run("UPDATE posts SET password = ? WHERE id = ?", [h, postId]))) {
            return res.status(403).json({ error: "Incorrect password" });
        }

        deletePost(postId, res, uploadPaths);
    });

    function deletePost(id, response, uploadPaths = []) {
        db.serialize(() => {
            db.run("BEGIN");
            const fail = (err) => {
                db.run("ROLLBACK");
                return response.status(500).json({ error: err.message });
            };
            // comments cascade via FK; votes have no FK so delete manually.
            db.run("DELETE FROM votes WHERE target_type='comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)", [id], (e) => {
                if (e) return fail(e);
                db.run("DELETE FROM comments WHERE post_id = ?", [id], (e) => {
                    if (e) return fail(e);
                    db.run("DELETE FROM votes WHERE target_type='post' AND target_id=?", [id], (e) => {
                        if (e) return fail(e);
                        db.run("DELETE FROM posts WHERE id = ?", [id], (e) => {
                            if (e) return fail(e);
                            db.run("COMMIT", (e) => {
                                if (e) return fail(e);
                                const cleanupFailures = deleteUploadPaths(uploadPaths);
                                if (cleanupFailures.length > 0) {
                                    return response.status(500).json({ error: "Post data was deleted, but one or more attachment files could not be removed." });
                                }
                                response.json({ message: "Deleted successfully" });
                            });
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
    const { title, content, password } = req.body;

    // Admin can bypass post password
    const isAdmin = isAdminRequest(req);

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

// 7.3 Change access/admin passwords from the admin menu
app.post('/api/admin/password', sensitiveLimiter, (req, res) => {
    if (!isAdminRequest(req)) {
        return res.status(403).json({ error: "Admin access required" });
    }

    const { target, currentAdminPassword, newPassword } = req.body || {};
    if (!['access', 'admin'].includes(target)) {
        return res.status(400).json({ error: "target must be 'access' or 'admin'" });
    }
    if (!verifyAdmin(currentAdminPassword)) {
        return res.status(403).json({ error: "Current admin password is incorrect" });
    }
    if (typeof newPassword !== 'string' || newPassword.trim() !== newPassword || newPassword.length === 0) {
        return res.status(400).json({ error: "New password must be a non-empty string without leading or trailing spaces" });
    }
    if (isWeakAdminPassword(newPassword)) {
        return res.status(400).json({ error: "New password must be at least 8 characters and cannot be a common default" });
    }

    const previousConfig = JSON.parse(JSON.stringify(config));
    try {
        if (target === 'admin') {
            const accessWasImplicit = !hasExplicitAccessPassword();
            config.admin.password = newPassword;
            if (accessWasImplicit) {
                accessCredentials.password = newPassword;
            }
        } else {
            if (!config.access || typeof config.access !== 'object') {
                config.access = {};
            }
            config.access.enabled = true;
            if (typeof config.access.username !== 'string' || !config.access.username.trim()) {
                config.access.username = accessCredentials.username || config.admin.username;
            }
            config.access.password = newPassword;
        }

        writeConfigFile();
        syncAccessCredentialsFromConfig();
        return res.json({ success: true, target });
    } catch (err) {
        config = previousConfig;
        syncAccessCredentialsFromConfig();
        return res.status(500).json({ error: `Failed to update config.json: ${err.message}` });
    }
});

// 8. Export all posts to Markdown files
app.post('/api/export', (req, res) => {
    // Basic protection (optional but good practice)
    if (!isAdminRequest(req)) {
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
            const safeTitle = limitFileComponent(rawTitle, 'unnamed_post');
            const safeDate = limitFileComponent(post.created_at ? post.created_at.substring(0, 10).replace(/[: ]/g, '-') : 'unknown-date', 'unknown-date', 32);
            const safeAuthor = limitFileComponent(post.author || 'unknown', 'unknown', 48);

            // Include post.id to prevent overwriting files with identical names
            const fileName = `${safeTitle}_${safeDate}_${safeAuthor}_${post.id}.md`;
            const filePath = path.join(subDir, fileName);

            const normalizedPost = normalizePost(post);
            const cleanContent = stripAttachmentMarkers(post.content || '', normalizedPost.attachments);
            const attachmentBlock = normalizedPost.attachments.map(attachmentMarkdown).join('\n\n');
            const bodyContent = attachmentBlock ? `${cleanContent}\n\n${attachmentBlock}` : cleanContent;
            const titleHeading = sanitizeHeading(rawTitle, 'Untitled');

            const mdContent = `---
title: ${yamlQuoted(rawTitle)}
author: ${yamlQuoted(post.author || '')}
subreddit: ${yamlQuoted(`r/${subName}`)}
date: ${yamlQuoted(post.created_at || '')}
---

# ${titleHeading}

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
const listenHost = getListenHost();
const server = app.listen(PORT, listenHost, () => {
    const localIp = getLocalAddress();
    const networkLine = isLanExposureEnabled()
        ? `      - Network: http://${localIp}:${PORT}`
        : '      - Network: disabled by default (set server.exposeLan=true in config.json)';
    console.log(`
    ===========================================
      USB Reddit Server Running!
    ===========================================
      - Local:   http://localhost:${PORT}
${networkLine}
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
