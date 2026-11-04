import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/database.js';
import { redact, privatePath, scrubSnapshot, redactUrl, diagnosticPath, queryFieldSchema, scrubRequestDiagnostic } from '../src/privacy.js';
import { scopedUrl, maySend, isQueryBody, installReadOnlyGuard } from '../src/policy.js';
import { loadConfig } from '../src/config.js';

const defaults = await loadConfig('suno.config.json');

test('privacy redacts credentials, CPF and bank identifiers without altering Brazilian amounts', () => {
  const text = redact('CPF: 123.456.789-00 email: pessoa@example.test Conta corrente: 98765-4; agência: 1234; senha: segredo; token=abc; R$ 1.234,56; 15,50%');
  for (const secret of ['123.456.789-00', 'pessoa@example.test', '98765-4', '1234;', 'segredo', 'abc']) assert.ok(!text.includes(secret));
  assert.ok(text.includes('R$ 1.234,56'));
  assert.ok(text.includes('15,50%'));
  assert.throws(() => privatePath('public.sqlite'));
});

test('crawl scope rejects external, auth, write and unknown-query links', () => {
  const config = defaults;
  assert.equal(scopedUrl('/carteiras/acoes?page=2', config), 'https://investidor.suno.com.br/carteiras/acoes?page=2');
  for (const url of ['/portfolio/delete', '/portfolio/editar/1', '/portfolio?token=secret', '/portfolio?action=buy', 'https://other.test/portfolio', '/profile', 'javascript:alert(1)']) {
    assert.equal(scopedUrl(url, config), null, url);
  }
});

test('request guard allows explicit GraphQL queries and denies mutations, persisted queries and writes', () => {
  const config = { ...defaults, readOnlyGraphqlPaths: ['/graphql'] };
  const request = (method, body, url = `${config.baseUrl}/graphql`) => ({ method: () => method, url: () => url, postDataJSON: () => body });
  assert.equal(maySend(request('POST', { query: 'query Wallet { assets { ticker } }' }), config), true);
  assert.equal(maySend(request('POST', { query: 'mutation { sell }' }), config), false);
  assert.equal(maySend(request('POST', { query: '{ assets { ticker } }' }, 'https://other.test/graphql'), config), false);
  assert.equal(isQueryBody([{ query: '{ assets { ticker } }' }, { query: 'mutation { buy }' }]), false);
  assert.equal(isQueryBody({ extensions: { persistedQuery: { hash: 'x' } } }), false);
  assert.equal(maySend(request('DELETE'), config), false);
  assert.equal(maySend(request('GET', null, `${config.baseUrl}/portfolio/excluir`), config), false);
});

test('SQLite snapshots are transactional, deduplicated per view, historical and private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suno-store-'));
  const path = join(dir, 'suno.sqlite');
  const store = new Store(path);
  try {
    const run = store.start('start', {});
    const page = store.page(run, 'https://investidor.suno.com.br/portfolio', 'portfolio_area');
    const data = { title: 'Meu portfólio', headings: [], text: 'CPF 12345678900', ownership: 'user_positions', cards: [], links: [], tables: [{ caption: 'Ativos', headers: ['Ticker', 'Peso', 'Preço'], rows: [['TEST3', '12,50%', 'R$ 10,25']] }] };
    const mappings = [{ name: 'explicit', columns: { identifier: 'Ticker', weight: 'Peso', price: 'Preço' } }];
    assert.equal(store.save(page, 'default', 0, data, mappings), true);
    assert.equal(store.save(page, 'default', 1, data, mappings), false);
    assert.equal(store.db.prepare('SELECT count(*) n FROM snapshots').get().n, 1);
    const record = store.db.prepare('SELECT * FROM collected_records').get();
    assert.equal(record.identifier, 'TEST3');
    assert.equal(record.weight_text, '12,50%');
    assert.equal(record.price_text, 'R$ 10,25');
    assert.equal(record.ownership, 'user_positions');
    assert.ok(!store.db.prepare('SELECT visible_text FROM snapshots').get().visible_text.includes('12345678900'));
    const broken = { ...data, title: 'Fail', tables: [{ caption: null, headers: [], rows: [['x']] }] };
    assert.throws(() => store.save(page, 'broken', 0, broken));
    assert.equal(store.db.prepare('SELECT count(*) n FROM snapshots').get().n, 1);
    const second = store.start('rebalance', {});
    const secondPage = store.page(second, 'https://investidor.suno.com.br/portfolio', 'portfolio_area');
    store.save(secondPage, 'default', 0, data, mappings);
    assert.equal(store.db.prepare('SELECT count(*) n FROM snapshots').get().n, 2);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sensitive table columns and encoded identifiers are redacted before persistence', () => {
  const data = scrubSnapshot({ tables: [{ headers: ['Ticker', 'Conta', 'CPF'], rows: [['TEST3', '56789-0', '12345678900']] }] });
  assert.deepEqual(data.tables[0].rows, [['TEST3', '[REMOVIDO]', '[REMOVIDO]']]);
  assert.ok(!redactUrl('https://investidor.suno.com.br/portfolio?id=123%2E456%2E789-00').includes('123'));
});

