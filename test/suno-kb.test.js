import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEndpoint, storedUrl, paginationOf, nextPageUrl, bulkUrl } from '../src/suno-kb/endpoints.js';
import { findCollections, describeItem, scopeOf, totalOf } from '../src/suno-kb/normalize.js';
import { KnowledgeStore, collectionDate } from '../src/suno-kb/store.js';
import { loadDailyConfig } from '../src/suno-kb/config.js';

const gw = path => `https://membros-api-gateway.suno.com.br/api/${path}`;

test('classifica endpoints de leitura e recusa áreas pessoais', () => {
  assert.equal(classifyEndpoint(gw('v2/reports/v2/list?per_page=10&page=0')).kind, 'report');
  assert.equal(classifyEndpoint(gw('v1/wallets/assets?wallet=dividendos-1')).kind, 'wallet_asset');
  assert.equal(classifyEndpoint(gw('v1/wallets/coverage-universe?page=1&limit=20')).kind, 'coverage');
  assert.equal(classifyEndpoint(gw('v1/nossos-fundos')).kind, 'fund');
  const search = classifyEndpoint(gw('v1/reports/users/12345/search?term=x&wpUserId=99'));
  assert.equal(search.template, 'v1/reports/users/{user}/search');
  assert.deepEqual(search.query, { term: 'x' });
  for (const path of ['v1/wallets/getMyWallet', 'v1/wallets/patrimonyAssetsPosition', 'v1/user/me', 'v1/Wallet/movements',
    'v1/wallets/allWalletsMyInvestiments', 'v2/reports/view/10?userId=1', 'v1/wallets/profitabilityMain']) {
    assert.equal(classifyEndpoint(gw(path)).decision, 'personal', path);
  }
  assert.equal(classifyEndpoint(gw('v2/reports/v2/list'), 'POST').decision, 'not_get');
  assert.equal(classifyEndpoint('https://evil.example/api/v1/nossos-fundos').decision, 'ignored');
  assert.equal(classifyEndpoint(gw('v9/desconhecido')).decision, 'unclassified');
  assert.equal(classifyEndpoint(gw('v1/wallets/bias/abc')).template, 'v1/wallets/bias/{id}');
});

test('URL armazenada não leva identificadores do usuário', () => {
  const url = storedUrl(gw('v1/reports/users/1234567/search?term=a&userId=1234567&wpUserId=9'));
  assert.ok(!url.includes('1234567') && !url.includes('wpUserId') && url.includes('term=a'));
});

test('paginação muda somente a posição', () => {
  const info = paginationOf(gw('v2/reports/v2/list?per_page=10&page=0&categories[]=suno-fiis'));
  assert.equal(info.pageKey, 'page');
  assert.equal(new URL(nextPageUrl(gw('v2/reports/v2/list?per_page=10&page=0'), info, 10)).searchParams.get('page'), '1');
  const offset = paginationOf(gw('v1/reports/users/1/search?limit=12&offset=24'));
  assert.equal(new URL(nextPageUrl(gw('v1/reports/users/1/search?limit=12&offset=24'), offset, 12)).searchParams.get('offset'), '36');
  assert.equal(paginationOf(gw('v1/nossos-fundos')), null);
  assert.equal(paginationOf(gw('v2/reports/v2/list?page=2&per_page=5')).seriesKey, paginationOf(gw('v2/reports/v2/list?per_page=5&page=7')).seriesKey);
});

test('encontra listas e campos comuns', () => {
  const body = { fundos: [{ id: 1, nome: 'Fundo A', ticker: 'SNCI11' }], cotacoes: [{ ticker: 'SNCI11', price: 9.5 }], total: 1 };
  const found = findCollections(body);
  assert.deepEqual(found.map(c => c.path), ['fundos', 'cotacoes']);
  assert.deepEqual(describeItem({ asset: { ticker: 'petr4', name: 'Petrobras' }, peso: '10%' }), { key: 'PETR4', ticker: 'PETR4', title: 'Petrobras', published: null });
  assert.equal(describeItem({ title: { rendered: '<b>Rel</b>' }, id: 7 }).title, 'Rel');
  assert.match(describeItem({ foo: 1 }).key, /^hash:/);
  assert.equal(scopeOf({ kind: 'wallet_asset', query: { wallet: 'dividendos-1' } }), 'dividendos-1');
  assert.equal(scopeOf({ kind: 'coverage', query: { page: '2', limit: '20', category: 'acoes' } }), 'category=acoes');
});

test('data de coleta usa o fuso de São Paulo', () => {
  assert.equal(collectionDate(new Date('2026-11-24T01:30:00Z')), '2026-11-23');
});

