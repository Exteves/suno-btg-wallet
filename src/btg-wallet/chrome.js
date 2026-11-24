// Temporary Chrome (throwaway profile, incognito window on the BTG login) with
// Playwright attached over a local CDP port only to LISTEN to responses.
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createManualLogin, localCdpEndpoint } from '../cdp.js';
import { manualChromeArgs } from '../manual-browser.js';
import { AppError } from '../errors.js';

export const LOGIN_URL = 'https://app.btgpactual.com/login';

export async function openTemporaryChrome({ port = 9223, browserPath = 'google-chrome' } = {}) {
  const endpoint = localCdpEndpoint(`http://127.0.0.1:${port}`);
  const profile = await mkdtemp(join(tmpdir(), 'btg-carteira-'));
  await chmod(profile, 0o700);
  const child = spawn(browserPath, manualChromeArgs(profile, port), { stdio: 'ignore', shell: false });
  let exited = false;
  const closed = new Promise(resolve => {
    child.once('error', () => { exited = true; resolve(); });
    child.once('close', () => { exited = true; resolve(); });
  });
  const close = async () => {
    if (!exited) {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (!exited) { child.kill('SIGKILL'); await closed; }
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      if (exited) throw new AppError('CDP_CONNECTION_FAILED');
      try { await createManualLogin(endpoint, LOGIN_URL); break; }
      catch { if (Date.now() > deadline) throw new AppError('CDP_CONNECTION_FAILED'); await new Promise(r => setTimeout(r, 250)); }
    }
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 10000, noDefaults: true });
    return { browser, closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// Calls listener(page) for every page that exists now or opens later.
export function eachPage(browser, listener) {
  for (const context of browser.contexts()) {
    context.pages().forEach(listener);
    context.on('page', listener);
  }
}
