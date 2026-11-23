import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { KnowledgeStore } from '../src/suno-kb/store.js';
import { ResponseRecorder, checkAuthenticated, collectSuno } from '../src/suno-kb/collector.js';
import { loadDailyConfig } from '../src/suno-kb/config.js';

// Synthetic site and gateway via Playwright interception: no Suno account or network.
const base = await loadDailyConfig('suno-daily.config.json');
const config = { ...base, settleQuietMs: 150, settleTimeoutMs: 4000, authTimeoutMs: 4000, navigationTimeoutMs: 8000,
  pagination: { ...base.pagination, delayMs: 200 } };
const GW = 'https://membros-api-gateway.suno.com.br/api/';
const cors = { 'access-control-allow-origin': 'https://investidor.suno.com.br', 'access-control-allow-headers': 'x-auth,content-type',
  'access-control-allow-credentials': 'true' };

const reportsPage = page => Array.from({ length: page < 3 ? 2 : 0 }, (_, i) => ({ id: page * 2 + i + 1, title: `Relatório ${page * 2 + i + 1}` }));

function gateway(url, authorized) {
  const u = new URL(url);
  const path = u.pathname.replace('/api/', '');
  if (!authorized) return { status: 401, body: { message: 'unauthorized' } };
  if (path === 'v1/user/me') return { status: 200, body: { email: 'pessoa@example.com' } };
  if (path === 'v2/reports/v2/list') return { status: 200, body: { data: reportsPage(Number(u.searchParams.get('page'))) } };
  if (path === 'v1/wallets/assets') {
    const wallet = u.searchParams.get('wallet');
    return { status: 200, body: { data: wallet === 'dividendos-2' ? [{ ticker: 'TAEE11', peso: '50%' }] : [{ ticker: 'PETR4', peso: '10%', precoTeto: 'R$ 40' }, { ticker: 'VALE3', peso: '5%' }] } };
  }
  if (path === 'v1/wallets/coverage-universe') {
    const page = Number(u.searchParams.get('page'));
    return { status: 200, body: { data: page <= 2 ? [{ ticker: `COV${page}3`, recomendacao: 'Compra' }] : [], total: 2 } };
  }
  if (path === 'v1/wallets/wallets-events') {
    // Mirrors the real API: pages past 1 repeat page 1, but limit is honoured.
    const all = Array.from({ length: 7 }, (_, i) => ({ id: `ev${i}`, title: `Evento ${i}` }));
    const limit = Number(u.searchParams.get('limit') || 3);
    const page = Math.min(Number(u.searchParams.get('page')), 1);
    return { status: 200, body: { count: all.length, list: all.slice(page * limit, page * limit + limit) } };
  }
  if (path === 'v2/search') return { status: 200, body: { report: { count: 1, list: [{ id: 99, title: 'Busca' }] }, news: { count: 1, list: [{ id: 'n1', title: 'Notícia' }] } } };
  if (path === 'v1/nossos-fundos') return { status: 200, body: { fundos: [{ id: 'f1', nome: 'Suno Fundo', ticker: 'SNFF11' }], cotacoes: [{ ticker: 'SNFF11', preco: 10 }] } };
  if (path === 'v1/wallets/getMyWallet') return { status: 200, body: { data: [{ ticker: 'MINHA3', quantidade: 100 }] } };
  return { status: 404, body: {} };
}

const pages = {
  '/carteiras': { calls: ['v1/user/me'], links: ['/carteiras/dividendos', '/carteiras/cobertura-suno', '/carteiras/dividendos/comprar'] },
  '/relatorios': { calls: ['v2/reports/v2/list?per_page=2&page=0', 'v1/wallets/getMyWallet', 'v2/search?per_page=12&page=0'] },
  '/carteiras/dividendos': { calls: ['v1/wallets/assets?wallet=dividendos-1', 'v1/wallets/wallets-events?wallet_id=w1&page=0'], tabs: { 'Carteira 2': 'v1/wallets/assets?wallet=dividendos-2', Comprar: 'v1/wallets/assets?wallet=compra' } },
  '/carteiras/cobertura-suno': { calls: ['v1/wallets/coverage-universe?page=1&limit=1'] },
  '/nossos-fundos': { calls: ['v1/nossos-fundos'] },
};

