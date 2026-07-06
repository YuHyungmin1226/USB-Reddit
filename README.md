# USB-Reddit

Portable Reddit-style community board for local or LAN use.

## Features

- Portable Node.js runtime support through `bin/`
- Local SQLite database stored in `data/reddit.db`
- Markdown posts and comments
- Image and video attachments
- Markdown export to the `exports/` folder
- Simple post/subreddit passwords plus admin controls

## Requirements

- Node.js 18 or newer if you run through `npm`
- A valid `config.json`

The repository also includes launcher scripts and bundled runtimes for portable use.

## Setup

1. Copy `config.example.json` to `config.json`.
2. Set a strong admin password in `config.json`.
3. Start the app with one of the options below.

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

## Security Notes

- Subreddit names are restricted to 1-32 characters using letters, numbers, underscores, and hyphens.
- Reserved subreddits such as `general` cannot be deleted.
- SVG uploads are blocked.
- Rejected post uploads are cleaned up so they do not remain in `public/uploads`.
- Uploads are served with `X-Content-Type-Options: nosniff`.

## Project Layout

```text
USB-Reddit/
|-- public/
|   |-- app.js
|   |-- index.html
|   |-- style.css
|   `-- uploads/
|-- server/
|   `-- server.js
|-- data/
|-- exports/
|-- bin/
|-- config.example.json
|-- config.json
|-- package.json
|-- start.bat
`-- start_mac.command
```

## Notes

- Runtime data lives in `data/` and uploaded files live in `public/uploads/`.
- If you move or back up the app, copy those folders as well.
- This repository does not include an automated test suite at the moment.

## License

MIT
