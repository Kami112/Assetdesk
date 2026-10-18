# AssetDesk

AssetDesk is an IT asset and software license inventory for small and mid-size IT teams. It tracks which device is with which employee, which warranties and licenses are running out, and what the hardware is worth today. Every change goes into an activity log.

**Live demo:** https://assetdesk-dvy0.onrender.com (sign in with one of the demo accounts on the login page. The data is fictional and resets every 6 hours.)

## Features

- **Dashboard**
  - Active assets and fleet book value
  - Warranties ending soon and devices due for refresh
  - Monthly hardware spend
  - A "needs attention" list: over-allocated licenses, unused paid seats, renewals
- **Assets**
  - Search, filter, sort and bulk actions (change status, move location, print labels, export, delete)
  - Check-out and check-in with notes
  - Full history of each asset, with before → after values for every field
  - Straight-line depreciation and an end-of-life date per asset
- **Employees and offboarding**
  - See everything a person holds
  - Offboard someone in one step: return their assets to stock, mark unreturned ones lost, and release their license seats, all in one transaction
- **Software licenses**
  - Seat tracking with over-allocation protection and renewal dates
  - Cost per seat
  - License keys are hidden from viewers
- **Excel / CSV import**
  - Upload your existing spreadsheet. AssetDesk recognises everyday column names such as "S/N", "Owner", "Site" or "Price (SAR)".
  - Understands dates like `15/03/2025`, `Jan 5, 2023` and Excel date cells, and amounts like `SAR 1,299.50`.
  - Recognises words like "notebook", "switch" or "spare".
  - Matches existing assets by tag or serial number.
  - Shows a row-by-row preview with errors before anything is saved.
- **Export** to Excel or CSV. Exported files can be edited and imported back. CSV exports are protected against spreadsheet formula injection.
- **QR labels:** print sheets of asset labels. Scanning one with a phone camera opens that asset.
- **Roles**
  - **Viewer:** read-only, cannot see license keys
  - **Editor:** add, edit, import, check-out and check-in
  - **Admin:** everything editors can do, plus delete, users, settings and backups
- **Activity log:** every change, who made it and when. Entries can't be edited.
- **One-click backup** of the whole database.
- Works on phones and supports dark mode.

## Security

- Passwords are hashed with bcrypt (cost 12).
- Sessions are random tokens in `HttpOnly` cookies. The database stores only a hash of each token.
- Sign-in attempts are rate-limited.
- Requests that change data must carry a custom header, which blocks cross-site request forgery (CSRF).
- A strict Content Security Policy and other security headers are set (via Helmet).
- Every database query is parameterised.
- Every permission check runs on the server, not just in the browser.
- There must always be at least one active admin.
- Changing or resetting a password signs that user out on all devices.

## Tech

Node.js 22, Express, and SQLite through Node's built-in `node:sqlite` module, so there is no separate database server to run. The frontend is plain JavaScript modules with no build step. The data lives in a single file, `data/assetdesk.db`, which is easy to back up.

## Run locally

```bash
npm install
npm run demo      # sample data in memory, open http://localhost:3000
npm test          # 24 API and unit tests
```

To run with real (persistent) data:

```bash
ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='a long password' npm start
```

The first admin is created from those variables on first start. Later you can add users from **Admin → Users**, or run `npm run create-admin -- you@company.com "Your Name"`.

## Deploy for your company

### Option A: Render (managed)

1. Create a **Web Service** from this repo: runtime Node, build `npm ci --omit=dev`, start `npm start`.
2. Choose a paid instance type (Starter or above) and add a **persistent disk** mounted at `/var/data`. The free plan has no disk, so data would be lost on every restart.
3. Set these environment variables:
   - `DATA_DIR=/var/data`
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 10 characters)
   - `PUBLIC_URL` (your site's URL, used in QR codes)
   - `NODE_VERSION=22`
4. After the first sign-in, you can remove `ADMIN_PASSWORD`.

### Option B: your own server (Docker)

```bash
docker build -t assetdesk .
docker run -d --name assetdesk -p 3000:3000 -v assetdesk-data:/data \
  -e ADMIN_EMAIL=it@company.com -e ADMIN_PASSWORD='a long password' \
  -e PUBLIC_URL=https://assets.company.local assetdesk
```

Put it behind your usual HTTPS reverse proxy (IIS, nginx or similar). Back up the `assetdesk-data` volume, or use **Admin → Download backup**.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `DATA_DIR` | Folder for `assetdesk.db` (default `./data`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Creates the first admin when there are no users yet |
| `PUBLIC_URL` | Base URL encoded in QR labels |
| `DEMO_MODE=true` | In-memory sample data, demo logins, and admin changes disabled |

## License

MIT
