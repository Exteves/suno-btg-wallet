import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../src/database.js';
import { collect } from '../src/crawler.js';
import { loadConfig } from '../src/config.js';
import { SessionVault, filterSessionState } from '../src/session-vault.js';
import { confirmAuthentication } from '../src/auth.js';

const defaults = await loadConfig('suno.config.json');

test('encrypted session restores cookies and auth storage into a new Playwright context', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suno-browser-session-'));
  const keys = new Map();
  const keyring = {
    async get(id) { return Buffer.from(keys.get(id)); },
    async set(id, key) { keys.set(id, Buffer.from(key)); },
    async delete(id) { keys.delete(id); },
  };
  const path = join(directory, 'session.enc.json');
  const vault = new SessionVault(path, keyring);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const respond = route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: (route.request().headers().cookie || '').includes('suno_session=SYNTHETIC-SESSION')
        ? html('Meu portfólio', '<p data-authenticated>Dados carregados</p>')
        : html('Login', '<input type="password"><p>Faça login para continuar</p>'),
    });
    const first = await browser.newContext({ serviceWorkers: 'block' });
    await first.route('**/*', respond);
    await first.addCookies([{ name: 'suno_session', value: 'SYNTHETIC-SESSION', domain: 'investidor.suno.com.br', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const firstPage = await first.newPage();
    await firstPage.goto(`${defaults.baseUrl}/portfolio`);
    await firstPage.evaluate(() => localStorage.setItem('access_token', 'SYNTHETIC-AUTH-TOKEN'));
    await vault.save(filterSessionState(await first.storageState(), defaults));
    await first.close();

    const loaded = await new SessionVault(path, keyring).load();
    const second = await browser.newContext({ storageState: loaded.state, serviceWorkers: 'block' });
    await second.route('**/*', respond);
    const secondPage = await second.newPage();
    await secondPage.goto(`${defaults.baseUrl}/portfolio`);
    assert.equal(await secondPage.evaluate(() => localStorage.getItem('access_token')), 'SYNTHETIC-AUTH-TOKEN');
    assert.equal(await confirmAuthentication(secondPage, { ...defaults, settleMs: 20, authenticatedSelector: '[data-authenticated]' }, async () => {
      throw new Error('Restored authentication should not require a new login.');
    }), 'confirmed-by-selector');
    await vault.forget();
    assert.equal(keys.size, 0);
    await second.close();
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function html(title, content, script = '') {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title></head><body><nav><a href="/portfolio">Portfólio</a><a href="/carteiras">Carteiras</a></nav><main><h1>${title}</h1>${content}</main><script>${script}</script></body></html>`;
}

test('real Playwright browser: wallets, pagination, tabs, lazy rendering, privacy and blocked mutations', { timeout: 60000 }, async () => {
  let writes = 0;
  const respond = async route => {
    const url = new URL(route.request().url());
    const send = body => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    if (route.request().method() === 'POST') { writes++; await send('bad'); return; }
    if (url.pathname === '/portfolio') {
      await send(html('Meu portfólio', `<form><input type="hidden" value="SECRET-INPUT"><input value="USER-SECRET"></form><p data-private>Conta 98765-4</p><p>CPF: 123.456.789-00</p><table><tr><th>Ticker</th><th>Quantidade</th></tr><tr><td>USER3</td><td>10</td></tr></table><script type="application/json">{"token":"SECRET-STATE"}</script>`));
    } else if (url.pathname === '/carteiras') {
      await send(html('Carteiras recomendadas', '<article><a href="/carteiras/dividendos">Dividendos</a></article><a href="/carteiras/dividendos">Duplicada</a><a href="/carteiras/crescimento">Crescimento</a><a href="/portfolio/editar">Editar</a><a href="https://other.test/carteiras/x">Externa</a>'));
    } else if (url.pathname === '/carteiras/dividendos') {
      const second = url.searchParams.get('page') === '2';
      await send(html('Carteira recomendada Dividendos', `<table><caption>Ativos</caption><tr><th>Ticker</th><th>Peso</th></tr><tr><td>${second ? 'DIVD4' : 'DIVD3'}</td><td>${second ? '40,00%' : '60,00%'}</td></tr></table>${second ? '' : '<a data-next href="/carteiras/dividendos?page=2">Próxima</a>'}`));
    } else if (url.pathname === '/carteiras/crescimento') {
      await send(html('Carteira recomendada Crescimento', `<button type="button" role="tab" aria-selected="false" data-tab>Histórico</button><table><tr><th>Ticker</th><th>Peso</th></tr><tr><td>GROW3</td><td>75%</td></tr></table><div style="height:1400px"></div><div id="lazy"></div>`, `
        document.querySelector('[data-tab]').onclick = e => { e.target.setAttribute('aria-selected','true'); document.querySelector('table').innerHTML='<tr><th>Ticker</th><th>Peso</th></tr><tr><td>HIST3</td><td>50%</td></tr>'; };
        let loaded=false;
        addEventListener('scroll', () => { if(!loaded && scrollY > 100){loaded=true; setTimeout(()=>{document.querySelector('#lazy').innerHTML='<article>LAZY3: 25%</article>';},20);} });
        setTimeout(() => fetch('/api/modify', {method:'POST',body:'do-not-send'}).catch(()=>{}),100);
      `));
    } else { await route.fulfill({ status: 404, body: 'Not found' }); }
  };
  const baseUrl = 'http://suno-fixture.test';
  const store = new Store(':memory:');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 600 } });
    await context.route('**/*', respond);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/portfolio`);
    const config = { ...defaults, baseUrl, layoutVerified: true, settleMs: 30, nextSelector: '[data-next]',
      views: [{ name: 'history', selector: '[data-tab]', kind: 'tab', pathPrefix: '/carteiras/crescimento' }],
      recordMappings: [{ name: 'ticker', columns: { identifier: 'Ticker', weight: 'Peso', quantity: 'Quantidade' } }],
    };
    const result = await collect({ page, config, store, purpose: 'rebalance' });
    assert.equal(result.pagesFailed, 0);
    assert.equal(result.status, 'partial'); // Blocked mutation is explicitly reported.
    assert.ok(result.blockedRequests >= 1);
    assert.equal(writes, 0);
    const records = store.db.prepare('SELECT * FROM collected_records').all();
    for (const id of ['USER3', 'DIVD3', 'DIVD4', 'GROW3', 'HIST3']) assert.ok(records.some(r => r.identifier === id), id);
    assert.equal(records.find(r => r.identifier === 'USER3').ownership, 'user_positions');
    assert.equal(records.find(r => r.identifier === 'DIVD3').ownership, 'suno_recommendation');
    const text = store.db.prepare('SELECT visible_text FROM snapshots').all().map(r => r.visible_text).join('\n');
    assert.ok(text.includes('LAZY3'));
    for (const secret of ['123.456.789-00', '98765-4', 'SECRET-INPUT', 'USER-SECRET', 'SECRET-STATE']) assert.ok(!text.includes(secret), secret);
    const pages = store.db.prepare('SELECT source_url FROM pages').all();
    assert.equal(pages.filter(r => r.source_url === `${baseUrl}/carteiras/dividendos`).length, 1);
    assert.ok(!pages.some(r => r.source_url.includes('editar') || r.source_url.includes('other.test')));
    assert.ok(store.db.prepare("SELECT count(*) n FROM snapshots WHERE view_name='history'").get().n > 0);
  } finally {
    await browser?.close();
    store.close();
  }
});

test('authentication expiry fails visibly and does not save a login page as portfolio data', { timeout: 30000 }, async () => {
  const baseUrl = 'http://suno-fixture.test';
  const store = new Store(':memory:');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html('Login', '<input type="password"><p>Faça login para continuar</p>') }));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/portfolio`);
    const result = await collect({ page, config: { ...defaults, baseUrl, settleMs: 20 }, store, purpose: 'start' });
    assert.equal(result.status, 'failed');
    assert.equal(store.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
    assert.ok(store.db.prepare("SELECT count(*) n FROM issues WHERE code='LOGIN_REQUIRED'").get().n > 0);
  } finally {
    await browser?.close(); store.close();
  }
});
