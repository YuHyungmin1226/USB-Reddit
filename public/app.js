const API_URL = '/api';

const app = {
    currentSub: 'general',
    currentPostId: null,
    user: 'Guest',
    authenticated: false,
    accessEnabled: true,
    isAdmin: false,
    adminPassword: null,
    passwordResolver: null,
    currentPage: 1,
    totalPages: 1,
    adminEditFlag: false,
    loadPostsToken: 0,

    showToast: (message, type = 'info', duration = 3000) => {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    },

    // --- Security helpers ---

    // Escape user-supplied text before it is interpolated raw into innerHTML templates.
    escapeHtml: (s) => {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    // Whitelist-based HTML sanitizer using the browser's built-in DOMParser.
    // Removes dangerous tags, on* event handlers and unsafe URL schemes while
    // preserving legitimate markdown output (images, links, intended YouTube iframes).
    sanitizeHtml: (html) => {
        if (!html) return '';

        const DANGEROUS_TAGS = new Set([
            'SCRIPT', 'STYLE', 'OBJECT', 'EMBED', 'LINK', 'META',
            'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT',
            'APPLET', 'FRAME', 'FRAMESET', 'NOSCRIPT'
        ]);

        // Attributes that carry URLs and must have their scheme validated.
        const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background']);

        const isSafeUrl = (value, allowData) => {
            if (!value) return true;
            const trimmed = value.trim();
            // Strip control/whitespace chars that can hide a scheme (e.g. "java\nscript:").
            const normalized = trimmed.replace(/[\x00-\x20]/g, '').toLowerCase();
            if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) return false;
            if (normalized.startsWith('data:')) {
                // Only allow image data URIs (and only where data is acceptable).
                return allowData && /^data:image\//.test(normalized);
            }
            return true;
        };

        const getSafeYouTubeEmbedSrc = (src) => {
            if (!src) return null;
            try {
                const url = new URL(src, window.location.href);
                const host = url.hostname.toLowerCase();
                const pathname = url.pathname.replace(/\/+$/, '');
                if (url.protocol !== 'https:') return null;
                const allowedHost =
                    host === 'www.youtube.com' ||
                    host === 'youtube.com' ||
                    host === 'www.youtube-nocookie.com' ||
                    host === 'youtube-nocookie.com';
                if (!allowedHost || !pathname.startsWith('/embed/')) return null;
                return `${url.origin}${pathname}`;
            } catch (e) {
                return null;
            }
        };

        const doc = new DOMParser().parseFromString(html, 'text/html');

        // Walk the tree; collect nodes to remove first to avoid mutating during traversal.
        const toRemove = [];
        const walk = (node) => {
            const children = Array.from(node.childNodes);
            for (const child of children) {
                if (child.nodeType !== 1) continue; // only elements
                const tag = child.tagName.toUpperCase();

                if (DANGEROUS_TAGS.has(tag)) {
                    toRemove.push(child);
                    continue;
                }

                if (tag === 'IFRAME') {
                    const safeSrc = getSafeYouTubeEmbedSrc(child.getAttribute('src'));
                    if (!safeSrc) {
                        toRemove.push(child);
                        continue;
                    }
                    child.setAttribute('src', safeSrc);
                    child.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
                    child.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                    child.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
                    child.setAttribute('loading', 'lazy');
                    child.setAttribute('allowfullscreen', '');
                }

                // Clean attributes.
                const isImg = tag === 'IMG';
                for (const attr of Array.from(child.attributes)) {
                    const name = attr.name.toLowerCase();
                    if (name.startsWith('on')) {
                        child.removeAttribute(attr.name);
                        continue;
                    }
                    if (name === 'id' || name === 'name') {
                        child.removeAttribute(attr.name);
                        continue;
                    }
                    if (tag === 'IFRAME' && name === 'srcdoc') {
                        child.removeAttribute(attr.name);
                        continue;
                    }
                    if (name === 'style') {
                        child.removeAttribute(attr.name);
                        continue;
                    }
                    if (URL_ATTRS.has(name)) {
                        if (!isSafeUrl(attr.value, isImg || tag === 'VIDEO' || tag === 'SOURCE')) {
                            child.removeAttribute(attr.name);
                        }
                    }
                }

                walk(child);
            }
        };
        walk(doc.body);
        toRemove.forEach(n => n.remove());

        return doc.body.innerHTML;
    },

    extractYouTubeId: (value) => {
        if (!value) return null;
        try {
            const url = new URL(value, window.location.href);
            const host = url.hostname.toLowerCase();
            if (host === 'youtu.be' || host === 'www.youtu.be') {
                return url.pathname.replace(/^\/+/, '').split('/')[0] || null;
            }
            if (host === 'youtube.com' || host === 'www.youtube.com') {
                return url.searchParams.get('v');
            }
        } catch (err) {
            return null;
        }
        return null;
    },

    embedBareYouTubeUrls: (text) => {
        const lines = String(text || '').split(/\r?\n/);
        let activeFence = null;

        return lines.map((line) => {
            const fenceMatch = line.match(/^\s*([`~]{3,})/);
            if (fenceMatch) {
                const marker = fenceMatch[1];
                if (!activeFence) {
                    activeFence = marker;
                } else if (marker[0] === activeFence[0] && marker.length >= activeFence.length) {
                    activeFence = null;
                }
                return line;
            }

            if (activeFence) return line;
            if (/^(?: {4,}|\t)/.test(line)) return line;

            return line.replace(
                /^(\s*)((?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^\s<]+)(\s*)$/,
                (match, leading, url, trailing) => {
                    const videoId = app.extractYouTubeId(url);
                    if (!videoId) return match;
                    return `${leading}<div class="video-container"><iframe src="https://www.youtube.com/embed/${videoId}" allowfullscreen></iframe></div>${trailing}`;
                }
            );
        }).join('\n');
    },

    getSafeAttachmentUrl: (value) => {
        if (typeof value !== 'string' || !value.trim()) return null;
        const trimmed = value.trim();
        const normalized = trimmed.replace(/[\x00-\x20]/g, '').toLowerCase();
        if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:') || normalized.startsWith('data:')) {
            return null;
        }
        try {
            const url = new URL(trimmed, window.location.href);
            if (url.origin !== window.location.origin) return null;
            if (!url.pathname.startsWith('/uploads/')) return null;
            return `${url.pathname}${url.search}${url.hash}`;
        } catch (err) {
            return null;
        }
    },

    init: async () => {
        document.body.classList.add('auth-locked');
        const session = await app.checkSession();
        if (!session.authenticated) {
            app.showAuthScreen();
            return;
        }

        app.applySession(session);
        await app.loadInitialData();
    },

    checkSession: async () => {
        try {
            const res = await fetch(`${API_URL}/session`);
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                return { authenticated: false, accessEnabled: true, ...json };
            }
            return json;
        } catch (err) {
            return { authenticated: false, accessEnabled: true, error: "Server connection failed" };
        }
    },

    loadInitialData: async () => {
        await app.loadSubreddits();
        app.loadPosts();
    },

    applySession: (session) => {
        app.authenticated = Boolean(session.authenticated);
        app.accessEnabled = session.accessEnabled !== false;
        app.isAdmin = session.role === 'admin';
        app.adminPassword = null;
        localStorage.removeItem('isAdmin');
        app.updateAdminUI();
        app.hideAuthScreen();
    },

    showAuthScreen: (message = '') => {
        app.authenticated = false;
        app.isAdmin = false;
        app.adminPassword = null;
        localStorage.removeItem('isAdmin');
        app.updateAdminUI();
        document.body.classList.add('auth-locked');
        document.getElementById('post-list').innerHTML = '';
        document.getElementById('single-post-content').innerHTML = '';
        document.getElementById('comments-list').innerHTML = '';
        document.getElementById('auth-error').innerText = message;
        setTimeout(() => document.getElementById('auth-username').focus(), 0);
    },

    hideAuthScreen: () => {
        document.body.classList.remove('auth-locked');
        document.getElementById('auth-error').innerText = '';
        document.getElementById('auth-password').value = '';
    },

    submitAppLogin: async () => {
        const username = document.getElementById('auth-username').value;
        const password = document.getElementById('auth-password').value;
        const submitBtn = document.getElementById('auth-submit-btn');

        if (!username || !password) {
            document.getElementById('auth-error').innerText = 'Enter username and password.';
            return;
        }

        submitBtn.disabled = true;
        document.getElementById('auth-error').innerText = '';

        try {
            const res = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const json = await res.json().catch(() => ({}));

            if (!res.ok || !json.success) {
                document.getElementById('auth-error').innerText = json.error || 'Login failed.';
                return;
            }

            app.applySession(json);
            if (json.role === 'admin') {
                app.adminPassword = password;
            }
            document.getElementById('auth-username').value = '';
            await app.loadInitialData();
        } catch (err) {
            document.getElementById('auth-error').innerText = 'Server connection failed.';
        } finally {
            submitBtn.disabled = false;
        }
    },

    // --- Navigation & UI ---

    goHome: () => {
        document.getElementById('single-post-view').style.display = 'none';
        document.getElementById('post-list').style.display = 'flex';
        document.getElementById('create-post-form').style.display = 'none';
        app.currentPostId = null;
        app.loadPosts(app.currentSub);
    },

    toggleCreateForm: (forceReset = false) => {
        const form = document.getElementById('create-post-form');
        const isVisible = form.style.display === 'block';

        if (isVisible && !forceReset) {
            form.style.display = 'none';
        } else {
            // Only reset if requested or if we are not already in the middle of something
            const currentId = document.getElementById('edit-post-id').value;
            const hasTitle = document.getElementById('post-title').value;
            const hasContent = document.getElementById('post-content').value;

            if (forceReset || (!currentId && !hasTitle && !hasContent)) {
                app.resetPostForm();
            }

            form.style.display = 'block';
            const subNameSpan = document.getElementById('create-post-sub-name');
            if (subNameSpan) {
                subNameSpan.innerText = app.currentSub;
            }
            window.scrollTo(0, 0); // Scroll to top to see the form
        }
    },

    resetPostForm: () => {
        const formTitle = document.getElementById('form-title');
        const subNameSpan = document.getElementById('create-post-sub-name');
        if (subNameSpan) {
            formTitle.textContent = 'Create Post in r/';
            const safeSpan = document.createElement('span');
            safeSpan.id = 'create-post-sub-name';
            safeSpan.innerText = app.currentSub;
            formTitle.appendChild(safeSpan);
        } else {
            formTitle.innerText = `Create Post in r/${app.currentSub}`;
        }
        document.getElementById('edit-post-id').value = '';
        document.getElementById('post-title').value = '';
        document.getElementById('post-content').value = '';
        document.getElementById('post-author').disabled = false;
        document.getElementById('post-password').value = '';
        document.getElementById('attachment-field').style.display = 'block';
        document.getElementById('post-submit-btn').innerText = "Post";
        app.adminEditFlag = false;
        
        // Auto fill author if known
        if (app.user !== 'Guest') {
            document.getElementById('post-author').value = app.user;
        }
        const editTab = document.getElementById('edit-tab');
        const previewTab = document.getElementById('preview-tab');
        if (editTab && previewTab) app.switchEditorTab('edit');
        const existingAttach = document.getElementById('existing-attachment');
        if (existingAttach) existingAttach.remove();
        app.revokePreviewUrls();
        const filePreview = document.getElementById('file-preview');
        if (filePreview) {
            filePreview.innerHTML = '';
            filePreview.style.display = 'none';
        }
        const fileInput = document.getElementById('post-file');
        if (fileInput) fileInput.value = '';
    },

    // Object URLs created for the current file preview, kept so they can be revoked.
    previewObjectUrls: [],

    revokePreviewUrls: () => {
        (app.previewObjectUrls || []).forEach((url) => {
            try { URL.revokeObjectURL(url); } catch (e) {}
        });
        app.previewObjectUrls = [];
    },

    previewSelectedFile: (event) => {
        const files = Array.from(event.target.files || []);
        const previewDiv = document.getElementById('file-preview');
        if (!previewDiv) return;
        // Release any URLs from a previous selection before creating new ones.
        app.revokePreviewUrls();
        previewDiv.innerHTML = '';
        if (files.length === 0) {
            previewDiv.style.display = 'none';
            return;
        }
        previewDiv.style.display = 'block';
        files.forEach((file) => {
            const item = document.createElement('div');
            item.style.cssText = 'margin:8px 8px 8px 0; display:inline-block; vertical-align:top; max-width:200px;';

            const label = document.createElement('div');
            label.style.cssText = 'font-size:0.75rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            label.textContent = file.name;

            let media;
            if (file.type.startsWith('video/')) {
                media = document.createElement('video');
                media.controls = true;
            } else {
                media = document.createElement('img');
                media.alt = file.name || 'Selected file preview';
            }
            const objectUrl = URL.createObjectURL(file);
            app.previewObjectUrls.push(objectUrl);
            media.src = objectUrl;
            media.style.cssText = 'max-width:200px; max-height:160px; border-radius:4px;';

            item.appendChild(media);
            item.appendChild(label);
            previewDiv.appendChild(item);
        });
    },

    switchEditorTab: (tab) => {
        const textarea = document.getElementById('post-content');
        const preview = document.getElementById('post-preview');
        const editTab = document.getElementById('edit-tab');
        const previewTab = document.getElementById('preview-tab');
        if (!textarea || !preview || !editTab || !previewTab) return;

        if (tab === 'preview') {
            editTab.classList.remove('active');
            previewTab.classList.add('active');
            textarea.style.display = 'none';
            preview.style.display = 'block';
            preview.innerHTML = app.parseMarkdown(textarea.value) || '<span style="color:var(--text-secondary);">Nothing to preview</span>';
        } else {
            previewTab.classList.remove('active');
            editTab.classList.add('active');
            preview.style.display = 'none';
            textarea.style.display = 'block';
        }
    },

    promptNickname: () => {
        const name = prompt("Enter your nickname:");
        if (name) {
            app.user = name;
            document.getElementById('current-user').innerText = name;
        }
    },

    promptAdminLogin: () => {
        document.getElementById('login-modal').style.display = 'flex';
        document.getElementById('admin-username').focus();
    },

    closeLoginModal: () => {
        document.getElementById('login-modal').style.display = 'none';
        document.getElementById('admin-username').value = '';
        document.getElementById('admin-password').value = '';
    },

    openAdminMenu: () => {
        document.getElementById('admin-menu-status').innerText = '';
        document.getElementById('admin-menu-status').className = 'admin-menu-status';
        document.getElementById('admin-current-password').value = '';
        document.getElementById('admin-new-password').value = '';
        document.getElementById('admin-confirm-password').value = '';
        document.getElementById('admin-menu-modal').style.display = 'flex';
        document.getElementById('admin-current-password').focus();
    },

    closeAdminMenu: () => {
        document.getElementById('admin-menu-modal').style.display = 'none';
        document.getElementById('admin-current-password').value = '';
        document.getElementById('admin-new-password').value = '';
        document.getElementById('admin-confirm-password').value = '';
        document.getElementById('admin-menu-status').innerText = '';
        document.getElementById('admin-menu-status').className = 'admin-menu-status';
    },

    setAdminMenuStatus: (message, type = 'info') => {
        const status = document.getElementById('admin-menu-status');
        status.innerText = message || '';
        status.className = `admin-menu-status ${type}`;
    },

    submitPasswordChange: async () => {
        const target = document.getElementById('admin-password-target').value;
        const currentAdminPassword = document.getElementById('admin-current-password').value;
        const newPassword = document.getElementById('admin-new-password').value;
        const confirmPassword = document.getElementById('admin-confirm-password').value;

        if (!currentAdminPassword || !newPassword || !confirmPassword) {
            app.setAdminMenuStatus('Fill in all password fields.', 'error');
            return;
        }
        if (newPassword !== confirmPassword) {
            app.setAdminMenuStatus('New passwords do not match.', 'error');
            return;
        }

        try {
            const json = await app.fetchJson(`${API_URL}/admin/password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target, currentAdminPassword, newPassword })
            });

            if (target === 'admin') {
                app.adminPassword = newPassword;
            }

            document.getElementById('admin-current-password').value = '';
            document.getElementById('admin-new-password').value = '';
            document.getElementById('admin-confirm-password').value = '';
            app.setAdminMenuStatus(json.target === 'admin' ? 'Admin password changed.' : 'App login password changed.', 'success');
            app.showToast('Password changed.', 'success');
        } catch (err) {
            app.setAdminMenuStatus(err.message || 'Failed to change password.', 'error');
        }
    },

    submitAdminLogin: async () => {
        const username = document.getElementById('admin-username').value;
        const password = document.getElementById('admin-password').value;

        if (!username || !password) { app.showToast("Please enter both username and password.", 'error'); return; }

        try {
            const res = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const json = await res.json();
            if (json.success && json.role === 'admin') {
                app.applySession(json);
                app.isAdmin = true;
                app.adminPassword = password;
                app.updateAdminUI();
                app.closeLoginModal();
                
                // Re-render current post if viewing one to show admin buttons
                if (app.currentPostId) {
                    app.viewPost(app.currentPostId);
                }
                
                app.showToast("Logged in as admin.", 'success');
            } else {
                app.showToast("Admin credentials required.", 'error');
            }
        } catch (err) {
            app.showToast("Error during login", 'error');
        }
    },

    logout: async () => {
        try {
            await fetch(`${API_URL}/logout`, { method: 'POST' });
        } catch (err) {
            // Local state is cleared even if the network request fails.
        }

        app.isAdmin = false;
        app.authenticated = false;
        app.adminPassword = null;
        localStorage.removeItem('isAdmin');
        app.updateAdminUI();
        app.currentPostId = null;
        app.showAuthScreen();
    },

    updateAdminUI: () => {
        const adminMenuBtn = document.getElementById('admin-menu-btn');
        const loginBtn = document.getElementById('login-btn');
        const logoutBtn = document.getElementById('logout-btn');
        const adminBadge = document.getElementById('admin-badge');

        adminMenuBtn.style.display = app.isAdmin ? 'inline-block' : 'none';
        logoutBtn.style.display = app.authenticated ? 'inline-block' : 'none';
        loginBtn.style.display = app.authenticated && !app.isAdmin ? 'inline-block' : 'none';
        adminBadge.style.display = app.isAdmin ? 'inline-block' : 'none';
    },

    // --- API Calls ---

    // Centralized fetch + JSON helper: checks res.ok, parses JSON safely,
    // and surfaces failures via the toast mechanism. Throws on failure so
    // callers can decide whether to abort their own flow.
    fetchJson: async (url, opts = {}) => {
        let res;
        try {
            res = await fetch(url, opts);
        } catch (err) {
            app.showToast("Network error. Is the server running?", 'error');
            throw err;
        }

        let json = null;
        try {
            json = await res.json();
        } catch (e) {
            json = null;
        }

        if (res.status === 401) {
            const message = (json && json.error) ? json.error : 'Login required';
            app.showAuthScreen(message);
            const error = new Error(message);
            error.status = res.status;
            error.body = json;
            throw error;
        }

        if (!res.ok) {
            const message = (json && json.error) ? json.error : `Request failed (${res.status})`;
            app.showToast("Error: " + message, 'error');
            const error = new Error(message);
            error.status = res.status;
            error.body = json;
            throw error;
        }

        return json;
    },

    loadSubreddits: async () => {
        try {
            const json = await app.fetchJson(`${API_URL}/subreddits`);
            const nav = document.getElementById('sub-nav');
            nav.innerHTML = '';

            json.data.forEach(sub => {
                const link = document.createElement('a');
                link.className = `sub-link ${app.currentSub === sub.name ? 'active' : ''}`;
                link.innerText = `r/${sub.name}`;
                link.onclick = (e) => {
                    e.preventDefault();
                    app.switchSub(sub.name, link);
                };
                nav.appendChild(link);
            });

            // Add a (+) button to create sub
            const addBtn = document.createElement('a');
            addBtn.className = 'sub-link';
            addBtn.innerText = '+';
            addBtn.style.cursor = 'pointer';
            addBtn.onclick = app.openCreateSubModal;
            nav.appendChild(addBtn);

        } catch (err) {
            console.error(err);
        }
    },

    switchSub: (subName, el) => {
        app.currentSub = subName;
        // Update active class
        document.querySelectorAll('.sub-link').forEach(a => a.classList.remove('active'));
        if (el) el.classList.add('active');

        app.goHome();
    },

    openCreateSubModal: () => {
        document.getElementById('create-sub-modal').style.display = 'flex';
        document.getElementById('new-sub-name').value = '';
        document.getElementById('new-sub-desc').value = '';
        document.getElementById('new-sub-password').value = '';
        document.getElementById('new-sub-name').focus();
    },

    closeCreateSubModal: () => {
        document.getElementById('create-sub-modal').style.display = 'none';
    },

    submitCreateSub: async () => {
        const name = document.getElementById('new-sub-name').value;
        const desc = document.getElementById('new-sub-desc').value;
        const password = document.getElementById('new-sub-password').value;

        if (!name) { app.showToast("Subreddit name is required.", 'error'); return; }
        if (!password) { app.showToast("Password is required.", 'error'); return; }

        try {
            const json = await app.fetchJson(`${API_URL}/subreddits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description: desc, password })
            });
            app.closeCreateSubModal();
            app.currentSub = json.name;
            await app.loadSubreddits();
            const activeLink = Array.from(document.querySelectorAll('.sub-link'))
                .find((link) => link.innerText === `r/${json.name}`);
            app.switchSub(json.name, activeLink);
        } catch (err) {
            console.error('Failed to create subreddit:', err);
        }
    },

    vote: async (targetType, targetId, value) => {
        try {
            const json = await app.fetchJson(`${API_URL}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_type: targetType, target_id: targetId, value })
            });
            if (json && json.success) {
                const el = document.getElementById(`vote-count-${targetId}`);
                if (el) el.textContent = json.total;
                app.recordVote(targetId, value);
                app.highlightVote(targetId, value);
            }
        } catch (err) {
            console.error('Vote error:', err);
        }
    },

    recordVote: (targetId, value) => {
        let votes = {};
        try { votes = JSON.parse(sessionStorage.getItem('myVotes') || '{}'); } catch(e) {}
        votes[targetId] = value;
        sessionStorage.setItem('myVotes', JSON.stringify(votes));
    },

    restoreVoteHighlights: () => {
        let votes = {};
        try { votes = JSON.parse(sessionStorage.getItem('myVotes') || '{}'); } catch(e) {}
        Object.entries(votes).forEach(([id, value]) => {
            app.highlightVote(parseInt(id), value);
        });
    },

    highlightVote: (targetId, value) => {
        document.querySelectorAll(`.vote-btn[onclick*="'post', ${targetId},"]`).forEach(el => {
            el.style.opacity = el.textContent === (value > 0 ? '⬆' : '⬇') ? '1' : '0.5';
        });
    },

    loadPosts: async (subreddit = app.currentSub, loadMore = false) => {
        const list = document.getElementById('post-list');

        // Sequence token: only the most recent request is allowed to mutate the DOM.
        // Prevents a slow earlier request from overwriting a newer subreddit's view.
        const token = ++app.loadPostsToken;

        if (!loadMore) {
            app.currentPage = 1;
        }

        let headerHtml = '';
        if (subreddit !== 'all') {
            let deleteBtn = '';
            if (subreddit !== 'general' && subreddit !== 'random') {
                deleteBtn = `<button onclick="app.deleteCurrentSub()" style="background:transparent; color:#666; border:1px solid #ccc; padding:5px 10px; cursor:pointer; border-radius:4px; font-size: 0.8rem;">Delete</button>`;
            }

            headerHtml = `
                <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px 20px;">
                    <h2>r/${app.escapeHtml(subreddit)}</h2>
                    ${deleteBtn}
                </div>
             `;

            if (!loadMore) {
                list.innerHTML = headerHtml + '<div style="text-align:center; padding:20px;">Loading...</div>';
            }
        } else if (!loadMore) {
            list.innerHTML = '<div style="text-align:center; padding:20px;">Loading...</div>';
        }

        try {
            const json = await app.fetchJson(`${API_URL}/r/${subreddit}?page=${app.currentPage}&limit=20`);

            // A newer request superseded this one; discard the stale response.
            if (token !== app.loadPostsToken) return;

            if (!loadMore) {
                list.innerHTML = headerHtml || '';
            }

            app.totalPages = json.pagination?.totalPages || 1;

            const oldBtn = document.getElementById('load-more-btn');
            if (oldBtn) oldBtn.remove();

            if (!json.data || json.data.length === 0) {
                if (!loadMore) {
                    list.innerHTML += '<div style="text-align:center; padding:20px; color:#666;">No posts here yet. Be the first!</div>';
                }
                return;
            }

            json.data.forEach(post => {
                const card = document.createElement('div');
                card.className = 'post-card';
                card.onclick = (e) => {
                    if (e.target.closest('.vote-btn, .vote-count')) return;
                    app.viewPost(post.id);
                };

                const date = new Date(post.created_at.replace(' ', 'T') + 'Z').toLocaleDateString();
                const displaySub = post.subreddit_name || subreddit;

                card.innerHTML = `
                    <div class="post-meta">
                        <span class="subreddit-tag">r/${app.escapeHtml(displaySub)}</span> • Posted by ${app.escapeHtml(post.author)} • ${app.escapeHtml(date)}
                    </div>
                    <h2 class="post-title">${app.escapeHtml(post.title)}</h2>
                    <div class="post-actions">
                        <span class="vote-btn" onclick="event.stopPropagation(); app.vote('post', ${post.id}, 1)" title="Upvote">⬆</span>
                        <span class="vote-count" id="vote-count-${post.id}">${app.escapeHtml(post.upvotes)}</span>
                        <span class="vote-btn" onclick="event.stopPropagation(); app.vote('post', ${post.id}, -1)" title="Downvote">⬇</span>
                        <span>${app.escapeHtml(post.comment_count ?? 0)} comments</span>
                    </div>
                `;
                list.appendChild(card);
            });

            if (app.currentPage < app.totalPages) {
                const loadMore = document.createElement('div');
                loadMore.id = 'load-more-btn';
                loadMore.style.cssText = 'text-align:center; padding:20px;';
                const button = document.createElement('button');
                button.className = 'primary-btn';
                button.type = 'button';
                button.innerText = 'Load More';
                button.addEventListener('click', () => app.loadPosts(subreddit, true));
                loadMore.appendChild(button);
                list.appendChild(loadMore);
            }

            app.currentPage++;

            app.restoreVoteHighlights();
        } catch (err) {
            if (token !== app.loadPostsToken) return;
            if (!loadMore) {
                list.innerHTML = (headerHtml || '') + '<div style="color:red; text-align:center; padding:20px;">Failed to load posts. Is server running?</div>';
            }
        }
    },

    deleteCurrentSub: async () => {
        if (app.currentSub === 'general') {
            app.showToast("Cannot delete default subreddit.", 'error'); return;
        }

        let password = null;
        if (app.isAdmin) {
            if (!confirm(`Permanently delete r/${app.currentSub} and ALL its posts?`)) return;
        } else {
            password = await app.requestPassword(`Delete r/${app.currentSub}`, "This action cannot be undone.");
            if (!password) return;
            if (!confirm(`Permanently delete r/${app.currentSub} and ALL its posts?`)) return;
        }

        try {
            const json = await app.fetchJson(`${API_URL}/subreddits`);
            const sub = json.data.find(s => s.name === app.currentSub);

            if (sub) {
                const body = app.isAdmin
                    ? { adminPassword: app.adminPassword }
                    : { password };
                const delRes = await fetch(`${API_URL}/subreddits/${sub.id}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                if (delRes.ok) {
                    app.showToast("Subreddit deleted.", 'success');
                    app.currentSub = 'general';
                    app.loadSubreddits();
                    app.goHome();
                } else {
                    const err = await delRes.json();
                    app.showToast("Failed: " + (err.error || "Unknown"), 'error');
                }
            }
        } catch (e) {
            console.error(e);
            app.showToast("Error deleting.", 'error');
        }
    },

    submitPost: async () => {
        const editId = document.getElementById('edit-post-id').value;
        const title = document.getElementById('post-title').value;
        const content = document.getElementById('post-content').value;
        const author = document.getElementById('post-author').value || 'Anonymous';
        let password = document.getElementById('post-password').value;
        const isAdminEdit = Boolean(editId && app.adminEditFlag);

        if (!password && (!editId || !isAdminEdit)) {
            password = await app.requestPassword("Password Required", "Set a password to manage (edit/delete) this post later:");
            if (!password) return;
            document.getElementById('post-password').value = password;
        }

        if (editId) {
            // Update Existing Post
            try {
                const body = isAdminEdit
                    ? { title, content, password, adminPassword: app.adminPassword }
                    : { title, content, password };
                const res = await fetch(`${API_URL}/posts/${editId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                if (res.ok) {
                    app.showToast("Post updated!", 'success');
                    app.resetPostForm();
                    app.goHome(); // This hides form and refreshes list
                } else {
                    const json = await res.json();
                    app.showToast("Failed to update: " + (json.error || "Unknown error"), 'error');
                }
            } catch (err) {
                app.showToast("Error updating post.", 'error');
            }
        } else {
            // Create New Post
            const fileInput = document.getElementById('post-file');
            const files = Array.from(fileInput.files || []);
            const submitBtn = document.getElementById('post-submit-btn');

            const formData = new FormData();
            formData.append('title', title);
            formData.append('content', content);
            formData.append('author', author);
            formData.append('password', password);

            if (files.length > 0) {
                files.forEach((file) => formData.append('attachment', file));
                // Use XHR with progress tracking for file uploads
                submitBtn.disabled = true;
                document.getElementById('upload-filename').textContent = files.length === 1 ? files[0].name : `${files.length} files`;
                document.getElementById('upload-progress-fill').style.width = '0%';
                document.getElementById('upload-percent').textContent = '0%';
                document.getElementById('upload-status').textContent = 'Uploading...';
                document.getElementById('upload-overlay').style.display = 'flex';

                try {
                    const result = await new Promise((resolve, reject) => {
                        const xhr = new XMLHttpRequest();
                        xhr.upload.onprogress = (e) => {
                            if (e.lengthComputable) {
                                const percent = Math.round((e.loaded / e.total) * 100);
                                document.getElementById('upload-progress-fill').style.width = percent + '%';
                                document.getElementById('upload-percent').textContent = percent + '%';
                            }
                        };
                        xhr.onload = () => {
                            if (xhr.status >= 200 && xhr.status < 300) {
                                resolve(JSON.parse(xhr.responseText));
                            } else {
                                try { reject(JSON.parse(xhr.responseText)); }
                                catch { reject({ error: xhr.statusText || 'Upload failed' }); }
                            }
                        };
                        xhr.onerror = () => reject({ error: 'Network error during upload' });
                        xhr.ontimeout = () => reject({ error: 'Upload timed out' });
                        xhr.open('POST', `${API_URL}/r/${app.currentSub}`);
                        xhr.send(formData);
                    });

                    document.getElementById('upload-overlay').style.display = 'none';
                    submitBtn.disabled = false;
                    app.resetPostForm();
                    app.goHome();
                } catch (err) {
                    document.getElementById('upload-status').textContent = 'Error: ' + (err.error || 'Upload failed');
                    submitBtn.disabled = false;
                    setTimeout(() => {
                        document.getElementById('upload-overlay').style.display = 'none';
                    }, 4000);
                }
            } else {
                // No file - use JSON so plain text posts are not treated as uploads.
                try {
                    const res = await fetch(`${API_URL}/r/${app.currentSub}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title, content, author, password })
                    });

                    if (res.ok) {
                        app.resetPostForm();
                        app.goHome();
                    } else {
                        const json = await res.json();
                        app.showToast("Failed to post: " + (json.error || "Unknown error"), 'error');
                    }
                } catch (err) {
                    app.showToast("Error posting.", 'error');
                }
            }
        }
    },

    viewPost: async (id) => {
        app.currentPostId = id;
        document.getElementById('post-list').style.display = 'none';
        document.getElementById('single-post-view').style.display = 'block';
        const contentDiv = document.getElementById('single-post-content');
        const commentsDiv = document.getElementById('comments-list');

        contentDiv.innerHTML = 'Loading...';

        try {
            const json = await app.fetchJson(`${API_URL}/posts/${id}`);

            if (!json || json.error) {
                contentDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#666;">Post not found.</div>';
                return;
            }

            const p = json.post;
            const attachments = app.getPostAttachments(p);
            const date = new Date(p.created_at.replace(' ', 'T') + 'Z').toLocaleString();

            contentDiv.innerHTML = `
                <div class="post-meta">r/${app.escapeHtml(app.currentSub)} • Posted by ${app.escapeHtml(p.author)} on ${app.escapeHtml(date)}</div>
                <h1 style="color:white; margin: 10px 0;">${app.escapeHtml(p.title)}</h1>
                <div style="font-size: 1.1rem; line-height: 1.6; margin-bottom: 20px;">
                    ${app.parseMarkdown(app.cleanContent(p.content, attachments))}
                </div>
                ${app.renderAttachments(attachments)}
                <div class="post-actions">
                    <span class="vote-btn" onclick="app.vote('post', ${p.id}, 1)" title="Upvote">⬆</span>
                    <span class="vote-count" id="vote-count-${p.id}">${app.escapeHtml(p.upvotes)}</span>
                    <span class="vote-btn" onclick="app.vote('post', ${p.id}, -1)" title="Downvote">⬇</span>
                    <span style="flex-grow:1"></span>
                    <button id="edit-post-btn" class="management-btn edit-btn">Edit</button>
                    <button onclick="app.deletePost(${p.id})" class="management-btn delete-btn">Delete</button>
                </div>
            `;

            // Attach the edit handler via a closure instead of serializing the
            // post object into an inline onclick attribute (prevents HTML/JS injection).
            const editBtn = document.getElementById('edit-post-btn');
            if (editBtn) {
                editBtn.addEventListener('click', () => app.editPost(p));
            }

            const commentTree = {};
            const roots = [];
            json.comments.forEach(c => {
                commentTree[c.id] = { ...c, children: [] };
            });
            json.comments.forEach(c => {
                if (c.parent_id && commentTree[c.parent_id]) {
                    commentTree[c.parent_id].children.push(commentTree[c.id]);
                } else {
                    roots.push(commentTree[c.id]);
                }
            });

            const renderComment = (c, depth = 0) => {
                const div = document.createElement('div');
                div.className = 'comment';
                div.style.marginLeft = `${depth * 24}px`;
                div.style.borderLeft = depth > 0 ? '2px solid var(--border-color)' : '';
                div.style.paddingLeft = depth > 0 ? '12px' : '';
                
                let deleteBtn = '';
                if (app.isAdmin) {
                    deleteBtn = `<button onclick="app.deleteComment(${c.id})" class="management-btn delete-btn" style="padding: 2px 8px; font-size: 0.75rem; margin-left: 12px; border-color: #ff4500 !important; color: #ff4500 !important;">Delete</button>`;
                }

                const commentTime = new Date(c.created_at.replace(' ', 'T') + 'Z').toLocaleTimeString();
                div.innerHTML = `
                    <div class="meta" style="display: flex; align-items: center; flex-wrap: wrap;">
                        <span>${app.escapeHtml(c.author)} • ${app.escapeHtml(commentTime)}</span>
                        ${deleteBtn}
                        <button class="reply-btn" data-comment-id="${c.id}" data-author="${app.escapeHtml(c.author)}" style="background:transparent; border:none; color:var(--accent-color); cursor:pointer; font-size:0.8rem; margin-left:12px;">Reply</button>
                    </div>
                    <div style="margin-top: 8px;">${app.parseMarkdown(c.content)}</div>
                `;
                commentsDiv.appendChild(div);

                // Bind reply via closure rather than embedding the author string in
                // an inline onclick attribute (prevents injection through author names).
                const replyBtn = div.querySelector('.reply-btn');
                if (replyBtn) {
                    replyBtn.addEventListener('click', () => app.replyTo(c.id, c.author));
                }

                c.children.forEach(child => renderComment(child, depth + 1));
            };

            commentsDiv.innerHTML = '';
            roots.forEach(c => renderComment(c));

        } catch (err) {
            console.error(err);
            // Replace the persistent "Loading..." with an actionable error message.
            contentDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#ff6b6b;">Failed to load this post. Please try again.</div>';
        }
    },

    replyTarget: null,

    replyTo: (commentId, author) => {
        app.replyTarget = commentId;
        const indicator = document.getElementById('reply-indicator');
        const target = document.getElementById('reply-target');
        if (indicator && target) {
            target.textContent = author;
            indicator.style.display = 'block';
        }
        document.getElementById('comment-content').focus();
    },

    cancelReply: () => {
        app.replyTarget = null;
        const indicator = document.getElementById('reply-indicator');
        if (indicator) indicator.style.display = 'none';
    },

    submitComment: async () => {
        if (!app.currentPostId) return;
        const content = document.getElementById('comment-content').value;
        const author = document.getElementById('comment-author').value || 'Anonymous';

        if (!content) return;

        try {
            await app.fetchJson(`${API_URL}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    post_id: app.currentPostId,
                    parent_id: app.replyTarget,
                    content,
                    author
                })
            });
            // Only clear the form and reload on success.
            app.cancelReply();
            document.getElementById('comment-content').value = '';
            app.viewPost(app.currentPostId); // Reload
        } catch (err) {
            // fetchJson already showed a toast; keep the user's text so they can retry.
            console.error('Failed to comment:', err);
        }
    },

    deleteComment: async (id) => {
        if (!confirm("Are you sure you want to delete this comment?")) return;

        try {
            const res = await fetch(`${API_URL}/comments/${id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminPassword: app.adminPassword })
            });

            if (res.ok) {
                app.viewPost(app.currentPostId); // Reload
            } else {
                const json = await res.json();
                app.showToast("Failed to delete comment: " + (json.error || "Unknown error"), 'error');
            }
        } catch (err) {
            app.showToast("Error deleting comment", 'error');
            console.error(err);
        }
    },

    parseMarkdown: (text) => {
        if (!text) return '';
        
        // Configure marked options
        marked.setOptions({
            breaks: true, // Support single line breaks
            gfm: true,    // GitHub Flavored Markdown
            headerIds: false,
            mangle: false
        });

        // Custom renderer to support video files in image syntax ![video](url)
        const renderer = new marked.Renderer();
        const originalImage = renderer.image.bind(renderer);
        renderer.image = (token) => {
            const { href, text } = token || {};
            if (!href) return '';
            const isVideo = href.match(/\.(mp4|webm|ogg|mov)$/i) || text === 'video';
            if (isVideo) {
                return `<video controls src="${href}" style="max-width:100%; border-radius:4px; margin-top:10px;"></video>`;
            }
            return originalImage(token);
        };

        // Only convert bare YouTube URLs from the source text so normal links and attributes stay intact.
        const preparedText = app.embedBareYouTubeUrls(text);

        // Parse with marked
        const html = marked.parse(preparedText, { renderer });

        // Always sanitize before the result reaches innerHTML.
        return app.sanitizeHtml(html);
    },

    deletePost: async (id) => {
        let password = null;
        if (app.isAdmin) {
            if (!confirm("Are you sure you want to delete this post?")) return;
        } else {
            password = await app.requestPassword("Delete Post", "Enter the password you set when creating this post.");
            if (!password) return;
            if (!confirm("Are you sure you want to delete this post?")) return;
        }

        try {
            const body = app.isAdmin
                ? { adminPassword: app.adminPassword }
                : { password };
            const res = await fetch(`${API_URL}/posts/${id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (res.ok) {
                app.showToast("Post deleted.", 'success');
                app.goHome();
            } else {
                const json = await res.json();
                app.showToast("Failed to delete: " + (json.error || "Unknown error"), 'error');
            }
        } catch (err) {
            app.showToast("Error deleting post.", 'error');
            console.error(err);
        }
    },

    cleanContent: (content, attachments) => {
        return app.stripAttachmentFromContent(content || '', attachments);
    },

    getPostAttachments: (post) => {
        if (!post) return [];
        if (Array.isArray(post.attachments)) {
            return post.attachments.filter(item => item && item.url);
        }
        if (typeof post.attachments === 'string' && post.attachments.trim()) {
            try {
                const parsed = JSON.parse(post.attachments);
                if (Array.isArray(parsed)) return parsed.filter(item => item && item.url);
            } catch (err) {
                console.warn('Invalid attachments metadata:', err);
            }
        }
        if (post.file_url) {
            return [{ url: post.file_url, type: post.file_type || '' }];
        }
        return [];
    },

    renderAttachment: (fileUrl, fileType) => {
        const safeUrl = app.getSafeAttachmentUrl(fileUrl);
        if (!safeUrl) return '';
        if (fileType && fileType.startsWith('video/')) {
            return `<video controls src="${safeUrl}" style="max-width:100%; border-radius:4px; margin-bottom:20px;"></video>`;
        }
        return `<img src="${safeUrl}" alt="Post attachment" style="max-width:100%; border-radius:4px; margin-bottom:20px;" loading="lazy">`;
    },

    renderAttachments: (attachments) => {
        return (attachments || []).map(attachment => app.renderAttachment(attachment.url, attachment.type)).join('');
    },

    stripAttachmentFromContent: (content, attachments) => {
        let result = content;
        const list = Array.isArray(attachments) ? attachments : (attachments ? [{ url: attachments }] : []);
        [...list].reverse().forEach((attachment) => {
            if (!attachment || !attachment.url) return;
            const escaped = attachment.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\n\\n(!\\[(?:video|image)\\]\\(${escaped}\\)|${escaped})\\s*$`);
            result = result.replace(regex, '');
        });
        return result;
    },

    editPost: async (post) => {
        let password = null;
        let adminEdit = false;
        if (app.isAdmin) {
            adminEdit = true;
        } else {
            password = await app.requestPassword("Edit Post", "Enter post password to edit:");
            if (!password) return;
        }

        document.getElementById('form-title').innerText = "Edit Post";
        document.getElementById('edit-post-id').value = post.id;
        document.getElementById('post-title').value = post.title;
        const attachments = app.getPostAttachments(post);
        const cleanContent = app.stripAttachmentFromContent(post.content, attachments);
        document.getElementById('post-content').value = cleanContent;
        document.getElementById('post-author').value = post.author;
        document.getElementById('post-author').disabled = true;
        document.getElementById('post-password').value = password || '';
        document.getElementById('attachment-field').style.display = 'none';
        document.getElementById('post-submit-btn').innerText = "Update Post";

        const existingAttach = document.getElementById('existing-attachment');
        if (attachments.length > 0) {
            if (!existingAttach) {
                const info = document.createElement('div');
                info.id = 'existing-attachment';
                info.style.cssText = 'margin-bottom:12px; font-size:0.85rem; color:var(--text-secondary);';
                document.getElementById('attachment-field').after(info);
            }
            const info = document.getElementById('existing-attachment');
            info.replaceChildren();
            info.appendChild(document.createTextNode('Current attachments:'));

            const previewRow = document.createElement('div');
            previewRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;';

            attachments.forEach((attachment) => {
                const safeUrl = app.getSafeAttachmentUrl(attachment && attachment.url);
                if (!safeUrl) return;

                let media;
                if (attachment.type && attachment.type.startsWith('video/')) {
                    media = document.createElement('video');
                    media.controls = true;
                    media.src = safeUrl;
                } else {
                    media = document.createElement('img');
                    media.src = safeUrl;
                    media.alt = 'Current attachment';
                }

                media.style.cssText = 'max-width:200px; max-height:120px; border-radius:4px; vertical-align:middle;';
                previewRow.appendChild(media);
            });

            if (previewRow.childElementCount > 0) {
                info.appendChild(previewRow);
            }
        } else if (existingAttach) {
            existingAttach.remove();
        }

        app.adminEditFlag = adminEdit;

        document.getElementById('create-post-form').style.display = 'block';
    },

    exportAllToMd: async () => {
        if (!confirm("Export all posts to .md files?\n(Files will be saved in the server's exports folder.)")) return;

        try {
            const json = await app.fetchJson(`${API_URL}/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            app.showToast(`Export Complete! ${json.message}`, 'success', 5000);
            app.setAdminMenuStatus(`Export complete: ${json.message}`, 'success');
        } catch (err) {
            app.setAdminMenuStatus(err.message || 'Export failed.', 'error');
            console.error(err);
        }
    },

    // --- Modal Helpers ---

    requestPassword: (title, msg) => {
        return new Promise((resolve) => {
            const modal = document.getElementById('password-modal');
            document.getElementById('password-modal-title').innerText = title || "Password Required";
            document.getElementById('password-modal-msg').innerText = msg || "";
            document.getElementById('password-modal-input').value = '';
            modal.style.display = 'flex';
            document.getElementById('password-modal-input').focus();

            app.passwordResolver = resolve;
        });
    },

    resolvePasswordPromise: () => {
        const password = document.getElementById('password-modal-input').value;
        if (!password) { app.showToast("Password is required.", 'error'); return; }
        
        document.getElementById('password-modal').style.display = 'none';
        if (app.passwordResolver) {
            app.passwordResolver(password);
            app.passwordResolver = null;
        }
    },

    rejectPasswordPromise: () => {
        document.getElementById('password-modal').style.display = 'none';
        if (app.passwordResolver) {
            app.passwordResolver(null);
            app.passwordResolver = null;
        }
    }
};

// Start
app.init();
