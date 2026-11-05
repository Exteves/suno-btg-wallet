import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { walkProgressiveList, watchCollectionLoads, scrollConfigForPage, walkWithRecovery } from '../src/scroll.js';
import { loadConfig } from '../src/config.js';
import { collectionPolicy } from '../src/policy.js';

const options = { maxScrollSteps: 100, settleMs: 100, scrollIdleMs: 500, scrollBottomSamples: 3, maxScrollDurationMs: 10000 };

test('progressive traversal waits for slow data and saves newly revealed rows before stopping at a quiet bottom', async () => {
  let time = 0;
  let top = 0;
  let rows = 3;
  let due = null;
  let loaded = false;
  const saved = new Set();
  const state = () => ({ after: top, height: rows * 100, viewport: 200, target: 'list' });
  const result = await walkProgressiveList({
    config: options, now: () => time, isLoading: () => due !== null,
    capture: async () => {
      for (let id = 0; id < rows; id++) saved.add(id);
      return { fingerprint: String(rows), data: { rows } };
    },
    scroll: async ({ advance }) => {
      const before = top;
      if (advance) {
        top = Math.min(top + 140, rows * 100 - 200);
        if (!loaded && due === null && top + 200 >= rows * 100) due = time + 2000;
      }
      return { before, ...state() };
    },
    wait: async ms => {
      time += ms;
      if (due !== null && time >= due) { rows = 8; loaded = true; due = null; }
    },
  });
  assert.equal(result.reason, 'end_observed');
  assert.equal(saved.size, 8);
  assert.equal(result.data.rows, 8);
  assert.ok(time >= 2500); // No cutoff after the first few unchanged samples.
});

test('virtualized rows are captured at each scroll position even when the scroll height never grows', async () => {
  let time = 0;
  let top = 0;
  const windows = [];
  const result = await walkProgressiveList({
    config: options, now: () => time,
    capture: async () => { windows.push(top); return { fingerprint: `window:${top}`, data: top }; },
    scroll: async ({ advance }) => {
      const before = top;
      if (advance) top = Math.min(top + 140, 800);
      return { before, after: top, height: 1000, viewport: 200, target: 'list' };
    },
    wait: async ms => { time += ms; },
  });
  assert.equal(result.reason, 'end_observed');
  assert.equal(windows[0], 0);
  assert.ok(windows.includes(140));
  assert.ok(windows.includes(700));
  assert.equal(windows.at(-1), 800);
});

test('scroll-height growth restarts the bottom observation period even before new text appears', async () => {
  let time = 0;
  let height = 200;
  let top = 0;
  const result = await walkProgressiveList({
    config: options, now: () => time,
    capture: async () => ({ fingerprint: 'unchanged-content', data: height }),
    scroll: async ({ advance }) => {
      const before = top;
      if (advance) top = height - 200;
      return { before, after: top, height, viewport: 200, target: 'list' };
    },
    wait: async ms => { time += ms; if (time >= 400) height = 300; },
  });
  assert.equal(result.reason, 'end_observed');
  assert.ok(time >= 1000);
});

test('time, step, missing-container and stalled-scroll limits never report a completed list', async () => {
  for (const expected of ['time_limit', 'step_limit', 'container_unconfirmed', 'scroll_stalled']) {
    let time = 0;
    const config = { ...options, maxScrollSteps: expected === 'step_limit' ? 2 : 100, maxScrollDurationMs: expected === 'scroll_stalled' ? 1000 : 300 };
    const result = await walkProgressiveList({
      config, now: () => time,
      capture: async () => ({ fingerprint: expected === 'scroll_stalled' ? 'unchanged' : String(time), data: time }),
      scroll: async () => expected === 'container_unconfirmed' ? { ambiguous: true }
        : { before: 0, after: 0, height: expected === 'scroll_stalled' ? 1000 : 100, viewport: 100, target: 'list', busy: expected !== 'scroll_stalled' },
      wait: async ms => { time += ms; },
    });
    assert.equal(result.reason, expected);
  }
});

