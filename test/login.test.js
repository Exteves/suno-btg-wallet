import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchOptions, contextOptions, collectionContext } from '../src/browser.js';
import { loginDiagnostics, startupErrorCode, loginPageState } from '../src/login-diagnostics.js';
import { loadConfig } from '../src/config.js';
import { classifyBrowserError } from '../src/errors.js';

const config = await loadConfig('btg.config.json');

test('login starts at the public route while the catalog remains guarded; external, credential and operation routes cannot be configured as login', async t => {
  assert.equal(config.loginPath, '/login');
  assert.equal(config.entryPath, '/produtos-de-investimento');
  const suno = await loadConfig('suno.config.json');
  assert.equal(suno.loginPath, suno.entryPath);
  const directory = await mkdtemp(join(tmpdir(), 'login-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  for (const loginPath of ['https://other.test/login', '//other.test/login', '/conta', '/login?password=SYNTHETIC-SECRET', '/login#SYNTHETIC-SECRET', '/produtos-de-investimento/ordens']) {
    await writeFile(path, JSON.stringify({ ...config, loginPath }));
    await assert.rejects(loadConfig(path), error => !error.message.includes('SYNTHETIC-SECRET'));
  }
});

test('BTG allows service workers during manual authentication and always blocks them for collection', () => {
  assert.equal(config.authServiceWorkers, 'allow');
  assert.equal(contextOptions(config, 'authentication').serviceWorkers, 'allow');
  assert.equal(contextOptions({ ...config, collectionServiceWorkers: 'allow' }).serviceWorkers, 'block');
  assert.equal(contextOptions({ authServiceWorkers: 'block' }, 'authentication').serviceWorkers, 'block');
  assert.equal(contextOptions(config).ignoreHTTPSErrors, undefined);
  assert.equal(contextOptions(config).userAgent, undefined);
});

test('browser selection supports installed Chrome/Edge without stealth flags, profiles or ambiguous executable options', () => {
  assert.deepEqual(launchOptions(), { headless: false });
  assert.deepEqual(launchOptions({ browserChannel: 'chrome' }), { headless: false, channel: 'chrome' });
  assert.deepEqual(launchOptions({ browserChannel: 'msedge' }), { headless: false, channel: 'msedge' });
  assert.deepEqual(launchOptions({ browserPath: '/example/browser' }), { headless: false, executablePath: '/example/browser' });
  assert.throws(() => launchOptions({ browserChannel: 'chrome', browserPath: '/example/browser' }), { code: 'CLI_USAGE' });
  assert.throws(() => launchOptions({ browserChannel: 'stealth' }), { code: 'CLI_USAGE' });
  assert.equal(classifyBrowserError(new Error("Chromium distribution 'chrome' is not found")).code, 'BROWSER_CHANNEL_MISSING');
});

test('authentication is transferred in memory, workers stop with the old context, and collection starts in a fresh blocked context', async () => {
  const order = [];
  const state = { cookies: [{ name: 'synthetic_cookie', value: 'SYNTHETIC-COOKIE' }], origins: [] };
  const authContext = {
    storageState: async options => { assert.deepEqual(options, { indexedDB: true }); order.push('capture-memory'); return state; },
    close: async () => { order.push('close-auth'); },
  };
  const authPage = { evaluate: async (_fn, origin) => { assert.equal(origin, config.baseUrl); return [['access_token', 'SYNTHETIC-TOKEN']]; } };
  const collectionPage = {};
  let init;
  const context = {
    addInitScript: async (fn, args) => { init = { fn, args }; order.push('init-session-storage'); },
    newPage: async () => { order.push('new-page'); return collectionPage; },
  };
  const browser = { newContext: async options => {
    assert.equal(options.serviceWorkers, 'block');
    assert.equal(options.storageState, state);
    assert.equal(options.recordHar, undefined);
    assert.equal(options.recordVideo, undefined);
    order.push('new-context'); return context;
  } };
  const result = await collectionContext(browser, authContext, authPage, config);
  assert.equal(result.context, context);
  assert.equal(result.page, collectionPage);
  assert.deepEqual(order, ['capture-memory', 'new-context', 'init-session-storage', 'new-page', 'close-auth']);
  assert.equal(init.args.origin, config.baseUrl);
});

test('transferred sessionStorage is restricted to the origin and preserves newly refreshed values', async () => {
  let init;
  const context = { addInitScript: async (fn, args) => { init = { fn, args }; }, newPage: async () => ({}) };
  const browser = { newContext: async () => context };
  const auth = { storageState: async () => ({ cookies: [], origins: [] }), close: async () => {} };
  await collectionContext(browser, auth, { evaluate: async () => [['token', 'SYNTHETIC-INITIAL']] }, config);
  const values = new Map();
  const run = origin => runInNewContext(`(${init.fn.toString()})(args)`, { args: init.args,
    location: { origin }, sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  run('https://other.test');
  assert.equal(values.size, 0);
  run(config.baseUrl);
  assert.equal(values.get('token'), 'SYNTHETIC-INITIAL');
  values.set('token', 'SYNTHETIC-REFRESHED');
  run(config.baseUrl);
  assert.equal(values.get('token'), 'SYNTHETIC-REFRESHED');
});

test('transfer failures close the incomplete collection context without exposing session data', async () => {
  let closed = false;
  const context = { addInitScript: async () => { throw new Error('SECRET-SHOULD-NOT-LEAK'); }, close: async () => { closed = true; } };
  await assert.rejects(collectionContext({ newContext: async () => context },
    { storageState: async () => ({ cookies: [], origins: [] }) }, { evaluate: async () => [] }, config),
    error => error.code === 'SESSION_MEMORY_TRANSFER_FAILED' && !error.message.includes('SECRET-SHOULD-NOT-LEAK'));
  assert.equal(closed, true);
});

test('Suno keeps its original context when workers are blocked, without exporting additional state', async () => {
  const auth = { storageState: () => { throw new Error('must not capture state'); } };
  const page = {};
  assert.deepEqual(await collectionContext({}, auth, page, { authServiceWorkers: 'block' }), { context: auth, page });
});

test('login diagnostics aggregate failures without reading URLs, bodies, headers, console text or exception messages', () => {
  const context = new EventEmitter();
  const page = new EventEmitter();
  context.pages = () => [];
  const diagnostics = loginDiagnostics(context);
  context.emit('page', page);
  const request = {
    failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED https://private.test/path?token=SYNTHETIC-SECRET' }),
    resourceType: () => 'script',
    url: () => { throw new Error('must not inspect URLs'); },
    headers: () => { throw new Error('must not inspect headers'); },
  };
  context.emit('requestfailed', request);
  context.emit('requestfailed', request);
  context.emit('response', { status: () => 403, request: () => request });
  page.emit('pageerror', new Error('PRIVATE-PAGE-CONTENT'));
  page.emit('console', { type: () => 'error', text: () => { throw new Error('must not inspect console text'); } });
  const summary = diagnostics.summary();
  assert.equal(summary.events.find(event => event.code === 'ERR_NAME_NOT_RESOLVED').count, 2);
  assert.equal(summary.events.find(event => event.code === 403).count, 1);
  for (const secret of ['private.test', 'SYNTHETIC-SECRET', 'PRIVATE-PAGE-CONTENT']) assert.ok(!JSON.stringify(summary).includes(secret));
  diagnostics.detach();
  context.emit('requestfailed', request);
  assert.equal(diagnostics.summary().events.find(event => event.code === 'ERR_NAME_NOT_RESOLVED').count, 2);
  assert.equal(context.listenerCount('requestfailed'), 0);
  assert.equal(page.listenerCount('pageerror'), 0);
});

test('diagnostics classify denied application, provider and external resources without retaining domains, paths or secrets', () => {
  const context = new EventEmitter();
  context.pages = () => [];
  const diagnostic = loginDiagnostics(context, config);
  for (const url of [
    'https://app.btgpactual.com/private/SYNTHETIC-SECRET?token=SYNTHETIC-SECRET',
    'https://api.btgpactual.com/private/SYNTHETIC-SECRET',
    'https://assets.example.test/SYNTHETIC-SECRET.js',
    'https://btgpactual.com.other.test/SYNTHETIC-SECRET.js',
  ]) {
    const request = { url: () => url, resourceType: () => 'script' };
    context.emit('response', { status: () => 403, request: () => request });
  }
  const summary = diagnostic.summary();
  assert.equal(summary.events.find(event => event.origin_scope === 'application').count, 1);
  assert.equal(summary.events.find(event => event.origin_scope === 'provider').count, 1);
  assert.equal(summary.events.find(event => event.origin_scope === 'external').count, 2);
  const output = JSON.stringify(summary);
  for (const text of ['SYNTHETIC-SECRET', 'private/', 'btgpactual.com', 'assets.example.test', 'token=']) assert.ok(!output.includes(text));
  diagnostic.detach();
});

test('startup error classification returns fixed categories and never arbitrary console text', () => {
  for (const [text, code] of [
    ['Access to fetch has been blocked by CORS policy', 'CORS_ERROR'],
    ['Refused to load because it violates Content Security Policy', 'CONTENT_SECURITY_POLICY_ERROR'],
    ['Refused module because MIME type text/html is invalid', 'SCRIPT_MIME_TYPE_ERROR'],
    ['ChunkLoadError: Loading chunk 3 failed', 'SCRIPT_MODULE_LOAD_ERROR'],
    ['Failed to register a ServiceWorker', 'SERVICE_WORKER_ERROR'],
    ['Access to localStorage is denied', 'BROWSER_STORAGE_ERROR'],
    ['This browser is not supported', 'UNSUPPORTED_BROWSER_MESSAGE'],
    ["TypeError: Cannot read properties of undefined", 'JAVASCRIPT_TYPE_ERROR'],
    ['ReferenceError: missing function', 'JAVASCRIPT_REFERENCE_ERROR'],
    ['SyntaxError: invalid token', 'JAVASCRIPT_SYNTAX_ERROR'],
    ['Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_CLIENT'],
    ['Failed to load resource: the server responded with a status of 403', 'RESOURCE_HTTP_ERROR'],
    ['PRIVATE-CREDENTIAL-UNCLASSIFIED', 'BROWSER_CONSOLE_ERROR'],
  ]) assert.equal(startupErrorCode(text, 'BROWSER_CONSOLE_ERROR'), code);
});

test('only the explicit pre-credential diagnostic mode classifies console and script errors without retaining messages or stack traces', () => {
  const context = new EventEmitter();
  const page = new EventEmitter();
  context.pages = () => [page];
  const diagnostics = loginDiagnostics(context, { ...config, classifyStartupErrors: true });
  page.emit('console', { type: () => 'error', text: () => 'CORS policy refused https://private.test/?token=SECRET', args: () => { throw new Error('must not inspect console objects'); } });
  page.emit('pageerror', new Error('TypeError: SECRET-PAGE-CONTENT'));
  const summary = diagnostics.summary();
  assert.equal(summary.diagnostic_version, 2);
  assert.equal(summary.events.find(event => event.code === 'CORS_ERROR').count, 1);
  assert.equal(summary.events.find(event => event.code === 'JAVASCRIPT_TYPE_ERROR').count, 1);
  for (const secret of ['private.test', 'SECRET', 'token=', 'TypeError:']) assert.ok(!JSON.stringify(summary).includes(secret));
  diagnostics.detach();
});

test('page state only returns bounded structural counts and readiness, ignoring values, titles and private extra fields', async () => {
  const page = { evaluate: async () => ({ ready_state: 'complete', top_level_visible_inputs: 2, top_level_visible_password_inputs: 0,
    top_level_visible_forms: 1, top_level_busy_indicators: 0, title: 'PRIVATE-TITLE', values: ['PRIVATE-CREDENTIAL'] }) };
  const state = await loginPageState(page);
  assert.equal(state.top_level_visible_inputs, 2);
  assert.equal(state.ready_state, 'complete');
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  const malformed = await loginPageState({ evaluate: async () => ({ ready_state: 'PRIVATE-TITLE', top_level_visible_inputs: 'PRIVATE-CREDENTIAL' }) });
  assert.equal(malformed.ready_state, 'unknown');
  assert.equal(malformed.top_level_visible_inputs, null);
});

test('unresponsive or inaccessible page state finishes with an unavailable observation without printing private errors', async () => {
  assert.deepEqual(await loginPageState({ evaluate: async () => { throw new Error('PRIVATE-PAGE-URL'); } }), { observation: 'unavailable' });
  assert.deepEqual(await loginPageState({ evaluate: () => new Promise(() => {}) }, { timeoutMs: 5 }), { observation: 'unavailable' });
});
