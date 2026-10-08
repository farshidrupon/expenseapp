# Personal Expense Tracker — GitHub Pages + Private Google Drive/Sheets

A production-oriented static personal expense tracker using:

- GitHub Pages for hosting
- HTML5 + CSS3 + Vanilla JavaScript ES6+
- Google Identity Services for Google sign-in
- Google Drive API for the private application folder/file
- Google Sheets API for the financial database
- No React, Vue, Angular, Node.js requirement, or build step
- No financial-record localStorage database

## Important architecture

Google Sheets is the authoritative database. The browser keeps the current records only in runtime memory for rendering and temporary recovery. Browser persistence is limited to the UI theme preference and a non-financial database pointer (the Google Spreadsheet ID) in `localStorage`; no expense records or OAuth access tokens are stored there.

The application requests these OAuth scopes:

- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/spreadsheets`

A Google client secret is never required or shipped to the browser.

## 1. Create the Google Cloud project

1. Open Google Cloud Console.
2. Create or select a project for this application.
3. Enable:
   - Google Drive API
   - Google Sheets API
4. Configure the OAuth consent screen.
5. Create an OAuth 2.0 Client ID of type **Web application**.
6. Add the exact GitHub Pages origin as an authorized JavaScript origin, for example:
   - `https://YOUR-USERNAME.github.io`
   - or your custom GitHub Pages domain if you use one.
7. During local testing you may also add `http://localhost` or your chosen local development origin.
8. Copy the client ID only. Do not create or expose a client secret for this browser application.

## 2. Configure the application

Open `config.js` and replace:

```js
CLIENT_ID: 'YOUR_GOOGLE_OAUTH_WEB_CLIENT_ID.apps.googleusercontent.com'
```

with your real Web application OAuth Client ID.

Do not add a client secret.

## 3. Database behavior

On first successful Google authorization, the app:

1. Finds the `Personal Expense Tracker` folder in the user's Drive.
2. Creates it if it does not exist.
3. Finds `Expense_Tracker_DB` in that folder.
4. Creates it if it does not exist.
5. Creates/repairs the required sheets:
   - `Expenses`
   - `Settings`
   - `Audit Log`
6. Loads all valid expense records into runtime memory.

The `Expenses` columns are:

`ID | Date | Expense Category | Amount | Created At | Updated At`

The row number is never used as the permanent record ID.

## 4. Google OAuth behavior

The app uses Google Identity Services in two parts:

- Sign in with Google for the current Google account identity.
- OAuth access token client for Drive/Sheets API access.

The access token is stored only in JavaScript memory and is never written to localStorage or sessionStorage. After a page refresh, the app first attempts silent OAuth re-authorization using the existing Google session/consent. A manual Reconnect is required only when Google no longer permits silent authorization (for example, revoked permission or a changed Google session).

## 5. Deploy to GitHub Pages

1. Create a GitHub repository.
2. Upload:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `config.js`
   - `.nojekyll`
3. Commit and push.
4. In GitHub, open **Settings → Pages**.
5. Select the branch/folder used by the site.
6. Wait for GitHub Pages to publish.
7. Add the published HTTPS origin to Google Cloud's OAuth authorized JavaScript origins.
8. Reload the site and sign in.

There is no build command.

## 6. Local testing

Because OAuth origin validation is strict, use a local HTTP server rather than opening `index.html` directly with `file://`.

Any simple static HTTP server is sufficient. Node.js is not required by the application itself.

## 7. Database recovery and duplicates

The app does not create a new spreadsheet on every login. It first reuses the previously verified spreadsheet ID when available, then searches for the existing application folder/database, and creates them only when no existing application database can be found. The app also has a fallback search for an existing application-created spreadsheet with the configured database name.

For the strongest operational guarantee, keep the folder and database name unchanged.

## 8. Financial data persistence

Financial records are not stored as a permanent local browser database. Refreshing or changing devices reloads the authoritative data from the Google Sheet. After a previous successful authorization, the app attempts to restore the OAuth session silently, so the user normally does not have to click Sign in again. If silent authorization is unavailable, the app clearly asks the user to reconnect rather than pretending the session is active.

The app may keep expense records temporarily in JavaScript memory during the current session. Offline mode clearly reports that Google synchronization is unavailable and does not claim that writes were saved.

## 9. Export and printing

The Settings utility provides:

- Export Backup JSON
- Export CSV
- Sync Now
- Reconnect
- Sign Out