test('loading indicators prevent premature completion even without a tracked request', async () => {
  let time = 0;
  const result = await walkProgressiveList({
    config: options, now: () => time,
    capture: async () => ({ fingerprint: 'same', data: null }),
    scroll: async () => ({ before: 0, after: 0, height: 100, viewport: 100, target: 'list', busy: time < 1500 }),
    wait: async ms => { time += ms; },
  });
  assert.equal(result.reason, 'end_observed');
  assert.ok(time >= 2000);
});

test('only allowed first-party data requests affect readiness; listeners and pending state are released', async () => {
  const config = collectionPolicy(await loadConfig('btg.config.json'));
  const page = new EventEmitter();
  const watcher = watchCollectionLoads(page, config);
  const request = (url, method = 'GET', resource = 'fetch') => ({ method: () => method, url: () => url, resourceType: () => resource });
  for (const blocked of [request('https://external.test/data'), request(`${config.baseUrl}/collect`, 'POST'),
    request(`${config.baseUrl}/api/account/12345/status`), request(`${config.baseUrl}/style.css`, 'GET', 'stylesheet')]) page.emit('request', blocked);
  assert.equal(watcher.isLoading(), false);
  const read = request(`${config.baseUrl}/investments/api/fixed-income/accounts/TEST-ACCOUNT/fixedincomes`);
  page.emit('request', read);
  assert.equal(watcher.isLoading(), true);
  page.emit('requestfailed', read);
  assert.equal(watcher.isLoading(), false);
  page.emit('request', read);
  page.emit('requestfinished', read);
  assert.equal(watcher.isLoading(), false);
  page.emit('request', read);
  watcher.detach();
  assert.equal(watcher.isLoading(), false);
  for (const event of ['request', 'requestfinished', 'requestfailed', 'response', 'framenavigated']) assert.equal(page.listenerCount(event), 0);
});

test('observed movement after an initially unchanged scroll position is not classified as stalled', async () => {
  let time = 0;
  let top = 0;
  let next = 0;
  const result = await walkProgressiveList({
    config: options, now: () => time,
    capture: async () => ({ fingerprint: `window:${top}`, data: top }),
    scroll: async ({ advance }) => {
      const before = top;
      if (advance) next = Math.min(top + 140, 800);
      return { before, after: top, height: 1000, viewport: 200, target: 'list' };
    },
    wait: async ms => { time += ms; top = next; },
  });
  assert.equal(result.reason, 'end_observed');
  assert.equal(result.data, 800);
});

