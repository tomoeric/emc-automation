import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { IgniteSession } from './ignite.js';
import { runAgent } from './agent.js';
import type Anthropic from '@anthropic-ai/sdk';

declare module 'express-session' {
  interface SessionData {
    user?: string;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

// One live Ignite browser session per app session, kept in memory.
const igniteSessions = new Map<string, IgniteSession>();
// AI chat history per app session (in memory).
const chatHistories = new Map<string, Anthropic.MessageParam[]>();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  }),
);

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (req.session.user) return next();
  res.status(401).json({ ok: false, reason: 'Not signed in to the app.' });
}

function getIgnite(req: express.Request): IgniteSession {
  const id = req.sessionID;
  let s = igniteSessions.get(id);
  if (!s) {
    s = new IgniteSession();
    igniteSessions.set(id, s);
  }
  return s;
}

// ── App login gate ───────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const emailOk = safeEqual(email, config.allowedEmail);
  const passOk = safeEqual(password, config.appPassword);
  if (emailOk && passOk) {
    req.session.user = email;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, reason: 'Invalid email or password.' });
});

app.post('/api/logout', async (req, res) => {
  const s = igniteSessions.get(req.sessionID);
  if (s) {
    await s.close();
    igniteSessions.delete(req.sessionID);
  }
  chatHistories.delete(req.sessionID);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({
    ok: true,
    user: req.session.user ?? null,
    aiEnabled: !!config.anthropicKey,
    wfEnvAvailable: !!(config.watchfireEmail && config.watchfirePassword),
  });
});

// ── Ignite actions (all require app auth) ────────────────────────────
app.post('/api/ignite/login', requireAuth, async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!email || !password) {
    return res.status(400).json({ ok: false, reason: 'Watchfire email and password are required.' });
  }
  const s = getIgnite(req);
  try {
    res.json(await s.login(email, password));
  } catch (e: any) {
    res.status(500).json({ ok: false, reason: `Ignite login failed: ${e?.message ?? e}` });
  }
});

app.post('/api/ignite/connect-env', requireAuth, async (req, res) => {
  if (!config.watchfireEmail || !config.watchfirePassword) {
    return res.status(400).json({ ok: false, reason: 'WATCHFIRE_EMAIL / WATCHFIRE_PASSWORD are not set as secrets.' });
  }
  const s = getIgnite(req);
  try {
    res.json(await s.login(config.watchfireEmail, config.watchfirePassword));
  } catch (e: any) {
    res.status(500).json({ ok: false, reason: `Ignite login failed: ${e?.message ?? e}` });
  }
});

app.post('/api/ignite/domains', requireAuth, async (req, res) => {
  const s = getIgnite(req);
  if (!s.ready) return res.status(409).json({ ok: false, reason: 'Log in to Watchfire first.' });
  res.json({ ok: true, domains: await s.listDomains() });
});

app.post('/api/ignite/switch', requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ ok: false, reason: 'Domain name required.' });
  const s = getIgnite(req);
  if (!s.ready) return res.status(409).json({ ok: false, reason: 'Log in to Watchfire first.' });
  res.json(await s.switchDomain(name));
});

app.post('/api/ignite/network', requireAuth, async (req, res) => {
  const s = getIgnite(req);
  if (!s.ready) return res.status(409).json({ ok: false, reason: 'Log in to Watchfire first.' });
  res.json(await s.getNetworkStatus());
});

app.post('/api/ignite/snapshot', requireAuth, async (req, res) => {
  const s = getIgnite(req);
  if (!s.ready) return res.status(409).json({ ok: false, reason: 'Log in to Watchfire first.' });
  res.json(await s.snapshot());
});

app.post('/api/ignite/close', requireAuth, async (req, res) => {
  const s = igniteSessions.get(req.sessionID);
  if (s) {
    await s.close();
    igniteSessions.delete(req.sessionID);
  }
  chatHistories.delete(req.sessionID);
  res.json({ ok: true });
});

// ── AI chat: natural-language commands over the Ignite session ─────────
app.post('/api/ignite/chat', requireAuth, async (req, res) => {
  const s = igniteSessions.get(req.sessionID);
  if (!s || !s.ready) return res.status(409).json({ ok: false, reason: 'Connect to Watchfire first.' });
  const message = String(req.body?.message ?? '').trim();
  if (!message) return res.status(400).json({ ok: false, reason: 'Message required.' });
  try {
    const hist = chatHistories.get(req.sessionID) ?? [];
    const { reply, history } = await runAgent(s, message, hist);
    chatHistories.set(req.sessionID, history);
    res.json({ ok: true, reply });
  } catch (e: any) {
    res.status(500).json({ ok: false, reason: e?.message ?? String(e) });
  }
});

// ── Static frontend ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, req.session.user ? 'app.html' : 'login.html'));
});
app.use(express.static(publicDir));

app.listen(config.port, '0.0.0.0', () => {
  console.log(`EMC automation running on http://localhost:${config.port}`);
  console.log(`Approved app login: ${config.allowedEmail}`);
});
