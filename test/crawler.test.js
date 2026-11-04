import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/crawler.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/database.js';
import { EventEmitter } from 'node:events';
import { assertReadable } from '../src/extract.js';

const btg = await loadConfig('btg.config.json');

function pageWithoutNetwork(initialUrl) {
  const events = new EventEmitter();
  const navigations = [];
  let guards = 0;
  return {
    navigations,
    get guards() { return guards; },
    url: () => initialUrl,
    on: events.on.bind(events),
    off: events.off.bind(events),
    emit: events.emit.bind(events),
    context: () => ({ route: async () => { guards++; } }),
    goto: async url => {
      navigations.push(url);
      // Stop before any DOM extraction: this test checks navigation scheduling,
      // not a simulated version of the site's selectors or authentication.
      throw Object.assign(new Error('Synthetic navigation failure'), { name: 'TimeoutError' });
    },
  };
}

test('BTG collection schedules the catalog when transferred authentication leaves a new about:blank tab', async () => {
  const store = new Store(':memory:');
  try {
    const page = pageWithoutNetwork('about:blank');
    const result = await collect({ page, config: btg, store, purpose: 'start' });
    assert.deepEqual(page.navigations, btg.seedPaths.map(path => new URL(path, btg.baseUrl).href));
    assert.equal(page.guards, 1);
    assert.equal(result.pagesFailed, 5);
    assert.equal(result.pageResults.length, 5);
    assert.ok(result.pageResults.every(page => page.status === 'failed' && page.error === 'TIMEOUT'));
    assert.equal(store.db.prepare('SELECT count(*) n FROM pages WHERE run_id=?').get(result.runId).n, 5);
    assert.deepEqual(store.db.prepare('SELECT source_url FROM pages WHERE run_id=? ORDER BY id').all(result.runId).map(row => row.source_url), page.navigations);
    assert.equal(store.db.prepare("SELECT count(*) n FROM issues WHERE run_id=? AND code='TIMEOUT'").get(result.runId).n, 5);
  } finally { store.close(); }
});

test('Suno starting routes also use their configured origin rather than a blank or unrelated tab', async () => {
  const suno = await loadConfig('suno.config.json');
  const store = new Store(':memory:');
  try {
    const page = pageWithoutNetwork('https://unrelated.test/session/');
    const result = await collect({ page, config: suno, store, purpose: 'rebalance' });
    assert.deepEqual(page.navigations, ['https://investidor.suno.com.br/portfolio', 'https://investidor.suno.com.br/carteiras']);
    assert.equal(result.pagesFailed, 2);
  } finally { store.close(); }
});

test('an entirely rejected seed list fails explicitly before navigation instead of reporting only downstream catalog warnings', async () => {
  const store = new Store(':memory:');
  try {
    const page = pageWithoutNetwork('about:blank');
    const config = { ...btg, seedPaths: ['/conta', 'https://other.test/produtos-de-investimento', '/produtos-de-investimento/ordens'] };
    const result = await collect({ page, config, store, purpose: 'start' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureReason, 'INITIAL_URLS_REJECTED');
    assert.equal(result.productObservations, 0);
    assert.deepEqual(page.navigations, []);
    assert.equal(page.guards, 0);
    assert.deepEqual(store.db.prepare('SELECT code FROM issues WHERE run_id=?').all(result.runId).map(row => row.code), ['INITIAL_URLS_REJECTED']);
    assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(result.runId).status, 'failed');
  } finally { store.close(); }
});

test('the fund page loading-error message is classified as a load failure without exposing page text', async () => {
  const page = {
    url: () => `${btg.baseUrl}/produtos-de-investimento/fundos-de-investimento`,
    locator: selector => ({ count: async () => 0, first() { return this; },
      innerText: async () => selector === 'body' ? 'Catálogo' : 'Não foi possível carregar as informações\nPRIVATE-SYNTHETIC-CONTENT' }),
  };
  await assert.rejects(assertReadable(page, btg), error => error.code === 'APPLICATION_LOAD_ERROR' && !error.message.includes('PRIVATE'));
});

test('a product API 401 stops the run at the first page and explicitly requests reauthentication', async () => {
  const store = new Store(':memory:');
  try {
    const page = pageWithoutNetwork('about:blank');
    page.goto = async url => {
      page.navigations.push(url);
      const request = { method: () => 'GET', resourceType: () => 'fetch', isNavigationRequest: () => false,
        url: () => `${btg.baseUrl}/investments/api/fixed-income/combo/account/PRIVATE-ACCOUNT` };
      page.emit('request', request);
      page.emit('response', { request: () => request, status: () => 401 });
      page.emit('requestfinished', request);
      return { ok: () => true }; // The HTML is readable while its data API refuses authentication.
    };
    const result = await collect({ page, config: btg, store, purpose: 'start' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureReason, 'API_AUTHENTICATION_REQUIRED');
    assert.equal(result.reauthenticationRequired, true);
    assert.equal(result.pagesFailed, 1);
    assert.equal(result.pagesNotVisited, 4);
    assert.equal(result.snapshots, 0);
    assert.equal(result.pageResults[0].error, 'API_AUTHENTICATION_REQUIRED');
    assert.equal(page.navigations.length, 1);
    const issues = store.db.prepare('SELECT code,detail FROM issues').all();
    assert.ok(issues.some(issue => issue.code === 'DATA_REQUEST_HTTP_ERROR' && JSON.parse(issue.detail).status === 401));
    assert.ok(!issues.some(issue => ['APPLICATION_LOAD_ERROR', 'CATEGORY_NOT_CONFIRMED', 'NO_PRODUCTS_IDENTIFIED'].includes(issue.code)));
    assert.ok(!JSON.stringify(issues).includes('PRIVATE-ACCOUNT'));
  } finally { store.close(); }
});
