# USB-Reddit
A portable Reddit clone that runs directly from a USB drive or portable storage. Designed for immediate execution on macOS and Windows without additional setup.

## Key Features
- **Fully Portable**: No need to install Node.js on the system. Uses built-in binaries in the `bin/` folder.
- **Easy Execution**: Simply run `start.bat` on Windows or `start_mac.command` on macOS.
- **Local Database**: Uses SQLite to keep all posts and data safe in the `data/` folder.
- **Offline Friendly**: Once libraries are set up, it runs without an internet connection.

## How to Run

### Windows
1. Copy this folder to your desired location (e.g., USB drive).
2. Run `start.bat`.
3. Open `http://localhost:3000` in your browser.

### macOS
1. Copy this folder to your desired location.
2. Double-click `start_mac.command`.
3. Open `http://localhost:3000` in your browser.

## Project Structure
- `public/`: Frontend HTML, CSS, and JavaScript files.
- `server/`: Node.js server logic and dependency check scripts.
- `bin/`: Portable Node.js binaries.
- `data/`: SQLite database storage (created on first run).
- `exports/`: Destination for exported Markdown files.

## Notes
- Deleting the `data/` folder will reset all post data.
- Internet connection may be required on the very first run to install libraries if they are missing.
