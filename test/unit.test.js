import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/database.js';
import { redact, privatePath, scrubSnapshot, redactUrl } from '../src/privacy.js';
import { scopedUrl, maySend, isQueryBody } from '../src/policy.js';
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

