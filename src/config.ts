import 'dotenv/config';

export const config = {
  // The app's own login gate — the only approved account.
  allowedEmail: (process.env.APP_ALLOWED_EMAIL ?? 'eric.s@mojocarwash.com')
    .trim()
    .toLowerCase(),
  // Read lazily; the web server validates appPassword at startup. The CLI
  // doesn't need it, so importing config must not throw here.
  appPassword: process.env.APP_PASSWORD ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-insecure-secret',

  port: Number(process.env.PORT ?? 3000),
  headless: (process.env.HEADLESS ?? 'true').toLowerCase() !== 'false',
  chromiumPath: process.env.CHROMIUM_PATH || undefined,

  // Optional — only needed for the AI chat layer.
  anthropicKey: process.env.ANTHROPIC_API_KEY || undefined,

  // Optional — Watchfire Ignite credentials for one-click / unattended connect.
  // If unset, credentials are entered in the app at runtime instead.
  watchfireEmail: process.env.WATCHFIRE_EMAIL || undefined,
  watchfirePassword: process.env.WATCHFIRE_PASSWORD || undefined,

  // Watchfire Ignite entry points (observed, stable).
  ignite: {
    loginUrl:
      'https://login.watchfireignite.com/account/sso-login.html?service=' +
      encodeURIComponent('https://op.watchfireignite.com/manager/'),
    managerUrl: 'https://op.watchfireignite.com/manager/',
  },
} as const;
