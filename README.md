# EMC Automation

A small web app that logs into **Watchfire Ignite OPx** and performs actions on
your electronic message center (EMC) signs. It drives Ignite with a headless
browser (Ignite has no public API on this account), behind its own single-user
login gate.

## How it works

1. **App login gate** — only one account may use the app:
   `eric.s@mojocarwash.com`, with a password you set as a secret.
2. **Connect to Ignite** — once signed in, you enter your Watchfire Ignite
   email + password in the app. They are sent to the server, used to drive the
   browser session, and held **in memory only** — never written to disk, never
   committed, never logged.
3. **Actions** — switch domain (Mammoth Holdings / Mojo Car Wash /
   Silverstar Car Wash), read Network status, snapshot the screen. More actions
   plug into `src/ignite.ts`.

## Setup

```bash
npm install
cp .env.example .env     # then edit .env
npm start                # http://localhost:3000
```

### Required secrets / env vars

| Variable            | What it is                                        |
|---------------------|---------------------------------------------------|
| `APP_ALLOWED_EMAIL` | The only approved app login. Defaults to `eric.s@mojocarwash.com`. |
| `APP_PASSWORD`      | Password for that account. **Set this yourself — it is not in the repo.** |
| `SESSION_SECRET`    | Random string for signing session cookies.        |
| `PORT`              | Default `3000`.                                   |
| `HEADLESS`          | `true` (default) or `false` to watch the browser. |
| `CHROMIUM_PATH`     | Optional path to Chromium if autodetect fails.    |
| `ANTHROPIC_API_KEY` | Optional. Enables the AI chat panel. Get it at console.anthropic.com. |

**Set `APP_PASSWORD` (and `SESSION_SECRET`) as real secrets** — in your host's
environment/secret settings for production, or in a local `.env` (git-ignored)
for development. Never commit real values. Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Watchfire Ignite credentials are **not** stored here — they are entered in the
app at runtime.

## Deployment notes

- Needs Node 20+ and a Chromium that Playwright can launch
  (`npx playwright install chromium` on a fresh host).
- The Ignite session lives in server memory per app-session; restarting the
  server drops any open Ignite browser.

## Status

- ✅ App login gate (single approved user)
- ✅ Ignite login flow (email-first GWT form) with MFA / error detection
- ✅ Domain switch, Network view, screen snapshot
- ✅ **AI chat** — plain-English commands over the session (needs `ANTHROPIC_API_KEY`); Claude reads the Network screenshot to answer status questions
- 🔜 Network status **parsing** (per-sign online/offline) is captured as
  text + screenshot for now; the row parser is finalized against a live
  session. Downstream: feed status into `ninja-live-status`.
