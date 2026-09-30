# Creative Analytics Dashboard

A browser dashboard for reviewing AppLovin and Google Ads creative performance, comparing formats, and viewing VALIA-generated video labels.

## Project structure

| File | Purpose |
|---|---|
| `index.html` | Page markup, security policy, OAuth client ID, and Apps Script URLs |
| `styles.css` | Dashboard, responsive, modal, and card styling |
| `app.js` | Authentication, API calls, IndexedDB cache, filtering, charts, admin tools, and VALIA UI |
| `Thumbnail.png` | Shared thumbnail for playable creatives |

The Apps Script backend and Google Ads/VALIA sync scripts are deployed separately and are not included in the current folder.

## How it works

- Google Sign-In authenticates users against the backend allowlist.
- One `fetch_all` request returns AppLovin and Google Ads daily creative data.
- The latest 90-day snapshot is stored in IndexedDB; date presets are calculated locally.
- Chart.js renders format distribution and the spend leaderboard.
- Admins can manage access and start a background AppLovin sync; viewers are read-only.
- VALIA uses its own Apps Script endpoint and sheet.

## Local development

Run from this directory:

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. Add this origin to the OAuth client's authorized JavaScript origins. After replacing `Thumbnail.png`, update `ASSET_VERSION` in `index.html`.

## Configuration

Edit the configuration blocks near the bottom of `index.html`:

- `CONFIG.API_URL` — main Apps Script `/exec` URL
- `CONFIG.GOOGLE_CLIENT_ID` — OAuth web client ID
- `CONFIG.DEFAULT_VIEW_DAYS` — initial date preset
- `CONFIG.EXTENDED_DAYS` — snapshot window; currently 90 days
- `VALIA_CONFIG.API_URL` — VALIA Apps Script `/exec` URL

Keep credentials and API secrets in Apps Script Properties—never in frontend files.

## Apps Script setup

1. Create or open the spreadsheet-bound Apps Script project and add the backend source.
2. Set the `GOOGLE_CLIENT_ID` Script Property to the same client ID used in `index.html`.
3. Enable the Google Sheets advanced service if the backend uses it.
4. Prepare the required data/access tabs, then deploy as a Web App and copy its `/exec` URL into `CONFIG.API_URL`.
5. Run `installDashboardTriggers()` once to install the AppLovin, snapshot, correction, and archive schedules.
6. Run `rebuildDashboardSnapshotNow()` once to publish the initial 90-day snapshot.
7. Configure the separate Google Ads and VALIA projects, then place the VALIA deployment URL in `VALIA_CONFIG.API_URL`.
8. After backend changes, deploy a new Web App version; after frontend changes, republish the static files.
