import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env (local) or set it as an environment secret.`,
    );
  }
  return v;
}

export const config = {
  // The app's own login gate — the only approved account.
  allowedEmail: (process.env.APP_ALLOWED_EMAIL ?? 'eric.s@mojocarwash.com')
    .trim()
    .toLowerCase(),
  appPassword: required('APP_PASSWORD'),
  sessionSecret: required('SESSION_SECRET', 'dev-insecure-secret'),

  port: Number(process.env.PORT ?? 3000),
  headless: (process.env.HEADLESS ?? 'true').toLowerCase() !== 'false',
  chromiumPath: process.env.CHROMIUM_PATH || undefined,

  // Optional — only needed for the AI chat layer.
  anthropicKey: process.env.ANTHROPIC_API_KEY || undefined,

  // Watchfire Ignite entry points (observed, stable).
  ignite: {
    loginUrl:
      'https://login.watchfireignite.com/account/sso-login.html?service=' +
      encodeURIComponent('https://op.watchfireignite.com/manager/'),
    managerUrl: 'https://op.watchfireignite.com/manager/',
  },
} as const;
