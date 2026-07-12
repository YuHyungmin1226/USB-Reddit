# USB-Reddit

Portable Reddit-style community board for local or LAN use.

## Features

- Portable Node.js runtime support through `bin/`
- Local SQLite database stored in `data/reddit.db`
- Markdown posts and comments
- Image and video attachments
- Markdown export to the `exports/` folder from the admin menu
- App login, in-app password changes, simple post/subreddit passwords, and admin controls

## Requirements

- Node.js 18 or newer if you run through `npm`
- A valid `config.json`

The repository also includes launcher scripts and bundled runtimes for portable use.

## Setup

1. Copy `config.example.json` to `config.json`.
2. Set strong `access.password` and `admin.password` values in `config.json`.
3. If you want other devices on the LAN to connect, set `"server": { "exposeLan": true }`.
4. Start the app with one of the options below.

## Run

### npm

```bash
npm start
```

### Windows launcher

Run:

```bat
start.bat
```

### macOS launcher

Run:

```bash
./start_mac.command
```

After startup, open `http://localhost:3000`.

LAN exposure is disabled by default for safety. The server only listens on `127.0.0.1` unless `config.server.exposeLan` is explicitly set to `true`.

## Security Notes

- The app requires login before posts, comments, votes, API data, or files under `/uploads/` can be viewed.
- `access` credentials are for entering the app; `admin` credentials also unlock admin actions.
- Admin users can use the Admin Menu to change the app login password, change the admin password, and export posts to Markdown.
- If `access` is omitted from `config.json`, the app falls back to the admin credentials for login.
- Subreddit names are restricted to 1-32 characters using letters, numbers, underscores, and hyphens.
- Reserved subreddits such as `general` cannot be deleted.
- SVG uploads are blocked.
- Uploaded files are checked against expected file signatures for supported image/video types.
- Uploads are stored in `data/uploads/`.
- Uploads are limited to 4 files per post; there is no per-file size limit or total `data/uploads/` quota.
- Rejected post uploads are cleaned up so they do not remain in `data/uploads/`.
- Uploads are served with `X-Content-Type-Options: nosniff`.
- LAN exposure requires an explicit opt-in through `config.server.exposeLan`.

## Project Layout

```text
USB-Reddit/
|-- public/
|   |-- app.js
|   |-- index.html
|   `-- style.css
|-- server/
|   `-- server.js
|-- data/
|   |-- reddit.db
|   `-- uploads/
|-- exports/
|-- bin/
|-- config.example.json
|-- config.json
|-- package.json
|-- start.bat
`-- start_mac.command
```

## Notes

- Runtime data and uploaded files live under `data/`; this folder is intentionally excluded from Git.
- Existing files in the old `public/uploads/` location are migrated to `data/uploads/` on server startup.
- If a legacy upload has the same filename as an existing `data/uploads/` file, the existing data file is kept and the legacy file is left for manual review.
- If you move or back up the app by copying the project folder, keep `config.json` and `data/` together.
- If you use Git to move code to another machine, transfer `config.json` and `data/` separately.
- Copy `exports/` as well if you want to preserve generated Markdown exports.
- This repository does not include an automated test suite at the moment.

## License

MIT