function html(spec) {
  const call = path => `fetch(${JSON.stringify(GW + path)}, { headers: { 'x-auth': localStorage.getItem('token') || '' } }).catch(() => {})`;
  const tabs = Object.entries(spec.tabs || {}).map(([label, path]) => `<button role="tab" aria-selected="false" data-path="${path}">${label}</button>`).join('');
  return `<!doctype html><title>Suno</title><main><h1>Página</h1>${tabs}${(spec.links || []).map(href => `<a href="${href}">${href}</a>`).join('')}
    <p>Contato pessoa@example.com</p></main><script>${(spec.calls || []).map(call).join(';')};
    document.querySelectorAll('[data-path]').forEach(tab => tab.addEventListener('click', () => {
      tab.setAttribute('aria-selected', 'true');
      fetch(${JSON.stringify(GW)} + tab.dataset.path, { headers: { 'x-auth': localStorage.getItem('token') || '' } }).catch(() => {});
    }));</script>`;
}

async function setup(browser, { authorized = true } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const log = [];
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    log.push(`${request.method()} ${url.hostname}${url.pathname}`);
    if (url.hostname === 'membros-api-gateway.suno.com.br') {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const auth = request.headers()['x-auth'] === 'SYNTHETIC';
      const result = gateway(request.url(), auth && authorized);
      return route.fulfill({ status: result.status, headers: cors, contentType: 'application/json', body: JSON.stringify(result.body) });
    }
    if (url.hostname === 'investidor.suno.com.br') {
      const spec = pages[url.pathname.replace(/\/+$/, '')];
      return spec ? route.fulfill({ contentType: 'text/html', body: html(spec) }) : route.fulfill({ status: 404, body: 'nf' });
    }
    return route.abort();
  });
  await context.addInitScript(() => { if (location.hostname === 'investidor.suno.com.br') localStorage.setItem('token', 'SYNTHETIC'); });
  const page = await context.newPage();
  // Pagination replay goes through the same synthetic gateway.
  const fetchPage = async url => {
    const result = gateway(url, authorized);
    return { status: () => result.status, json: async () => result.body };
  };
  return { context, page, log, fetchPage };
}

test('coleta diária grava relatórios, carteiras, cobertura e fundos sem áreas pessoais', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const store = new KnowledgeStore(':memory:');
    const { context, page, log, fetchPage } = await setup(browser);
    const recorder = new ResponseRecorder({ store });
    recorder.attach(page);
    assert.equal(await checkAuthenticated(page, recorder, config), true);
    store.start('manual');
    const result = await collectSuno({ context, page, config, store, recorder, fetchPage });
    await recorder.flush();
    store.finish('captured', {});
    assert.equal(result.authLost, false);
    const q = sql => store.db.prepare(sql).all();
    assert.deepEqual(q("SELECT item_key FROM reports ORDER BY cast(item_key as int)").map(r => r.item_key), ['1', '2', '3', '4', '5', '6', '99']);
    assert.equal(q("SELECT count(*) n FROM items WHERE kind='wallet_event' AND scope_key='w1'")[0].n, 7);
    assert.ok(!q("SELECT 1 FROM items WHERE title='Notícia'").length, 'notícias da busca não entram como relatórios');
    assert.ok(!q("SELECT 1 FROM issues WHERE code='PAGINATION_INCOMPLETE'").length);
    assert.deepEqual(q('SELECT scope_key, ticker FROM wallet_positions ORDER BY scope_key, ticker').map(r => `${r.scope_key}:${r.ticker}`),
      ['dividendos-1:PETR4', 'dividendos-1:VALE3', 'dividendos-2:TAEE11']);
    assert.deepEqual(q('SELECT ticker FROM coverage_daily ORDER BY ticker').map(r => r.ticker), ['COV13', 'COV23']);
    assert.deepEqual(q('SELECT collection_path, ticker FROM funds_daily ORDER BY collection_path').map(r => `${r.collection_path}:${r.ticker}`), ['cotacoes:SNFF11', 'fundos:SNFF11']);
    const blobs = q('SELECT group_concat(json) j FROM blobs')[0].j;
    assert.ok(!blobs.includes('MINHA3'), 'carteira pessoal não deve ser gravada');
    assert.ok(!blobs.includes('pessoa@example.com'), 'email removido do texto da página');
    assert.ok(q("SELECT 1 FROM endpoint_inventory WHERE decision='personal'").length);
    // Rotas e abas de ação não são visitadas/clicadas.
    assert.ok(!log.some(line => line.includes('/comprar')) && !log.some(line => line.includes('wallet=compra')));
    assert.ok(!q("SELECT 1 FROM issues WHERE code='SECTION_WITHOUT_DATA'").length);
    await context.close();
  } finally { await browser.close(); }
});

test('sessão sem autorização não é confirmada', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const store = new KnowledgeStore(':memory:');
    const { context, page } = await setup(browser, { authorized: false });
    const recorder = new ResponseRecorder({ store });
    recorder.attach(page);
    assert.equal(await checkAuthenticated(page, recorder, config), false);
    await context.close();
  } finally { await browser.close(); }
});