test('blocked-request diagnostics redact account and client route identifiers, including historical rows', () => {
  const raw = '/investments/api/account/987654321/client/12345678/status?token=never-keep';
  const expected = '/investments/api/account/[REMOVIDO]/client/[REMOVIDO]/status';
  assert.equal(diagnosticPath(raw), expected);
  assert.equal(diagnosticPath('/api/account/opaque-identifier/status'), '/api/account/[REMOVIDO]/status');
  const dir = mkdtempSync(join(tmpdir(), 'diagnostic-history-'));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    const run = store.start('start', {});
    // Simulate a row written by an older version; current issue() also scrubs it.
    store.db.prepare('INSERT INTO issues(run_id,code,detail) VALUES(?,?,?)').run(run, 'REQUEST_BLOCKED_READ_ONLY', JSON.stringify(raw));
    store.close();
    store = new Store(path);
    assert.equal(JSON.parse(store.db.prepare('SELECT detail FROM issues').get().detail), expected);
    store.issue(run, null, 'REQUEST_BLOCKED_READ_ONLY', raw);
    assert.ok(store.db.prepare('SELECT detail FROM issues').all().every(row => JSON.parse(row.detail) === expected));
    assert.equal(store.db.prepare('SELECT count(*) n FROM runs').get().n, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('request guard records only method, resource type, origin category and sanitized path without reading payloads', async () => {
  let handler;
  const blocked = [];
  let aborted = 0;
  const context = { route: async (_pattern, callback) => { handler = callback; } };
  const request = { method: () => 'POST', resourceType: () => 'fetch',
    url: () => 'https://api.btgpactual.com/investments/api/fixed-income/accounts/PRIVATE-ACCOUNT/fixedincomes?token=PRIVATE-TOKEN',
    headers: () => { throw new Error('must not read headers'); }, postDataJSON: () => { throw new Error('must not read POST body'); } };
  await installReadOnlyGuard(context, { ...defaults, provider: 'btg', baseUrl: 'https://app.btgpactual.com' }, (path, detail) => blocked.push({ path, ...detail }));
  await handler({ request: () => request, abort: async () => { aborted++; }, fallback: async () => { throw new Error('write escaped'); } });
  assert.equal(aborted, 1);
  assert.deepEqual(blocked, [{ path: '/investments/api/fixed-income/accounts/[REMOVIDO]/fixedincomes', method: 'POST', resource_type: 'fetch', origin_scope: 'provider' }]);
  assert.ok(!JSON.stringify(blocked).includes('PRIVATE'));
});

test('structured request diagnostics are scrubbed again at the SQLite persistence boundary', () => {
  const store = new Store(':memory:');
  try {
    const run = store.start('start', {});
    for (const code of ['REQUEST_BLOCKED_READ_ONLY', 'DATA_REQUEST_HTTP_ERROR', 'DATA_REQUEST_FAILED']) {
      store.issue(run, null, code, { path: '/api/account/PRIVATE-ACCOUNT/status?token=PRIVATE-TOKEN', method: 'GET', resource_type: 'xhr',
        origin_scope: 'application', status: 403, failure: 'ERR_FAILED', headers: { authorization: 'PRIVATE' }, body: 'PRIVATE', extra: 'PRIVATE' });
    }
    for (const row of store.db.prepare('SELECT detail FROM issues').all()) {
      const detail = JSON.parse(row.detail);
      assert.equal(detail.path, '/api/account/[REMOVIDO]/status');
      assert.equal(detail.method, 'GET');
      assert.equal(detail.status, 403);
      assert.equal(detail.failure, 'ERR_FAILED');
      assert.equal(detail.headers, undefined);
      assert.ok(!row.detail.includes('PRIVATE'));
    }
  } finally { store.close(); }
});

test('catalog POST guard permits validated filters but reports refusals using fixed codes without query values', async () => {
  let handler;
  let passed = 0;
  let aborted = 0;
  const blocked = [];
  const context = { route: async (_pattern, callback) => { handler = callback; } };
  const config = { ...defaults, provider: 'btg', baseUrl: 'https://app.btgpactual.com' };
  const request = body => ({ method: () => 'POST', resourceType: () => 'fetch', isNavigationRequest: () => false,
    url: () => 'https://app.btgpactual.com/investments/api/fund-subscription/v2/account', postDataJSON: () => body,
    frame: () => ({ parentFrame: () => null, url: () => 'https://app.btgpactual.com/produtos-de-investimento/fundos-de-investimento' }) });
  await installReadOnlyGuard(context, config, (path, detail) => blocked.push({ path, ...detail }));
  const send = async body => handler({ request: () => request(body), fallback: async () => { passed++; }, abort: async () => { aborted++; } });
  await send({ accountNumber: 'PRIVATE-ACCOUNT', filters: { search: 'PRIVATE-SEARCH' }, page: 0 });
  await send({ amount: 'PRIVATE-AMOUNT', fundId: 'PRIVATE-PRODUCT' });
  await send({ unknown: 'PRIVATE-UNKNOWN' });
  assert.equal(passed, 1);
  assert.equal(aborted, 2);
  assert.deepEqual(blocked.map(detail => detail.query_check), ['TRANSACTION_FIELD', 'UNRECOGNIZED_FIELD']);
  assert.ok(!JSON.stringify(blocked).includes('PRIVATE'));
  const store = new Store(':memory:');
  try {
    const run = store.start('start', {});
    for (const detail of blocked) store.issue(run, null, 'REQUEST_BLOCKED_READ_ONLY', detail);
    assert.deepEqual(store.db.prepare('SELECT detail FROM issues').all().map(row => JSON.parse(row.detail).query_check), ['TRANSACTION_FIELD', 'UNRECOGNIZED_FIELD']);
  } finally { store.close(); }
});

test('unknown catalog query diagnostics retain bounded field labels and types, without financial, account or credential values', () => {
  const fields = queryFieldSchema({ accountNumber: 'PRIVATE-ACCOUNT', filters: { unknownFilter: 'PRIVATE-SEARCH',
    maturityDays: 123456789, accessToken: 'PRIVATE-TOKEN', '12345678900': 'PRIVATE-CPF',
    'PRIVATE-OPAQUE-ID': 'PRIVATE-VALUE' }, password: 'PRIVATE-PASSWORD' });
  const detail = scrubRequestDiagnostic({ path: '/api/catalog', method: 'POST', resource_type: 'fetch', origin_scope: 'application',
    query_check: 'UNRECOGNIZED_FIELD', query_fields: fields });
  assert.ok(detail.query_fields.some(field => field.path === 'filters.unknownFilter' && field.type === 'string'));
  assert.ok(detail.query_fields.some(field => field.path === 'filters.maturityDays' && field.type === 'number'));
  assert.ok(detail.query_fields.some(field => field.path === 'accountNumber' && field.type === 'string'));
  const json = JSON.stringify(detail);
  for (const secret of ['PRIVATE', '123456789', '12345678900', 'accessToken', 'password']) assert.ok(!json.includes(secret), secret);
  assert.ok(queryFieldSchema(Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['field' + i, 'PRIVATE']))).length <= 80);
});

