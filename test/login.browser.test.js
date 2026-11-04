import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { contextOptions, collectionContext } from '../src/browser.js';
import { installReadOnlyGuard } from '../src/policy.js';
import { loginPageState } from '../src/login-diagnostics.js';

test('login page can wait for its service worker, then session transfers into a guarded worker-free collection context', { timeout: 30000 }, async () => {
  const config = await loadConfig('btg.config.json');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const auth = await browser.newContext(contextOptions(config, 'authentication'));
    await auth.route('**/*', route => {
      if (new URL(route.request().url()).pathname === config.entryPath) {
        return route.fulfill({ status: 403, body: 'Catalog requires authenticated navigation' });
      }
      if (new URL(route.request().url()).pathname === '/service-worker.js') {
        return route.fulfill({ contentType: 'application/javascript', body: "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));" });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><main><p id="loading">Carregando</p><form hidden><label>Usuário<input name="user"></label></form></main><script>
        navigator.serviceWorker.register('/service-worker.js').then(()=>navigator.serviceWorker.ready).then(()=>{
          document.querySelector('form').hidden=false;
          document.querySelector('form').setAttribute('data-login-ready','true');
          document.querySelector('#loading').remove();
        });</script>` });
    });
    const page = await auth.newPage();
    await page.goto(`${config.baseUrl}${config.loginPath}`);
    await page.locator('[data-login-ready]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('input').fill('SYNTHETIC-PRIVATE-INPUT');
    const pageState = await loginPageState(page);
    assert.equal(pageState.top_level_visible_inputs, 1);
    assert.ok(!JSON.stringify(pageState).includes('SYNTHETIC-PRIVATE-INPUT'));
    await page.evaluate(() => {
      localStorage.setItem('access_token', 'SYNTHETIC-LOCAL-TOKEN');
      sessionStorage.setItem('session_token', 'SYNTHETIC-SESSION-TOKEN');
    });
    const next = await collectionContext(browser, auth, page, config);
    assert.equal(next.context.serviceWorkers().length, 0);
    let writes = 0;
    let blocked = 0;
    await next.context.route('**/*', route => {
      if (route.request().method() === 'POST') writes++;
      return route.fulfill({ contentType: 'text/html', body: '<main>Produtos de teste</main>' });
    });
    await installReadOnlyGuard(next.context, config, () => { blocked++; });
    await next.page.goto(`${config.baseUrl}/produtos-de-investimento`);
    assert.equal(await next.page.evaluate(() => localStorage.getItem('access_token')), 'SYNTHETIC-LOCAL-TOKEN');
    assert.equal(await next.page.evaluate(() => sessionStorage.getItem('session_token')), 'SYNTHETIC-SESSION-TOKEN');
    await next.page.evaluate(() => fetch('/produtos-de-investimento/ordens', { method: 'POST' }).catch(() => {}));
    assert.equal(writes, 0);
    assert.equal(blocked, 1);
  } finally { await browser?.close(); }
});
