import test from 'node:test';
import assert from 'node:assert/strict';
import { localCdpEndpoint, createManualLogin, selectCatalogTarget, transferCookies, attachCatalog } from '../src/cdp.js';
import { manualChromeArgs } from '../src/manual-browser.js';
import { collectionContext } from '../src/browser.js';
import { loadConfig } from '../src/config.js';

const config = await loadConfig('btg.config.json');
const catalogUrl = `${config.baseUrl}${config.entryPath}`;
const target = { type: 'page', targetId: 'catalog', browserContextId: 'private-session', url: catalogUrl };
const cookie = { name: 'session', value: 'SYNTHETIC-PRIVATE-COOKIE', domain: '.btgpactual.com', path: '/', expires: -1, httpOnly: true, secure: true };

test('CDP endpoints are restricted to explicit local IPv4 ports without credentials, redirects, query strings or websocket capabilities', () => {
  assert.equal(localCdpEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  for (const value of ['http://0.0.0.0:9222', 'https://127.0.0.1:9222', 'http://other.test:9222', 'http://127.0.0.1', 'http://127.0.0.1:80',
    'http://user:SECRET@127.0.0.1:9222', 'http://127.0.0.1:9222/?token=SECRET', 'http://127.0.0.1:9222/#SECRET', 'ws://127.0.0.1:9222/devtools/browser/SECRET']) {
    assert.throws(() => localCdpEndpoint(value), error => error.code === 'CDP_ENDPOINT_INVALID' && !error.message.includes('SECRET'));
  }
});

test('catalog selection refuses regular profiles, login pages, trade routes, and ambiguous sessions', () => {
  assert.equal(selectCatalogTarget([target], ['private-session'], config), target);
  assert.throws(() => selectCatalogTarget([target], [], config), { code: 'CDP_PRIVATE_CONTEXT_REQUIRED' });
  assert.throws(() => selectCatalogTarget([{ ...target, url: `${config.baseUrl}/login` }], ['private-session'], config), { code: 'CDP_CATALOG_REQUIRED' });
  assert.throws(() => selectCatalogTarget([{ ...target, url: `${catalogUrl}/investir` }], ['private-session'], config), { code: 'CDP_CATALOG_REQUIRED' });
  assert.throws(() => selectCatalogTarget([target, { ...target, targetId: 'second' }], ['private-session'], config), { code: 'CDP_MULTIPLE_CATALOGS' });
});

test('the manual Chrome launcher uses an isolated directory and loopback without altering identity, TLS, or the personal profile', () => {
  const args = manualChromeArgs('/tmp/synthetic-btg-profile', 9222);
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--user-data-dir=/tmp/synthetic-btg-profile'));
  for (const unsafe of ['--no-sandbox', '--ignore-certificate-errors', '--remote-allow-origins=*', '--user-agent', 'AutomationControlled']) assert.ok(!args.some(arg => arg.includes(unsafe)));
  assert.throws(() => manualChromeArgs('/tmp/synthetic-btg-profile', 0), { code: 'CDP_ENDPOINT_INVALID' });
});

test('manual login bootstrap creates an off-the-record context with only the public login target and never exports state', async () => {
  const calls = [];
  let closed = false;
  class FakeSocket extends EventTarget {
    constructor(url) { super(); assert.equal(url, 'ws://127.0.0.1:9222/devtools/browser/SYNTHETIC'); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const message = JSON.parse(raw);
      calls.push(message);
      const result = message.method === 'Target.createBrowserContext' ? { browserContextId: 'private-session' } : { targetId: 'login' };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) })));
    }
    close() { closed = true; }
  }
  await createManualLogin('http://127.0.0.1:9222', 'https://app.btgpactual.com/login', {
    Socket: FakeSocket,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:9222/json/version');
      assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/SYNTHETIC' }) };
    },
  });
  assert.deepEqual(calls.map(call => call.method), ['Target.createBrowserContext', 'Target.createTarget']);
  assert.equal(calls[0].params.disposeOnDetach, false);
  assert.equal(calls[1].params.browserContextId, 'private-session');
  assert.equal(calls[1].params.url, 'https://app.btgpactual.com/login');
  assert.equal(closed, true);
});

test('bootstrap rejects a local discovery endpoint that redirects websocket access outside loopback', async () => {
  await assert.rejects(createManualLogin('http://127.0.0.1:9222', 'https://app.btgpactual.com/login', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://other.test:9222/devtools/browser/SECRET' }) }),
    Socket: class { constructor() { throw new Error('must not connect outside loopback'); } },
  }), error => error.code === 'CDP_CONNECTION_FAILED' && !error.message.includes('SECRET'));
});

test('CDP transfers first-party cookies and refuses ambiguous partition semantics', () => {
  const result = transferCookies([cookie, { ...cookie, domain: '.other.test' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, cookie.value);
  assert.equal(result[0].sameSite, 'Lax');
  assert.throws(() => transferCookies([{ ...cookie, partitionKey: { topLevelSite: 'https://btgpactual.com' } }]), { code: 'SESSION_MEMORY_TRANSFER_FAILED' });
});

test('attachment captures only the selected incognito context instead of exporting the default profile', async () => {
  const calls = [];
  const root = { send: async (method, params) => {
    calls.push({ method, params });
    if (method === 'Target.getBrowserContexts') return { browserContextIds: ['private-session'] };
    if (method === 'Target.getTargets') return { targetInfos: [target] };
    if (method === 'Storage.getCookies') { assert.equal(params.browserContextId, 'private-session'); return { cookies: [cookie] }; }
    throw new Error('unexpected protocol method');
  } };
  let source;
  const page = { context: () => source, evaluate: async (_fn, origin) => { assert.equal(origin, config.baseUrl); return [{ name: 'access_token', value: 'SYNTHETIC-TOKEN' }]; } };
  source = { pages: () => [page], storageState: () => { throw new Error('must not export a default profile'); }, newCDPSession: async () => ({ send: async () => ({ targetInfo: target }), detach: async () => {} }) };
  const browser = { contexts: () => [source], newBrowserCDPSession: async () => root };
  const chromium = { connectOverCDP: async (endpoint, options) => { assert.equal(endpoint, 'http://127.0.0.1:9222'); assert.equal(options.noDefaults, true); return browser; } };
  const attached = await attachCatalog(chromium, 'http://127.0.0.1:9222', config);
  assert.equal(attached.page, page);
  const state = await attached.captureState();
  assert.equal(state.cookies[0].value, cookie.value);
  assert.deepEqual(state.origins, [{ origin: config.baseUrl, localStorage: [{ name: 'access_token', value: 'SYNTHETIC-TOKEN' }] }]);
  assert.equal(calls.filter(call => call.method === 'Storage.getCookies').length, 1);
});

test('external authentication context remains open while a new guarded collection context is created', async () => {
  let captured = false;
  const state = { cookies: [], origins: [] };
  const external = { close: () => { throw new Error('must not close the manual window'); }, storageState: () => { throw new Error('must not inspect the default context'); } };
  const page = { evaluate: async () => [] };
  const created = { addInitScript: async () => {}, newPage: async () => ({}) };
  const browser = { newContext: async options => { assert.equal(options.serviceWorkers, 'block'); assert.equal(options.storageState, state); return created; } };
  const result = await collectionContext(browser, external, page, { ...config, authServiceWorkers: 'block' }, {
    captureState: async () => { captured = true; return state; }, closeAuthContext: false,
  });
  assert.equal(result.context, created);
  assert.equal(captured, true);
});
