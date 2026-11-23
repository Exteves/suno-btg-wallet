import { setTimeout as sleep } from 'node:timers/promises';
import { maySend, safeReadUrl, unsafeControlLabel } from '../policy.js';
import { diagnosticPath, redact } from '../privacy.js';
import { scopeOf } from './normalize.js';
import { classifyEndpoint, storedUrl, paginationOf, nextPageUrl, bulkUrl, CUMULATIVE_KINDS, GATEWAY_HOST } from './endpoints.js';

const LOGIN_HOST = 'login.suno.com.br';
// POSTs the application needs to render, none of which changes the account:
// token refresh, and the CPF-modal flag check. Without the latter the SPA
// redirects every wallet route to /error (verified 2026-11-23).
const ALLOWED_POSTS = new Set(['/api/v1/user/refresh-token', '/api/v1/user/show-update-cpf']);
// Headers replayed on pagination GETs, kept in memory only for this run.
const replayHeaderNames = new Set(['x-auth', 'accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent']);

export const SECTION_KINDS = {
  relatorios: ['report'], carteiras: ['wallet_asset', 'wallet_group'], cobertura: ['coverage'], fundos: ['fund'],
};

function guardConfig(config) {
  return {
    provider: 'suno', baseUrl: config.baseUrl, queryKeys: [], readOnlyGraphqlPaths: [],
    scopePaths: config.sections.map(section => section.path),
  };
}

// Read-only: GET/HEAD/OPTIONS under the general deny policy, plus the session
// token refresh the application performs itself. Everything else is aborted.
export async function installGuard(context, config, onBlock) {
  const policy = guardConfig(config);
  await context.route('**/*', async route => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.hostname === GATEWAY_HOST && !url.search && ALLOWED_POSTS.has(url.pathname)) return route.fallback();
    } catch { /* falls through to the policy */ }
    if (maySend(request, policy)) return route.fallback();
    onBlock(diagnosticPath(request.url()), request.method(), request.resourceType());
    return route.abort('blockedbyclient');
  });
}

// Playwright body/header reads can stall when the page navigates away.
const within = (promise, ms, fallback) => Promise.race([promise.catch(() => fallback), sleep(ms).then(() => fallback)]);

export class ResponseRecorder {
  constructor({ store, full = false }) {
    this.store = store;
    this.full = full;
    this.enabled = false;
    this.route = null;
    this.pending = new Set();
    this.lastActivity = Date.now();
    this.authorizedOk = 0;
    this.authFailures = 0;
    this.series = new Map();
    this.stats = { stored: 0, items: 0, failed: 0, ignored: 0 };
    this.ingestions = [];
  }

  attach(page) {
    page.on('request', request => {
      if (this.isGateway(request)) { this.pending.add(request); this.lastActivity = Date.now(); }
    });
    const done = request => { if (this.pending.delete(request)) this.lastActivity = Date.now(); };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    page.on('response', response => { this.ingestions.push(this.onResponse(response).catch(() => { this.stats.failed++; })); });
  }

  isGateway(request) {
    try { return ['xhr', 'fetch'].includes(request.resourceType()) && new URL(request.url()).hostname === GATEWAY_HOST; }
    catch { return false; }
  }

  async onResponse(response) {
    const request = response.request();
    if (!this.isGateway(request)) return;
    const status = response.status();
    const method = request.method();
    // Proof of an authorized session: an authenticated gateway call succeeded.
    const hasAuth = !!(await within(request.headerValue('x-auth'), 5000, null));
    if (hasAuth && status >= 200 && status < 300) this.authorizedOk++;
    if (hasAuth && status === 401) this.authFailures++;
    if (!this.enabled || method === 'OPTIONS') return;
    const classified = classifyEndpoint(request.url(), method);
    if (classified.decision !== 'stored') {
      if (classified.shape) this.store.inventory(classified.shape, method, classified.decision, status);
      this.stats.ignored++;
      return;
    }
    if (status < 200 || status >= 300) { this.store.inventory(classified.shape, method, 'http_error', status); return; }
    let body;
    try { body = await within(response.json(), 20000, undefined); } catch { body = undefined; }
    if (body === undefined) { this.store.inventory(classified.shape, method, 'body_unavailable', status); return; }
    const result = this.store.ingest({ classified, url: storedUrl(request.url()), body, status, route: this.route, via: 'page' });
    this.stats.stored++;
    this.stats.items += result.itemCount;
    const info = paginationOf(request.url());
    if (info) {
      const headers = Object.fromEntries(Object.entries(await within(request.allHeaders(), 5000, {}))
        .filter(([name]) => replayHeaderNames.has(name.toLowerCase())));
      const current = this.series.get(info.seriesKey);
      if (!current) {
        this.series.set(info.seriesKey, { url: request.url(), info, headers, classified, lastCount: result.itemCount,
          keys: new Set(result.keys), fresh: result.freshKeys.length, route: this.route, done: false, total: result.total,
          firstPosition: info.position });
      } else {
        result.keys.forEach(key => current.keys.add(key));
        current.headers = headers;
        current.fresh += result.freshKeys.length;
        current.total ??= result.total;
        current.firstPosition = Math.min(current.firstPosition, info.position);
        if (info.position > current.info.position) Object.assign(current, { url: request.url(), info, lastCount: result.itemCount });
      }
    }
  }