test('base acumula relatórios e registra composição diária com entradas e saídas', () => {
  let now = new Date('2026-11-23T22:00:00Z');
  const store = new KnowledgeStore(':memory:', { now: () => now });
  const report = classifyEndpoint(gw('v2/reports/v2/list?per_page=2&page=0'));
  const wallet = classifyEndpoint(gw('v1/wallets/assets?wallet=dividendos'));
  const assets = (...tickers) => ({ data: tickers.map((ticker, i) => ({ ticker, peso: `${i + 1}%`, email: 'x@y.com' })) });

  store.start('manual');
  let r = store.ingest({ classified: report, url: 'u', body: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }], status: 200, via: 'page' });
  assert.deepEqual(r.freshKeys, ['1', '2']);
  store.ingest({ classified: wallet, url: 'u', body: assets('PETR4', 'VALE3'), status: 200, via: 'page' });
  store.finish('captured', {});

  now = new Date('2026-11-24T22:00:00Z');
  store.start('timer');
  r = store.ingest({ classified: report, url: 'u', body: [{ id: 3, title: 'C' }, { id: 1, title: 'A' }], status: 200, via: 'page' });
  assert.deepEqual(r.freshKeys, ['3']);
  store.ingest({ classified: wallet, url: 'u', body: assets('PETR4', 'ITUB4'), status: 200, via: 'page' });
  store.finish('captured', {});

  assert.equal(store.db.prepare('SELECT count(*) n FROM reports').get().n, 3);
  assert.equal(store.db.prepare("SELECT first_seen_at FROM reports WHERE item_key='1'").get().first_seen_at, '2026-11-23T22:00:00.000Z');
  assert.equal(store.db.prepare("SELECT count(*) n FROM wallet_positions WHERE collection_date='2026-11-24'").get().n, 2);
  const changes = store.db.prepare('SELECT change, ticker FROM composition_changes ORDER BY change, ticker').all().map(row => `${row.change}:${row.ticker}`);
  assert.deepEqual(changes, ['entrou:ITUB4', 'saiu:VALE3']);
  // Dados pessoais conhecidos são removidos antes de gravar.
  assert.ok(!store.db.prepare('SELECT group_concat(json) j FROM blobs').get().j.includes('x@y.com'));
  // O mesmo conteúdo em dias diferentes não duplica o JSON.
  assert.equal(store.db.prepare("SELECT count(*) n FROM blobs WHERE json LIKE '%PETR4%' AND json NOT LIKE '%VALE3%' AND json NOT LIKE '%ITUB4%'").get().n, 1);
  store.close();
});

test('configuração diária válida', async () => {
  const config = await loadDailyConfig('suno-daily.config.json');
  assert.deepEqual(config.sections.map(s => s.name), ['relatorios', 'carteiras', 'cobertura', 'fundos']);
});

test('pedido completo e total anunciado pela API', () => {
  const raw = gw('v1/wallets/wallets-events?wallet_id=w&page=1');
  const url = new URL(bulkUrl(raw, paginationOf(raw), 341));
  assert.equal(url.searchParams.get('page'), '0');
  assert.equal(url.searchParams.get('limit'), '341');
  assert.equal(totalOf({ count: 255, list: [] }), 255);
  assert.equal(totalOf({ assets: [], total_entries: 131 }), 131);
  assert.equal(totalOf([1, 2]), null);
  assert.deepEqual(classifyEndpoint(gw('v2/search?per_page=12&page=0')).collections, ['report.list']);
});

test('ticker aninhado em assets e reindexação a partir das respostas brutas', () => {
  const store = new KnowledgeStore(':memory:', { now: () => new Date('2026-11-23T22:00:00Z') });
  const classified = classifyEndpoint(gw('v1/wallets/assets?wallet=valor-recomendada'));
  store.start('manual');
  store.ingest({ classified, url: storedUrl(gw('v1/wallets/assets?wallet=valor-recomendada')), status: 200, via: 'page',
    body: { assets: [{ id: 'row-1', allocation: 5, assets: { ticker: 'TAEE11', name: 'Taesa' } }], has_access: true } });
  store.finish('captured', {});
  const row = () => store.db.prepare('SELECT item_key, ticker, title FROM wallet_positions').get();
  assert.deepEqual({ ...row() }, { item_key: 'TAEE11', ticker: 'TAEE11', title: 'Taesa' });
  store.db.exec("UPDATE observations SET ticker=NULL, item_key='x'");
  assert.equal(store.reindex(url => classifyEndpoint(url, 'GET')), 1);
  assert.deepEqual({ ...row() }, { item_key: 'TAEE11', ticker: 'TAEE11', title: 'Taesa' });
  assert.ok(storedUrl(gw('v1/wallets/1e32b952-3f74-4bd5-ae7e-1107d3746bd7/benchmark-rentability')).includes('1e32b952'));
  store.close();
});