test('allowed data errors report only sanitized paths, HTTP status and fixed failure codes', async () => {
  const config = collectionPolicy(await loadConfig('btg.config.json'));
  const page = new EventEmitter();
  const errors = [];
  const watcher = watchCollectionLoads(page, config, (code, detail) => errors.push({ code, ...detail }));
  const read = { method: () => 'GET', resourceType: () => 'fetch', isNavigationRequest: () => false,
    url: () => `${config.baseUrl}/investments/api/fixed-income/accounts/PRIVATE-ACCOUNT/fixedincomes?token=PRIVATE-TOKEN`,
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET https://private.test/PRIVATE-CONTENT' }) };
  page.emit('request', read);
  assert.equal(watcher.isLoading(), true);
  page.emit('response', { request: () => read, status: () => 403, text: () => { throw new Error('must not read response bodies'); } });
  page.emit('requestfailed', read);
  assert.equal(errors[0].code, 'DATA_REQUEST_HTTP_ERROR');
  assert.equal(errors[0].status, 403);
  assert.equal(errors[0].path, '/investments/api/fixed-income/accounts/[REMOVIDO]/fixedincomes');
  assert.equal(errors[1].failure, 'ERR_CONNECTION_RESET');
  assert.equal(watcher.isLoading(), false);
  assert.ok(!JSON.stringify(errors).includes('PRIVATE'));
  watcher.detach();
});

test('only catalog API 401s require authentication; success on that read clears it and 403 is kept separate', async () => {
  const config = collectionPolicy(await loadConfig('btg.config.json'));
  const page = new EventEmitter();
  const watcher = watchCollectionLoads(page, config);
  const request = path => ({ method: () => 'GET', resourceType: () => 'fetch', isNavigationRequest: () => false,
    url: () => `${config.baseUrl}${path}` });
  const catalog = request('/investments/api/government-bond/account/TEST-ACCOUNT');
  const background = request('/api/ping');
  page.emit('request', background);
  page.emit('response', { request: () => background, status: () => 401 });
  assert.equal(watcher.requiresAuthentication(), false);
  page.emit('request', catalog);
  page.emit('response', { request: () => catalog, status: () => 403 });
  assert.equal(watcher.requiresAuthentication(), false);
  page.emit('response', { request: () => catalog, status: () => 401 });
  page.emit('requestfinished', catalog);
  assert.equal(watcher.requiresAuthentication(), true);
  page.emit('request', catalog);
  page.emit('response', { request: () => catalog, status: () => 200 });
  assert.equal(watcher.requiresAuthentication(), false);
  watcher.detach();
});

test('an unchanged list with perpetual loading stops as partial after the inactivity bound and emits periodic progress', async () => {
  for (const busy of [true, false]) {
    let time = 0;
    const progress = [];
    let captures = 0;
    const result = await walkProgressiveList({
      config: { ...options, scrollNoProgressMs: 1000, progressIntervalMs: 200 }, now: () => time,
      isLoading: () => !busy,
      capture: async () => { captures++; return { fingerprint: 'same-list', data: 'saved-window' }; },
      scroll: async () => ({ before: 0, after: 0, height: 100, viewport: 100, target: 'list', busy }),
      wait: async ms => { time += ms; }, onProgress: report => progress.push(report),
    });
    assert.equal(result.reason, 'loading_stalled');
    assert.equal(result.data, 'saved-window');
    assert.ok(result.elapsedMs < options.maxScrollDurationMs);
    assert.ok(result.state.unchangedMs >= 1000);
    assert.ok(captures > 1);
    assert.ok(progress.length >= 5);
    assert.ok(progress.every(report => report.busy === busy && report.waitingForRequests === !busy));
    assert.ok(!JSON.stringify(progress).includes('saved-window'));
  }
});

test('unrelated first-party background reads do not prevent list completion', async () => {
  const config = collectionPolicy(await loadConfig('btg.config.json'));
  const page = new EventEmitter();
  const watcher = watchCollectionLoads(page, config);
  const read = path => ({ method: () => 'GET', resourceType: () => 'fetch', url: () => `${config.baseUrl}${path}` });
  page.emit('request', read('/api/telemetry/poll'));
  assert.equal(watcher.isLoading(), false);
  assert.equal(watcher.pendingCount(), 0);
  const catalog = read('/investments/api/government-bond/account/TEST-ACCOUNT');
  page.emit('request', catalog);
  assert.equal(watcher.isLoading(), true);
  assert.equal(watcher.pendingCount(), 1);
  page.emit('requestfinished', catalog);
  assert.equal(watcher.isLoading(), false);
  watcher.detach();
});

test('changing a diagnostic DOM index alone does not keep a stable list alive', async () => {
  let time = 0;
  const result = await walkProgressiveList({
    config: options, now: () => time,
    capture: async () => ({ fingerprint: 'same-list', data: null }),
    scroll: async () => ({ before: 0, after: 0, height: 100, viewport: 100, target: `div:${time}` }),
    wait: async ms => { time += ms; },
  });
  assert.equal(result.reason, 'end_observed');
  assert.ok(time < 1000);
});

test('new data resets the inactivity bound, so a slowly revealing list can continue to the overall limit', async () => {
  let time = 0;
  const result = await walkProgressiveList({
    config: { ...options, scrollNoProgressMs: 1000, maxScrollDurationMs: 3000 }, now: () => time,
    capture: async () => ({ fingerprint: `batch:${Math.floor(time / 900)}`, data: Math.floor(time / 900) }),
    scroll: async () => ({ before: 0, after: 0, height: 100, viewport: 100, target: 'list', busy: true }),
    wait: async ms => { time += ms; },
  });
  assert.equal(result.reason, 'time_limit');
  assert.equal(result.data, 3);
});

test('funds can finish after the old five-minute cutoff while the other lists retain their original budget', async () => {
  const config = await loadConfig('btg.config.json');
  const fundsUrl = `${config.baseUrl}/produtos-de-investimento/fundos-de-investimento`;
  const funds = scrollConfigForPage(config, fundsUrl);
  const credit = scrollConfigForPage(config, `${config.baseUrl}/produtos-de-investimento/renda-fixa/credito-bancario`);
  assert.equal(funds.maxScrollDurationMs, 900000);
  assert.equal(config.maxScrollDurationMs, 300000);
  assert.equal(credit.maxScrollDurationMs, 300000);
  assert.equal(funds.scrollNoProgressMs, config.scrollNoProgressMs);
  assert.equal(funds.maxScrollSteps, config.maxScrollSteps);
  for (const url of ['https://other.test/produtos-de-investimento/fundos-de-investimento',
    `${fundsUrl}/details`, `https://private@app.btgpactual.com/produtos-de-investimento/fundos-de-investimento`]) {
    assert.equal(scrollConfigForPage(config, url), config);
  }
  const simulate = async selected => {
    let time = 0;
    const limits = new Set();
    const result = await walkProgressiveList({
      config: selected, now: () => time,
      capture: async () => ({ fingerprint: `batch:${Math.floor(time / 30000)}`, data: Math.floor(time / 30000) }),
      scroll: async () => ({ before: 0, after: 0, height: 100, viewport: 100, target: 'list', busy: time < 400000 }),
      wait: async ms => { time += ms; }, onProgress: report => limits.add(report.timeLimitMs),
    });
    assert.deepEqual([...limits], [selected.maxScrollDurationMs]);
    return result;
  };
  const limited = await simulate(credit);
  assert.equal(limited.reason, 'time_limit');
  const completed = await simulate(funds);
  assert.equal(completed.reason, 'end_observed');
  assert.ok(completed.elapsedMs > config.maxScrollDurationMs);
  assert.ok(completed.elapsedMs < funds.maxScrollDurationMs);
});

test('pending reads expose sanitized age/stage and cannot leak from one document into the next', async () => {
  const config = collectionPolicy(await loadConfig('btg.config.json'));
  const page = new EventEmitter();
  let time = 100;
  const watcher = watchCollectionLoads(page, config, () => {}, { now: () => time });
  const read = () => ({ method: () => 'GET', resourceType: () => 'fetch', isNavigationRequest: () => false,
    url: () => `${config.baseUrl}/investments/api/government-bond/account/PRIVATE-ACCOUNT?token=PRIVATE-TOKEN` });
  const old = read();
  page.emit('request', old);
  time = 1100;
  assert.equal(watcher.pendingRequests()[0].ageMs, 1000);
  assert.equal(watcher.pendingRequests()[0].stage, 'awaiting_response');
  page.emit('response', { request: () => old, status: () => 200 });
  assert.equal(watcher.pendingRequests()[0].stage, 'receiving_body');
  assert.equal(watcher.pendingRequests()[0].status, 200);
  assert.ok(!JSON.stringify(watcher.pendingRequests()).includes('PRIVATE'));
  page.emit('framenavigated', { parentFrame: () => ({}) });
  assert.equal(watcher.pendingCount(), 1);
  page.emit('framenavigated', { parentFrame: () => null }); // Same-document SPA navigation has no document request.
  assert.equal(watcher.pendingCount(), 1);
  watcher.beginNavigation();
  page.emit('framenavigated', { parentFrame: () => null });
  assert.equal(watcher.pendingCount(), 0);
  const fresh = read();
  page.emit('request', fresh);
  page.emit('requestfinished', old);
  page.emit('response', { request: () => old, status: () => 401 });
  assert.equal(watcher.pendingCount(), 1);
  assert.equal(watcher.requiresAuthentication(), false);
  page.emit('response', { request: () => fresh, status: () => 401 });
  watcher.beginNavigation();
  page.emit('framenavigated', { parentFrame: () => null });
  assert.equal(watcher.requiresAuthentication(), true); // A reload alone is not renewed authentication.
  const authorized = read();
  page.emit('request', authorized);
  page.emit('response', { request: () => authorized, status: () => 200 });
  assert.equal(watcher.requiresAuthentication(), false);
  watcher.detach();
  assert.equal(page.listenerCount('framenavigated'), 0);
});

test('a stalled list gets one reload, retains captured windows and can finish within a shared budget', async () => {
  let time = 0;
  let recovered = false;
  let reloads = 0;
  const saved = new Set();
  const config = { ...options, scrollIdleMs: 200, scrollNoProgressMs: 500, maxScrollDurationMs: 5000,
    navigationTimeoutMs: 1000, scrollReloadAttempts: 1 };
  const budgets = [];
  const recoveries = [];
  const result = await walkWithRecovery({
    config, now: () => time,
    walk: (attemptConfig, offset) => {
      budgets.push({ duration: attemptConfig.maxScrollDurationMs, steps: attemptConfig.maxScrollSteps, offset });
      return walkProgressiveList({ config: attemptConfig, now: () => time, isLoading: () => !recovered,
        capture: async () => { const data = recovered ? 'final-window' : 'initial-window'; saved.add(data); return { data, fingerprint: data }; },
        scroll: async () => ({ before: 0, after: 0, height: 100, viewport: 100, target: 'list' }),
        wait: async ms => { time += ms; },
      });
    },
    onRecovery: event => recoveries.push(event.attempt),
    reload: async timeout => { assert.ok(timeout <= 1000); time += 200; reloads++; recovered = true; },
  });
  assert.equal(result.reason, 'end_observed');
  assert.equal(result.reloads, 1);
  assert.equal(reloads, 1);
  assert.deepEqual([...saved], ['initial-window', 'final-window']);
  assert.deepEqual(recoveries, [1]);
  assert.ok(budgets[1].duration < budgets[0].duration);
  assert.ok(budgets[1].steps < budgets[0].steps);
  assert.ok(budgets[1].offset.elapsedMs > 0);
  assert.equal(result.elapsedMs, time);
  assert.equal(config.maxScrollDurationMs, 5000);
});

test('recovery stays bounded, never resets the time budget, and propagates authorization failures', async () => {
  const config = { ...options, scrollIdleMs: 200, scrollNoProgressMs: 500, maxScrollDurationMs: 3000,
    navigationTimeoutMs: 1000, scrollReloadAttempts: 1 };
  for (const reloadDelay of [100, 3000]) {
    let time = 0;
    let reloads = 0;
    const result = await walkWithRecovery({
      config, now: () => time,
      walk: attemptConfig => walkProgressiveList({ config: attemptConfig, now: () => time, isLoading: () => true,
        capture: async () => ({ fingerprint: 'same-list', data: 'preserved' }),
        scroll: async () => ({ before: 0, after: 0, height: 100, viewport: 100, target: 'list' }),
        wait: async ms => { time += ms; },
      }),
      reload: async () => { time += reloadDelay; reloads++; },
    });
    assert.equal(reloads, 1);
    assert.equal(result.reloads, 1);
    assert.equal(result.reason, reloadDelay === 100 ? 'loading_stalled' : 'time_limit');
    assert.equal(result.data, 'preserved');
  }
  let reloads = 0;
  await assert.rejects(walkWithRecovery({ config,
    walk: async () => { throw Object.assign(new Error('API_AUTHENTICATION_REQUIRED'), { code: 'API_AUTHENTICATION_REQUIRED' }); },
    reload: async () => { reloads++; },
  }), error => error.code === 'API_AUTHENTICATION_REQUIRED');
  assert.equal(reloads, 0);
});
