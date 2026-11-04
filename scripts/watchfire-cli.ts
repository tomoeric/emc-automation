/**
 * Standalone CLI for the Watchfire Ignite automation, meant to run on GitHub
 * Actions (where Playwright + Chromium work cleanly). Authenticates by session
 * cookie (preferred) or email/password, then runs a task.
 *
 *   TASK=inspect WATCHFIRE_COOKIE="..." npx tsx scripts/watchfire-cli.ts
 *
 * Screenshots + HTML are written to ./out (uploaded as a CI artifact);
 * structure + the UI's own XHR traffic are printed to the run log.
 */
import fs from 'node:fs';
import { IgniteSession } from '../src/ignite.js';

const TASK = process.env.TASK || 'inspect';
const cookie = process.env.WATCHFIRE_COOKIE || '';
const email = process.env.WATCHFIRE_EMAIL || '';
const password = process.env.WATCHFIRE_PASSWORD || '';

fs.mkdirSync('out', { recursive: true });
const log = (...a: unknown[]) => console.log(...a);

async function cap(s: IgniteSession, name: string): Promise<void> {
  await s.saveScreenshot(`out/${name}.png`);
  const snap = await s.snapshot();
  const clickable = await s.clickable();
  log(`\n=== ${name} === url=${snap.url}`);
  log('CLICKABLE:', JSON.stringify(clickable.slice(0, 80)));
}

async function main(): Promise<void> {
  const s = new IgniteSession();

  let login;
  if (cookie) {
    log('Auth: session cookie');
    login = await s.loginWithCookies(cookie);
  } else if (email && password) {
    log('Auth: email/password');
    login = await s.login(email, password);
  } else {
    console.error('No credentials: set WATCHFIRE_COOKIE (preferred) or WATCHFIRE_EMAIL/PASSWORD.');
    process.exit(1);
    return;
  }

  if (!login.ok) {
    log('LOGIN FAILED:', login.reason);
    await s.saveScreenshot('out/login-fail.png');
    await s.close();
    process.exit(1);
    return;
  }
  log('LOGIN OK');

  if (TASK === 'inspect') {
    await cap(s, '01-home');
    await s.click('Schedules');
    await cap(s, '02-schedules');
    for (const label of ['Playlists', 'Playlist', 'View All', 'View all', 'Programs']) {
      const r = await s.click(label);
      if (r.ok) {
        await cap(s, `03-${label.replace(/\s+/g, '_')}`);
        break;
      }
    }
    log('\n=== XHR (the UI\'s own requests) ===');
    log(JSON.stringify(s.getXhr().slice(0, 150), null, 1));
    const html = await s.html();
    fs.writeFileSync('out/last.html', html);
    log(`\nHTML saved: out/last.html (${html.length} bytes)`);
  } else {
    log(`Unknown TASK "${TASK}". Only "inspect" is implemented so far.`);
  }

  await s.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