  async flush() {
    while (this.ingestions.length) await within(Promise.all(this.ingestions.splice(0)), 30000, null);
  }

  // Waits until the page's gateway reads are quiet, bounded by a timeout.
  async settle(page, { quietMs, timeoutMs }) {
    const start = Date.now();
    // The quiet window starts now, so requests the page is about to send count.
    this.lastActivity = Math.max(this.lastActivity, start);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    while (Date.now() - start < timeoutMs) {
      if (!this.pending.size && Date.now() - this.lastActivity >= quietMs) break;
      await sleep(250);
    }
    await this.flush();
    return !this.pending.size;
  }
}

export function onLoginPage(page) {
  try {
    const url = new URL(page.url());
    return url.hostname === LOGIN_HOST || /^\/(?:login|entrar)(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

// Waits for an authorized gateway response or for the login redirect.
export async function checkAuthenticated(page, recorder, config) {
  const before = recorder.authorizedOk;
  try {
    await page.goto(new URL(config.authCheckPath, config.baseUrl).href, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
  } catch { /* A redirect to login can interrupt the navigation. */ }
  const start = Date.now();
  while (Date.now() - start < config.authTimeoutMs) {
    if (onLoginPage(page)) return false;
    if (recorder.authorizedOk > before && new URL(page.url()).hostname === new URL(config.baseUrl).hostname) return true;
    await sleep(500);
  }
  return false;
}

async function clickTabs(page, config, recorder) {
  let clicked = 0;
  const tried = new Set();
  for (let round = 0; round < config.maxTabsPerPage; round++) {
    const tabs = page.locator('[role=tab]:visible');
    const count = Math.min(await tabs.count().catch(() => 0), 40);
    let target = null;
    for (let index = 0; index < count; index++) {
      const tab = tabs.nth(index);
      const label = ((await tab.innerText().catch(() => '')) || '').trim().slice(0, 80);
      const key = `${index}:${label}`;
      if (tried.has(key) || !label || unsafeControlLabel(label)) continue;
      if ((await tab.getAttribute('aria-selected').catch(() => null)) === 'true') { tried.add(key); continue; }
      if (await tab.evaluate(el => !!el.closest('a[href]') || el.tagName === 'A').catch(() => true)) { tried.add(key); continue; }
      target = { tab, key };
      break;
    }
    if (!target) break;
    tried.add(target.key);
    try {
      await target.tab.click({ timeout: 5000 });
      clicked++;
      await recorder.settle(page, { quietMs: config.settleQuietMs, timeoutMs: config.settleTimeoutMs });
    } catch { /* Tabs that cannot be clicked do not stop the page. */ }
  }
  return clicked;
}

async function discoverLinks(page, config, prefix, exclude) {
  const hrefs = await page.$$eval('a[href]', anchors => anchors.map(a => a.href)).catch(() => []);
  const policy = { baseUrl: config.baseUrl, queryKeys: [] };
  const out = new Set();
  for (const href of hrefs) {
    const safe = safeReadUrl(href.split('#')[0], policy);
    if (!safe) continue;
    const path = new URL(safe).pathname.replace(/\/+$/, '');
    if (!path.startsWith(prefix) || path === prefix.replace(/\/+$/, '') || exclude.has(path)) continue;
    if (path.split('/').filter(Boolean).length > config.maxLinkDepth) continue;
    out.add(path);
  }
  return [...out].sort();
}

async function pageText(page) {
  return page.evaluate(() => {
    const root = document.querySelector('main, [role=main]') || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,template,form,input,textarea,select,nav,header,footer,[role=dialog],[data-private]').forEach(node => node.remove());
    return { title: document.title, text: (clone.innerText || clone.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() };
  }).catch(() => null);
}

async function paginate(fetchPage, recorder, store, config, issue) {
  const summary = { series: 0, requests: 0, capped: 0 };
  for (const series of recorder.series.values()) {
    if (series.done) continue;
    series.done = true;
    summary.series++;
    const kind = series.classified.kind;
    const max = config.pagination.maxPagesPerSeries[kind] ?? config.pagination.maxPagesPerSeries.default;
    const cumulative = CUMULATIVE_KINDS.has(kind);
    // Already-known cumulative lists stop as soon as a page brings nothing new.
    const scopeKey = kind === 'report' ? 'all' : scopeOf(series.classified);
    const filtered = kind === 'report';  // report totals are per filter, not per catalog
    if (cumulative && !recorder.full && series.fresh === 0
      && (filtered || !series.total || store.knownCount(kind, scopeKey) >= series.total)) continue;
    let { url, info, lastCount } = series;
    let pages = 0;
    const get = async (target, template, { quiet = false } = {}) => {
      await sleep(config.pagination.delayMs);
      let response;
      try {
        response = await fetchPage(target, { headers: series.headers, failOnStatusCode: false, timeout: config.navigationTimeoutMs, maxRedirects: 0 });
      } catch { issue('PAGINATION_REQUEST_FAILED', { template }); return null; }
      summary.requests++;
      const status = response.status();
      if (status === 401 || status === 403) { recorder.authFailures++; issue('PAGINATION_UNAUTHORIZED', { template, status }); return null; }
      if (status < 200 || status >= 300) { if (!quiet) issue('PAGINATION_HTTP_ERROR', { template, status }); return null; }
      let body;
      try { body = await response.json(); } catch { issue('PAGINATION_NOT_JSON', { template }); return null; }
      const result = store.ingest({ classified: classifyEndpoint(target, 'GET'), url: storedUrl(target), body, status, route: series.route, via: 'pagination' });
      recorder.stats.stored++;
      recorder.stats.items += result.itemCount;
      return result;
    };
    // Some lists ignore the page parameter past the second page (wallet
    // events, verified 2026-11-23) but honour a larger size: ask once for all.
    const total = series.total;
    if (total && total > Math.max(series.keys.size, cumulative && !filtered ? store.knownCount(kind, scopeKey) : 0)
      && total <= config.pagination.maxBulkItems) {
      const target = bulkUrl(url, info, total, info.pageKey ? Math.min(series.firstPosition, 1) : 0);
      const classified = classifyEndpoint(target, 'GET');
      if (classified.decision === 'stored' && classified.kind === kind) {
        // A rejected size (e.g. HTTP 400) falls back to walking the pages.
        const result = await get(target, classified.template, { quiet: true });
        result?.keys.forEach(key => series.keys.add(key));
        if (series.keys.size >= total) continue;
      }
    }
    while (true) {
      if (lastCount === 0) break;
      if (pages >= max) { summary.capped++; issue('PAGINATION_LIMIT', { template: series.classified.template, pages }); break; }
      const next = nextPageUrl(url, info, lastCount);
      const classified = classifyEndpoint(next, 'GET');
      if (classified.decision !== 'stored' || classified.kind !== kind) break;
      const result = await get(next, classified.template);
      pages++;
      if (!result || !result.itemCount) break;
      // The API ignored the position parameter: same items again.
      if (result.keys.every(key => series.keys.has(key))) break;
      result.keys.forEach(key => series.keys.add(key));
      if (cumulative && !recorder.full && !result.freshKeys.length) break;
      url = next;
      info = paginationOf(next);
      lastCount = result.itemCount;
    }
    // Daily lists must be whole; cumulative ones may stop early by design.
    const known = cumulative && !filtered ? store.knownCount(kind, scopeKey) : series.keys.size;
    // Reports stop early once nothing is new; they are checked against the catalog instead.
    if (total && (!filtered || recorder.full) && Math.max(known, series.keys.size) < total)
      issue('PAGINATION_INCOMPLETE', { template: series.classified.template, collected: Math.max(known, series.keys.size), total });
  }
  return summary;
}

export async function collectSuno({ context, page, config, store, recorder, onProgress = () => {},
  fetchPage = (url, options) => context.request.get(url, options) }) {
  const stats = { pages: 0, pagesFailed: 0, tabsClicked: 0, blocked: 0, pagination: { series: 0, requests: 0, capped: 0 }, sections: {} };
  const issue = (code, detail) => store.issue(code, detail);
  await installGuard(context, config, (shape, method) => { stats.blocked++; store.inventory(shape, method, 'blocked', null); });
  recorder.enabled = true;
  const visited = new Set();
  for (const section of config.sections) {
    const queue = [section.path];
    const sectionStart = { ...store.counts() };
    const authStart = { ok: recorder.authorizedOk, failed: recorder.authFailures };
    let discovered = 0;
    while (queue.length) {
      const route = queue.shift();
      if (visited.has(route)) continue;
      visited.add(route);
      if (stats.pages >= config.maxPages) { issue('PAGE_LIMIT', { route }); break; }
      stats.pages++;
      onProgress({ section: section.name, route, page: stats.pages });
      const pageId = store.page(section.name, route);
      recorder.route = route;
      const before = recorder.stats.stored;
      try {
        await page.goto(new URL(route, config.baseUrl).href, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
        await recorder.settle(page, { quietMs: config.settleQuietMs, timeoutMs: config.settleTimeoutMs });
        if (onLoginPage(page)) throw Object.assign(new Error(), { code: 'LOGIN_REQUIRED' });
        const finalRoute = new URL(page.url()).pathname;
        const tabs = await clickTabs(page, config, recorder);
        stats.tabsClicked += tabs;
        const text = await pageText(page);
        if (text?.text) {
          const hash = store.blob(JSON.stringify({ title: redact(text.title), text: redact(text.text) }));
          store.db.prepare('INSERT OR IGNORE INTO page_texts(page_id, text_hash) VALUES (?, ?)').run(pageId, hash);
        }
        if (section.discoverPrefix && discovered < config.maxDiscoveredPerSection) {
          const exclude = new Set(config.sections.map(s => s.path.replace(/\/+$/, '')));
          for (const path of await discoverLinks(page, config, section.discoverPrefix, exclude)) {
            if (!visited.has(path) && !queue.includes(path) && discovered < config.maxDiscoveredPerSection) { queue.push(path); discovered++; }
          }
        }
        store.pageDone(pageId, { status: finalRoute.replace(/\/+$/, '') === route.replace(/\/+$/, '') ? 'captured' : 'redirected',
          finalRoute, tabsClicked: tabs, responses: recorder.stats.stored - before });
        if (finalRoute.replace(/\/+$/, '') !== route.replace(/\/+$/, '')) issue('PAGE_REDIRECTED', { route, finalRoute });
      } catch (error) {
        stats.pagesFailed++;
        const code = error.code === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : error.name === 'TimeoutError' ? 'TIMEOUT' : 'PAGE_FAILED';
        store.pageDone(pageId, { status: 'failed', errorCode: code, responses: recorder.stats.stored - before });
        issue(code, { route });
        if (code === 'LOGIN_REQUIRED') { recorder.authFailures++; return { stats, authLost: true }; }
      }
    }
    // Paginate right after the section, while its request headers are fresh.
    const result = await paginate(fetchPage, recorder, store, config, issue);
    for (const key of Object.keys(result)) stats.pagination[key] += result[key];
    const after = store.counts();
    const kinds = SECTION_KINDS[section.name] || [];
    const gained = Object.fromEntries(Object.entries(after).map(([kind, n]) => [kind, n - (sectionStart[kind] || 0)]).filter(([, n]) => n > 0));
    stats.sections[section.name] = { responses: gained, discovered };
    if (kinds.length && !kinds.some(kind => gained[kind])) issue('SECTION_WITHOUT_DATA', { section: section.name, expected: kinds });
    // 401s followed by successful authorized reads mean the app refreshed its token.
    if (recorder.authFailures > authStart.failed && recorder.authorizedOk === authStart.ok) {
      issue('AUTHORIZATION_FAILED', { section: section.name });
      return { stats, authLost: true };
    }
  }
  return { stats, authLost: false };
}
