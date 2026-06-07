const API_URL = '/api';

const app = {
    currentSub: 'general',
    currentPostId: null,
    user: 'Guest',
    isAdmin: false,
    adminPassword: null,
    passwordResolver: null,
    currentPage: 1,
    totalPages: 1,
    adminEditFlag: false,

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

    init: async () => {
        app.isAdmin = localStorage.getItem('isAdmin') === 'true';
        app.updateAdminUI();
        await app.loadSubreddits();
        app.loadPosts();
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
        const subNameSpan = document.getElementById('create-post-sub-name');
        if (subNameSpan) {
            document.getElementById('form-title').innerHTML = `Create Post in r/<span id="create-post-sub-name">${app.currentSub}</span>`;
        } else {
            document.getElementById('form-title').innerText = `Create Post in r/${app.currentSub}`;
        }
        document.getElementById('edit-post-id').value = '';
        document.getElementById('post-title').value = '';
        document.getElementById('post-content').value = '';
        document.getElementById('post-author').disabled = false;
        document.getElementById('post-password').value = '';
        document.getElementById('attachment-field').style.display = 'block';
        document.getElementById('post-submit-btn').innerText = "Post";
        
        // Auto fill author if known
        if (app.user !== 'Guest') {
            document.getElementById('post-author').value = app.user;
        }
        // Reset editor tabs
        const editTab = document.getElementById('edit-tab');
        const previewTab = document.getElementById('preview-tab');
        if (editTab && previewTab) app.switchEditorTab('edit');
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
            if (json.success) {
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
                app.showToast("Login failed: " + (json.error || "Invalid credentials"), 'error');
            }
        } catch (err) {
            app.showToast("Error during login", 'error');
        }
    },

    logout: () => {
        app.isAdmin = false;
        localStorage.removeItem('isAdmin');
        app.updateAdminUI();
        
        // Re-render current post to hide admin buttons
        if (app.currentPostId) {
            app.viewPost(app.currentPostId);
        }
        
            app.showToast("Logged out.", 'info');
    },

    updateAdminUI: () => {
        const exportBtn = document.getElementById('export-btn');
        const loginBtn = document.getElementById('login-btn');
        const logoutBtn = document.getElementById('logout-btn');
        const adminBadge = document.getElementById('admin-badge');

        if (app.isAdmin) {
            exportBtn.style.display = 'inline-block';
            logoutBtn.style.display = 'inline-block';
            loginBtn.style.display = 'none';
            adminBadge.style.display = 'inline-block';
        } else {
            exportBtn.style.display = 'none';
            logoutBtn.style.display = 'none';
            loginBtn.style.display = 'inline-block';
            adminBadge.style.display = 'none';
        }
    },

    // --- API Calls ---

    loadSubreddits: async () => {
        try {
            const res = await fetch(`${API_URL}/subreddits`);
            const json = await res.json();
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
            const res = await fetch(`${API_URL}/subreddits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description: desc, password })
            });
            if (res.ok) {
                app.closeCreateSubModal();
                app.loadSubreddits();
                app.switchSub(name);
            } else {
                app.showToast("Failed to create subreddit. Name might be taken.", 'error');
            }
        } catch (err) {
            app.showToast("Error creating subreddit", 'error');
        }
    },

    vote: async (targetType, targetId, value) => {
        try {
            const res = await fetch(`${API_URL}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_type: targetType, target_id: targetId, value })
            });
            const json = await res.json();
            if (json.success) {
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
                    <h2>r/${subreddit}</h2>
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
            const res = await fetch(`${API_URL}/r/${subreddit}?page=${app.currentPage}&limit=20`);
            const json = await res.json();

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
                        <span class="subreddit-tag">r/${displaySub}</span> • Posted by ${post.author} • ${date}
                    </div>
                    <h2 class="post-title">${post.title}</h2>
                    <div class="post-actions">
                        <span class="vote-btn" onclick="event.stopPropagation(); app.vote('post', ${post.id}, 1)" title="Upvote">⬆</span>
                        <span class="vote-count" id="vote-count-${post.id}">${post.upvotes}</span>
                        <span class="vote-btn" onclick="event.stopPropagation(); app.vote('post', ${post.id}, -1)" title="Downvote">⬇</span>
                        <span>${post.comment_count ?? 0} comments</span>
                    </div>
                `;
                list.appendChild(card);
            });

            if (app.currentPage < app.totalPages) {
                const loadMore = document.createElement('div');
                loadMore.id = 'load-more-btn';
                loadMore.style.cssText = 'text-align:center; padding:20px;';
                loadMore.innerHTML = `<button class="primary-btn" onclick="app.loadPosts('${subreddit}', true)">Load More</button>`;
                list.appendChild(loadMore);
            }

            app.currentPage++;

            app.restoreVoteHighlights();
        } catch (err) {
            if (!loadMore) {
                list.innerHTML = '<div style="color:red; text-align:center;">Failed to load posts. Is server running?</div>';
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
            const res = await fetch(`${API_URL}/subreddits`);
            const json = await res.json();
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
        
        if (!password) {
            password = await app.requestPassword("Password Required", "Set a password to manage (edit/delete) this post later:");
            if (!password) return;
            document.getElementById('post-password').value = password;
        }

        if (editId) {
            // Update Existing Post
            try {
                const body = app.adminEditFlag
                    ? { title, content, password, adminPassword: app.adminPassword }
                    : { title, content, password };
                app.adminEditFlag = false;
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
            const formData = new FormData();
            formData.append('title', title);
            formData.append('content', content);
            formData.append('author', author);
            formData.append('password', password);

            if (fileInput.files.length > 0) {
                formData.append('attachment', fileInput.files[0]);
            }

            try {
                const res = await fetch(`${API_URL}/r/${app.currentSub}`, {
                    method: 'POST',
                    body: formData
                });

                if (res.ok) {
                    app.resetPostForm();
                    app.goHome(); // Hide form and refresh list
                } else {
                    const json = await res.json();
                    app.showToast("Failed to post: " + (json.error || "Unknown error"), 'error');
                }
            } catch (err) {
                app.showToast("Error posting.", 'error');
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
            const res = await fetch(`${API_URL}/posts/${id}`);
            const json = await res.json();

            if (json.error) {
                contentDiv.innerHTML = 'Post not found.';
                return;
            }

            const p = json.post;
            const date = new Date(p.created_at.replace(' ', 'T') + 'Z').toLocaleString();

            contentDiv.innerHTML = `
                <div class="post-meta">r/${app.currentSub} • Posted by ${p.author} on ${date}</div>
                <h1 style="color:white; margin: 10px 0;">${p.title}</h1>
                <div style="font-size: 1.1rem; line-height: 1.6; margin-bottom: 20px;">
                    ${app.parseMarkdown(p.content)}
                </div>
                <div class="post-actions">
                    <span class="vote-btn" onclick="app.vote('post', ${p.id}, 1)" title="Upvote">⬆</span>
                    <span class="vote-count" id="vote-count-${p.id}">${p.upvotes}</span>
                    <span class="vote-btn" onclick="app.vote('post', ${p.id}, -1)" title="Downvote">⬇</span>
                    <span style="flex-grow:1"></span>
                    <button onclick="app.editPost(${JSON.stringify(p).replace(/"/g, '&quot;')})" class="management-btn edit-btn">Edit</button>
                    <button onclick="app.deletePost(${p.id})" class="management-btn delete-btn">Delete</button>
                </div>
            `;

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

                div.innerHTML = `
                    <div class="meta" style="display: flex; align-items: center; flex-wrap: wrap;">
                        <span>${c.author} • ${new Date(c.created_at.replace(' ', 'T') + 'Z').toLocaleTimeString()}</span>
                        ${deleteBtn}
                        <button onclick="app.replyTo(${c.id}, '${c.author.replace(/'/g, "\\'")}')" style="background:transparent; border:none; color:var(--accent-color); cursor:pointer; font-size:0.8rem; margin-left:12px;">Reply</button>
                    </div>
                    <div style="margin-top: 8px;">${app.parseMarkdown(c.content)}</div>
                `;
                commentsDiv.appendChild(div);

                c.children.forEach(child => renderComment(child, depth + 1));
            };

            commentsDiv.innerHTML = '';
            roots.forEach(c => renderComment(c));

        } catch (err) {
            console.error(err);
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
            await fetch(`${API_URL}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    post_id: app.currentPostId,
                    parent_id: app.replyTarget,
                    content,
                    author
                })
            });
            app.cancelReply();
            document.getElementById('comment-content').value = '';
            app.viewPost(app.currentPostId); // Reload
        } catch (err) {
            app.showToast("Failed to comment", 'error');
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
        renderer.image = (href, title, text) => {
            if (text === 'video' || href.match(/\.(mp4|webm|ogg)$/i)) {
                return `<video controls src="${href}" style="max-width:100%; border-radius:4px; margin-top:10px;"></video>`;
            }
            return originalImage(href, title, text);
        };

        // Parse with marked
        let html = marked.parse(text, { renderer });

        // YouTube Link Parser (Post-processing)
        html = html.replace(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w\-]+)/g, 
            '<div class="video-container"><iframe src="https://www.youtube.com/embed/$1" frameborder="0" allowfullscreen></iframe></div>');

        return html;
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
        document.getElementById('post-content').value = post.content;
        document.getElementById('post-author').value = post.author;
        document.getElementById('post-author').disabled = true;
        document.getElementById('post-password').value = password || '';
        document.getElementById('attachment-field').style.display = 'none';
        document.getElementById('post-submit-btn').innerText = "Update Post";

        // Store admin edit flag for submitPost to use
        app.adminEditFlag = adminEdit;

        document.getElementById('create-post-form').style.display = 'block';
    },

    exportAllToMd: async () => {
        if (!confirm("Export all posts to .md files?\n(Files will be saved in the server's exports folder.)")) return;

        try {
            const res = await fetch(`${API_URL}/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminPassword: app.adminPassword })
            });
            const json = await res.json();
            
            if (res.ok) {
                app.showToast(`Export Complete! ${json.message}`, 'success', 5000);
            } else {
                app.showToast("Export Failed: " + (json.error || "Unknown error"), 'error');
            }
        } catch (err) {
            app.showToast("Server Connection Error", 'error');
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
