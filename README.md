# CrossPoint Controller (Playdate Web Hub)

Browser-based companion hub for managing **CrossPoint Reader** on the Panic Playdate over **Live USB Serial** (`navigator.serial`) or **USB Data Disk** (`window.showDirectoryPicker`).

## Live Web App

- **Hosted on GitHub Pages**: [`https://www.aviraldg.com/crosspoint-controller/`](https://www.aviraldg.com/crosspoint-controller/)
- **Single-file bundle**: [`https://www.aviraldg.com/crosspoint-controller/playdate_web_hub.html`](https://www.aviraldg.com/crosspoint-controller/playdate_web_hub.html)

## Features

- **Zero hardcoded upstream assets**: `scripts/build.mjs` pulls `web.css`, `crosspoint-icon.svg`, `jszip.min.js`, and `plugin-host.js` directly from [`aviraldg/crosspoint-reader`](https://github.com/aviraldg/crosspoint-reader) at build time.
- **Live USB Serial Mode (`!CP` / `@CP` Bridge)**:
  - Connects directly to a Playdate running CrossPoint Reader at 115200 baud.
  - Fast `WCHUNK` chunked file transfers with 16 KB RAM write buffering on-device, idempotent chunk retries, and live transfer speed/progress logs.
  - Automatic HTTP/HTTPS relay fallback (`!CP RELAY`) through Playdate Wi-Fi when remote endpoints omit browser CORS headers.
- **USB Data Disk Mode**:
  - Connects to a mounted `PLAYDATE` drive (or `Data/` folder) via the File System Access API (`window.showDirectoryPicker`).
- **Full CrossPoint Web Plugin Compatibility**:
  - Runs unmodified CrossPoint web plugins (`pluginhub`, `readest`, `wikipedia`, etc.) via an in-browser virtual `/api/*` router.

## Development

```bash
# Install dev dependencies (ESLint, Prettier)
npm install

# Build dist/index.html & dist/playdate_web_hub.html
# (reads upstream assets from ../crosspoint-reader, $CROSSPOINT_READER_DIR, or .cache/crosspoint-reader)
npm run build

# Lint and check formatting
npm run lint
npm run format:check

# Run unit tests with enforced V8 code coverage thresholds (>=90% lines/functions, >=75% branches)
npm run test:coverage

# Run automated headless Chrome E2E test suite (file://, http://, and /crosspoint-controller/ subpath)
npm run test:e2e

# Run full verification suite (lint + format:check + coverage + E2E)
npm run check
```