The summary views contain print-friendly CSS. Use the browser's Print / Save as PDF workflow.

## 10. Security notes

- Keep the Google Sheet private.
- Do not use `Anyone with the link` sharing.
- Do not publish a client secret.
- Do not put a refresh token in frontend source code.
- Revoke OAuth access from the Google Account security page if you ever stop trusting the deployed application.

## 11. Production validation checklist

Before calling the deployment production-ready, test using a real Google test account:

- Google sign-in
- First-run folder/database creation
- Existing database reuse
- Record creation
- Record editing
- Record deletion
- Undo deletion
- Multiple expenses on the same date
- Monthly category summary
- Yearly summary and monthly trend
- Lifetime summary
- Refresh persistence with silent OAuth restoration
- Login from a second device
- Expired/revoked authorization handling
- Network interruption handling
- Google API errors and quota responses
- Mobile layout
- Desktop layout
- Print/PDF
- JSON/CSV exports

## Notes on Google API scopes

`drive.file` is intentionally used instead of full Drive access. It allows the application to create/manage the application's files without requesting unrestricted access to the user's entire Drive. The Sheets scope is required for reading and writing the spreadsheet cell data.

## Files

- `index.html` — application shell and UI
- `styles.css` — responsive/futuristic UI + print CSS
- `app.js` — authentication, Drive/Sheets integration, CRUD, summaries, charts, exports, error handling
- `config.js` — deploy-time public OAuth configuration
- `.nojekyll` — prevents GitHub Pages Jekyll processing


## Authentication behavior

Google OAuth access tokens are kept in memory only. After the first authorization, subsequent visits attempt silent token restoration. Expense operations never trigger an interactive login automatically; use Reconnect when Google requires user interaction.

## Final responsive UX improvements

The latest UI pass is mobile-first and keeps the four required main tabs only:

- Desktop uses a wide dashboard with compact top navigation and category summary tables.
- Mobile uses a fixed four-item bottom navigation with compact labels and safe-area spacing.
- On screens up to 760 CSS pixels, expense/category/monthly tables reflow into readable vertical cards with field labels; the page does not require left-right scrolling to read a record.
- The expense list keeps exactly three data columns: Date, Expense Category, and Amount. Editing/deleting is available through row interaction and the edit dialog, not an Actions column.
- Touch-screen users can tap an expense to edit it; desktop users can double-click or use keyboard controls.
- The edit dialog exposes a delete action that always opens a confirmation dialog.
- The month comparison strip compares the selected month with the previous calendar month and clearly identifies increases/decreases; it derives only from spreadsheet-loaded records.
- If an append response times out after Google has accepted a write, a retry checks the stable expense ID before appending again, reducing accidental duplicate transactions.
- Interactive Google authorization can supersede a pending silent restore; first-time visitors do not run the returning-session silent restore unless a prior spreadsheet pointer exists.
- Settings shows the last successful data load time and includes an Open Google Sheet shortcut.
- Dialogs respect mobile safe areas, controls have larger touch targets, reduced-motion preferences are honored, and summary tables revert to conventional tables for print.
- The date editor preserves an existing transaction's date while editing it.

## Final deployment reminder

Upload `index.html`, `styles.css`, `app.js`, `config.js`, `.nojekyll`, and this README together to keep the final UI and JavaScript version aligned. After GitHub Pages publishes, use a hard refresh (`Ctrl+Shift+R` on desktop) or clear the site's cached files on a mobile browser if an older stylesheet appears. Confirm the exact deployed HTTPS origin is listed in Google Cloud's Authorized JavaScript origins.

The project has been statically validated (JavaScript syntax and key DOM bindings). A real end-to-end Google OAuth / Drive / Sheets test still requires opening the deployed site with the configured Google Cloud project and account; local code checks cannot confirm remote consent-screen settings, quotas, or network policies.

## UX and API references consulted

- Google Identity Services token model: https://developers.google.com/identity/oauth2/web/guides/use-token-model
- Google Drive file search and appProperties: https://developers.google.com/workspace/drive/api/guides/search-files and https://developers.google.com/workspace/drive/api/guides/properties
- Google Drive file creation: https://developers.google.com/workspace/drive/api/guides/create-file
- Responsive table and accessibility considerations: https://www.accessible-data-interfaces.com/accessible-data-tables-grid-systems/responsive-data-tables/
