import { execSync } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';

/**
 * Resolve a Chromium binary. Prefer an explicit CHROMIUM_PATH, then a system
 * Chromium on PATH (e.g. the Nix-provided one on Replit, which ships its own
 * shared libraries). Returns undefined to fall back to Playwright's bundled
 * browser.
 */
function resolveChromium(): string | undefined {
  if (config.chromiumPath) return config.chromiumPath;
  for (const cmd of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
    try {
      const out = execSync(`command -v ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (out) return out;
    } catch {
      /* not found, try next */
    }
  }
  return undefined;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: string; needsCode?: boolean; screenshot?: string };

export type ActionResult = {
  ok: boolean;
  reason?: string;
  url: string;
  text?: string;
  screenshot?: string;
};

/**
 * Drives a single Watchfire Ignite OPx session with a headless browser.
 * Credentials are passed in at login time and never persisted to disk.
 *
 * Ignite is a GWT app: the login is email-first (enter email -> CONTINUE ->
 * enter password -> submit). Selectors are intentionally tolerant because GWT
 * renders generic class names and reuses containers between steps.
 */
export class IgniteSession {
  private browser?: Browser;
  private ctx?: BrowserContext;
  private page?: Page;
  private closed = false;

  get ready(): boolean {
    return !!this.page && !this.closed;
  }

  private async ensureStarted(): Promise<Page> {
    if (this.page && !this.closed) return this.page;
    this.browser = await chromium.launch({
      headless: config.headless,
      executablePath: resolveChromium(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.ctx = await this.browser.newContext({
      viewport: { width: 1400, height: 950 },
    });
    this.page = await this.ctx.newPage();
    this.closed = false;
    return this.page;
  }

  private async shot(): Promise<string> {
    if (!this.page) return '';
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 70 });
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  /** Is the manager app (post-login) on screen? */
  private async atManager(): Promise<boolean> {
    if (!this.page) return false;
    if (/\/manager\//.test(this.page.url())) {
      // The shell nav has Content / Schedules / Network.
      const nav = await this.page
        .locator('text=/^(Content|Schedules|Network)$/')
        .count()
        .catch(() => 0);
      if (nav > 0) return true;
    }
    return false;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    let page: Page;
    try {
      page = await this.ensureStarted();
      await page.goto(config.ignite.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Step 1 — email. GWT text box.
      const emailBox = page.locator('input.gwt-TextBox, input[type="text"]').first();
      await emailBox.waitFor({ state: 'visible', timeout: 30000 });
      await emailBox.fill(email);

      // CONTINUE.
      await this.clickByText(['CONTINUE', 'Continue', 'Next']);

      // Step 2 — password. Wait for a password field to appear.
      const pwBox = page.locator('input[type="password"]').first();
      try {
        await pwBox.waitFor({ state: 'visible', timeout: 20000 });
      } catch {
        // No password field appeared — surface what's on screen.
        const txt = await this.bodyText();
        if (/code|verification|one[- ]?time|authenticat/i.test(txt)) {
          return {
            ok: false,
            reason:
              'Login asked for a verification code (MFA) instead of a password. ' +
              'Unattended login is blocked until MFA handling is added.',
            needsCode: true,
            screenshot: await this.shot(),
          };
        }
        if (/no account|not found|invalid|incorrect|unrecogni/i.test(txt)) {
          return { ok: false, reason: `Email rejected: "${txt.slice(0, 160)}"`, screenshot: await this.shot() };
        }
        return {
          ok: false,
          reason: 'Password field never appeared after CONTINUE.',
          screenshot: await this.shot(),
        };
      }

      await pwBox.fill(password);
      await this.clickByText(['CONTINUE', 'Continue', 'LOGIN', 'Log In', 'Login', 'Sign In', 'Submit']);

      // Step 3 — wait for the manager app, or an error.
      const ok = await this.waitForManagerOrError();
      if (ok === true) return { ok: true };
      return { ok: false, reason: ok, screenshot: await this.shot() };
    } catch (e: any) {
      return { ok: false, reason: `Login error: ${e?.message ?? e}`, screenshot: await this.shot() };
    }
  }

  private async waitForManagerOrError(): Promise<true | string> {
    const page = this.page!;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (await this.atManager()) return true;
      const txt = await this.bodyText();
      if (/incorrect|invalid|wrong password|try again|locked/i.test(txt)) {
        return `Login rejected: "${txt.slice(0, 160)}"`;
      }
      if (/code|verification|one[- ]?time/i.test(txt) && !/password/i.test(txt)) {
        return 'Login asked for a verification code (MFA). MFA handling not yet implemented.';
      }
      await page.waitForTimeout(1000);
    }
    return 'Timed out waiting for the manager to load after submitting the password.';
  }

  /** Click the first button/anchor whose text matches one of the labels. */
  private async clickByText(labels: string[]): Promise<void> {
    const page = this.page!;
    for (const label of labels) {
      const el = page
        .locator(`button:has-text("${label}"), a:has-text("${label}"), .gwt-Button:has-text("${label}")`)
        .first();
      if ((await el.count()) > 0) {
        await el.click({ timeout: 5000 }).catch(() => {});
        return;
      }
    }
    // Fallback: press Enter in the focused field.
    await page.keyboard.press('Enter').catch(() => {});
  }

  private async bodyText(): Promise<string> {
    if (!this.page) return '';
    return (await this.page.innerText('body').catch(() => '')) || '';
  }

  /** Read the list of domains available in the account switcher. */
  async listDomains(): Promise<string[]> {
    const page = this.page;
    if (!page) return [];
    // The domain panel lists "Switch to Domain" with the available domains.
    const items = await page
      .locator('text=/Mammoth Holdings|Mojo Car Wash|Silverstar Car Wash/')
      .allInnerTexts()
      .catch(() => []);
    return Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)));
  }

  /** Switch the active domain by its visible name. */
  async switchDomain(name: string): Promise<ActionResult> {
    const page = this.page;
    if (!page) return { ok: false, reason: 'Not logged in', url: '' };
    try {
      const item = page.locator(`text="${name}"`).first();
      await item.waitFor({ state: 'visible', timeout: 10000 });
      await item.click();
      await page.waitForTimeout(2500);
      return { ok: true, url: page.url(), text: (await this.bodyText()).slice(0, 400) };
    } catch (e: any) {
      return { ok: false, reason: `Could not switch to "${name}": ${e?.message ?? e}`, url: page.url(), screenshot: await this.shot() };
    }
  }

  /**
   * Navigate to the Network view and capture sign status.
   * The exact row structure needs a live session to finalize; for now this
   * lands on Network and returns the on-screen text + a screenshot so the
   * parser can be tuned against real data.
   */
  async getNetworkStatus(): Promise<ActionResult> {
    const page = this.page;
    if (!page) return { ok: false, reason: 'Not logged in', url: '' };
    try {
      await this.clickByText(['Network']);
      await page.waitForTimeout(3000);
      return {
        ok: true,
        url: page.url(),
        text: (await this.bodyText()).slice(0, 4000),
        screenshot: await this.shot(),
      };
    } catch (e: any) {
      return { ok: false, reason: `${e?.message ?? e}`, url: page.url(), screenshot: await this.shot() };
    }
  }

  /**
   * Click a link, button, or menu item by its visible text, then return the
   * resulting screen. Tolerant: tries link/button roles first, then any text.
   */
  async click(text: string): Promise<ActionResult> {
    const page = this.page;
    if (!page) return { ok: false, reason: 'Not logged in', url: '' };
    try {
      let target = page.getByRole('link', { name: text }).first();
      if ((await target.count()) === 0) target = page.getByRole('button', { name: text }).first();
      if ((await target.count()) === 0) target = page.getByText(text, { exact: false }).first();
      await target.waitFor({ state: 'visible', timeout: 8000 });
      await target.click({ timeout: 8000 });
      await page.waitForTimeout(2500);
      return {
        ok: true,
        url: page.url(),
        text: (await this.bodyText()).slice(0, 3000),
        screenshot: await this.shot(),
      };
    } catch (e: any) {
      return {
        ok: false,
        reason: `Could not click "${text}": ${e?.message ?? e}`,
        url: page.url(),
        screenshot: await this.shot(),
      };
    }
  }

  /** Generic: capture the current screen (text + screenshot) for inspection. */
  async snapshot(): Promise<ActionResult> {
    const page = this.page;
    if (!page) return { ok: false, reason: 'Not logged in', url: '' };
    return {
      ok: true,
      url: page.url(),
      text: (await this.bodyText()).slice(0, 4000),
      screenshot: await this.shot(),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.ctx = undefined;
    this.page = undefined;
  }
}
