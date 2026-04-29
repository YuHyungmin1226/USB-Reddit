const API_URL = '/api';

const app = {
    currentSub: 'general',
    currentPostId: null,
    user: 'Guest',
    isAdmin: false,

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

    toggleCreateForm: () => {
        const form = document.getElementById('create-post-form');
        if (form.style.display === 'block') {
            form.style.display = 'none';
        } else {
            // Reset form if it was in edit mode
            document.getElementById('form-title').innerText = `Create Post in r/${app.currentSub}`;
            document.getElementById('edit-post-id').value = '';
            document.getElementById('post-title').value = '';
            document.getElementById('post-content').value = '';
            document.getElementById('post-author').disabled = false;
            document.getElementById('post-password').value = '';
            document.getElementById('attachment-field').style.display = 'block';
            document.getElementById('post-submit-btn').innerText = "Post";

            form.style.display = 'block';
            document.getElementById('create-post-sub-name').innerText = app.currentSub;
            // Auto fill author if known
            if (app.user !== 'Guest') {
                document.getElementById('post-author').value = app.user;
            }
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

        if (!username || !password) return alert("Please enter both username and password.");

        try {
            const res = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const json = await res.json();
            if (json.success) {
                app.isAdmin = true;
                localStorage.setItem('isAdmin', 'true');
                app.updateAdminUI();
                app.closeLoginModal();
                alert("Logged in as admin.");
            } else {
                alert("Login failed: " + (json.error || "Invalid credentials"));
            }
        } catch (err) {
            alert("Error during login");
        }
    },

    logout: () => {
        app.isAdmin = false;
        localStorage.removeItem('isAdmin');
        app.updateAdminUI();
        alert("Logged out.");
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
            // Keep 'All' or 'Random' logic if needed, for now just list subs
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
            addBtn.onclick = app.promptCreateSub;
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

    promptCreateSub: async () => {
        const name = prompt("New Subreddit Name (e.g. funny):");
        if (!name) return;
        const desc = prompt("Description:");
        const password = prompt("Set a management password:");
        if (!password) return alert("Password is required.");

        try {
            const res = await fetch(`${API_URL}/subreddits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description: desc, password })
            });
            if (res.ok) {
                app.loadSubreddits();
                app.switchSub(name);
            } else {
                alert("Failed to create subreddit. Name might be taken.");
            }
        } catch (err) {
            alert("Error creating subreddit");
        }
    },

    loadPosts: async (subreddit = app.currentSub) => {
        const list = document.getElementById('post-list');
        // Retrieve current sub ID for deletion logic? Using name for now, but delete requires ID.
        // We might need to store sub ID in app.currentSubId or fetch it.
        // For simplicity, let's fetch sub info or iterate subs to find ID.
        let currentSubId = null;
        if (subreddit !== 'all') {
            // Find ID from nav (hacky but works for small list) or fetch. 
            // Better: update loadSubreddits to store map, OR logic in server.
            // Let's rely on server looking up by name? No, delete needs ID.
            // Let's just find it from the DOM or cache.
        }

        let headerHtml = '';
        if (subreddit !== 'all') {
            // Add delete sub button to header (Except for default subs)
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
        }

        list.innerHTML = headerHtml + '<div style="text-align:center; padding:20px;">Loading...</div>';

        try {
            const res = await fetch(`${API_URL}/r/${subreddit}`);
            const json = await res.json();

            list.innerHTML = headerHtml; // Keep header

            // Store ID if available (server response for get posts doesn't give sub ID directly easily unless we change API)
            // But we know the sub name.
            // Let's Fetch /api/subreddits to find the ID corresponding to this name for deletion.
            // Optimization: do this only on delete click.

            if (!json.data || json.data.length === 0) {
                list.innerHTML += '<div style="text-align:center; padding:20px; color:#666;">No posts here yet. Be the first!</div>';
                return;
            }

            json.data.forEach(post => {
                const card = document.createElement('div');
                card.className = 'post-card';
                card.onclick = () => app.viewPost(post.id);

                const date = new Date(post.created_at.replace(' ', 'T') + 'Z').toLocaleDateString();

                card.innerHTML = `
                    <div class="post-meta">
                        <span class="subreddit-tag">r/${subreddit}</span> • Posted by ${post.author} • ${date}
                    </div>
                    <h2 class="post-title">${post.title}</h2>
                    <div class="post-actions">
                        <span>${post.upvotes} upvotes</span>
                        <span>0 comments</span>
                    </div>
                `;
                list.appendChild(card);
            });
        } catch (err) {
            list.innerHTML = '<div style="color:red; text-align:center;">Failed to load posts. Is server running?</div>';
        }
    },

    deleteCurrentSub: async () => {
        if (app.currentSub === 'general' || app.currentSub === 'random') {
            return alert("Cannot delete default subreddits.");
        }

        const password = prompt(`Enter password to delete r/${app.currentSub}:`);
        if (!password) return;

        if (!confirm(`Permanently delete r/${app.currentSub} and ALL its posts?`)) return;

        // Need ID. Fetch all subs to find it.
        try {
            const res = await fetch(`${API_URL}/subreddits`);
            const json = await res.json();
            const sub = json.data.find(s => s.name === app.currentSub);

            if (sub) {
                const delRes = await fetch(`${API_URL}/subreddits/${sub.id}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });

                if (delRes.ok) {
                    alert("Subreddit deleted.");
                    app.currentSub = 'general';
                    app.loadSubreddits();
                    app.goHome();
                } else {
                    const err = await delRes.json();
                    alert("Failed: " + (err.error || "Unknown"));
                }
            }
        } catch (e) {
            console.error(e);
            alert("Error deleting.");
        }
    },

    submitPost: async () => {
        const editId = document.getElementById('edit-post-id').value;
        const title = document.getElementById('post-title').value;
        const content = document.getElementById('post-content').value;
        const author = document.getElementById('post-author').value || 'Anonymous';
        const password = document.getElementById('post-password').value;
        
        if (!password) return alert("Password is required for post management.");

        if (editId) {
            // Update Existing Post
            try {
                const res = await fetch(`${API_URL}/posts/${editId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, content, password })
                });

                if (res.ok) {
                    alert("Post updated!");
                    app.toggleCreateForm(); // Close
                    app.viewPost(editId); // Refresh view
                } else {
                    const json = await res.json();
                    alert("Failed to update: " + (json.error || "Unknown error"));
                }
            } catch (err) {
                alert("Error updating post.");
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
                    document.getElementById('post-title').value = '';
                    document.getElementById('post-content').value = '';
                    app.toggleCreateForm();
                    app.loadPosts();
                } else {
                    alert("Failed to post.");
                }
            } catch (err) {
                alert("Error posting.");
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
                    <span class="vote-btn">⬆ ${p.upvotes}</span>
                    <span style="flex-grow:1"></span>
                    <button onclick="app.editPost(${JSON.stringify(p).replace(/"/g, '&quot;')})" class="management-btn edit-btn">Edit</button>
                    <button onclick="app.deletePost(${p.id})" class="management-btn delete-btn">Delete</button>
                </div>
            `;

            // Comments
            commentsDiv.innerHTML = '';
            json.comments.forEach(c => {
                const div = document.createElement('div');
                div.className = 'comment';
                div.innerHTML = `
                    <div class="meta">${c.author} • ${new Date(c.created_at.replace(' ', 'T') + 'Z').toLocaleTimeString()}</div>
                    <div>${app.parseMarkdown(c.content)}</div>
                `;
                commentsDiv.appendChild(div);
            });

        } catch (err) {
            console.error(err);
        }
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
                    content,
                    author
                })
            });
            document.getElementById('comment-content').value = '';
            app.viewPost(app.currentPostId); // Reload
        } catch (err) {
            alert("Failed to comment");
        }
    },

    parseMarkdown: (text) => {
        if (!text) return '';
        // Simple parser
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/!\[(.*?)\]\((.*?)\)/g, (match, alt, url) => {
                if (alt === 'video' || url.match(/\.(mp4|webm)$/i)) {
                    return `<video controls src="${url}" style="max-width:100%"></video>`;
                }
                return `<img src="${url}" alt="${alt}" style="max-width:100%">`;
            })
            // YouTube Link Parser
            .replace(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w\-]+)/g, '<div class="video-container"><iframe src="https://www.youtube.com/embed/$1" frameborder="0" allowfullscreen></iframe></div>')
            .replace(/\n/g, '<br>');
        return html;
    },

    deletePost: async (id) => {
        const password = prompt("Enter the password you set when creating this post:");
        if (!password) return;

        if (!confirm("Are you sure you want to delete this post?")) return;

        try {
            const res = await fetch(`${API_URL}/posts/${id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (res.ok) {
                alert("Post deleted.");
                app.goHome();
            } else {
                const json = await res.json();
                alert("Failed to delete: " + (json.error || "Unknown error"));
            }
        } catch (err) {
            alert("Error deleting post.");
            console.error(err);
        }
    },

    editPost: (post) => {
        // We need the password to open edit mode? Or just open it and check on submit.
        // User's request: "누르면 해당 글의 비밀번호를 물어봐서 진행하는 방식"
        const password = prompt("Enter post password to edit:");
        if (!password) return;

        // Populate form
        document.getElementById('form-title').innerText = "Edit Post";
        document.getElementById('edit-post-id').value = post.id;
        document.getElementById('post-title').value = post.title;
        document.getElementById('post-content').value = post.content;
        document.getElementById('post-author').value = post.author;
        document.getElementById('post-author').disabled = true; // Can't change author
        document.getElementById('post-password').value = password;
        document.getElementById('attachment-field').style.display = 'none'; // Can't change attachment for now
        document.getElementById('post-submit-btn').innerText = "Update Post";

        document.getElementById('create-post-form').style.display = 'block';
    },

    exportAllToMd: async () => {
        if (!confirm("모든 게시글을 .md 파일로 일괄 추출하시겠습니까?\n(서버의 exports 폴더에 저장됩니다.)")) return;

        try {
            const res = await fetch(`${API_URL}/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminPassword: 'admin123' }) // Hardcoded for now as per admin role
            });
            const json = await res.json();
            
            if (res.ok) {
                alert(`✅ 추출 완료!\n${json.message}\n저장 위치: ${json.path}`);
            } else {
                alert("❌ 추출 실패: " + (json.error || "알 수 없는 오류"));
            }
        } catch (err) {
            alert("❌ 서버 연결 오류");
            console.error(err);
        }
    }
};

// Start
app.init();
