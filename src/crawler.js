import { createHash } from 'node:crypto';
import { extract, assertReadable, settle } from './extract.js';
import { scopedUrl, sourceKind, installReadOnlyGuard, unsafeControlLabel, fold } from './policy.js';

function errorCode(error) {
  return ['CONTENT_ROOT_MISSING', 'AUTH_OR_SCOPE_REDIRECT', 'LOGIN_REQUIRED', 'ACCESS_CHALLENGE'].includes(error.code)
    ? error.code : error.name === 'TimeoutError' ? 'TIMEOUT' : 'PAGE_COLLECTION_FAILED';
}

export async function collect({ page, config, store, purpose, onProgress = () => {} }) {
  const runId = store.start(purpose, config);
  const queue = [];
  const queued = new Set();
  const stats = { pagesCaptured: 0, pagesFailed: 0, snapshots: 0, issues: 0, blockedRequests: 0, walletsDiscovered: 0 };
  let currentPageId = null;
  const issue = (code, detail = '') => {
    stats.issues++;
    store.issue(runId, currentPageId, code, detail);
  };
  const enqueue = raw => {
    const url = scopedUrl(raw, config, page.url());
    if (url && !queued.has(url)) {
      if (sourceKind(url, config) === 'suno_wallet_area' && new URL(url).pathname !== config.walletsPath) stats.walletsDiscovered++;
      queued.add(url);
      queue.push(url);
    }
  };
  for (const path of config.seedPaths || [config.portfolioPath, config.walletsPath]) enqueue(path);
  const seenBlocked = new Set();
  const detailsSeen = new Set();
  const warningsSeen = new Set();
  const issueOnce = (code, detail = '') => {
    const key = `${currentPageId}:${code}`;
    if (!warningsSeen.has(key)) { warningsSeen.add(key); issue(code, detail); }
  };

  async function captureDetails(view, paginationIndex, data) {
    if (config.provider !== 'btg') return;
    if (!config.detailButtonSelector) {
      if (data.readControls?.some(control => /^(?:ver |mais |consultar )?(?:detalhes|informacoes)(?: do produto)?$/i.test(fold(control.label)))) issueOnce('PRODUCT_DETAILS_NOT_EXPANDED', 'Configure os seletores de detalhes de consulta após inspecionar a página autenticada.');
      return;
    }
    const controls = page.locator(config.detailButtonSelector);
    const count = await controls.count();
    for (let index = 0; index < count; index++) {
      const control = controls.nth(index);
      if (!await control.isVisible()) continue;
      const identity = await control.evaluate(el => (el.closest('[data-product-id],tr,article,[role=row],[role=listitem]') || el).innerText);
      const key = `${currentPageId}:${view}:${createHash('sha256').update(identity).digest('hex')}`;
      if (detailsSeen.has(key)) continue;
      if (detailsSeen.size >= config.maxProductDetails) { issueOnce('PRODUCT_DETAILS_LIMIT_REACHED'); return; }
      detailsSeen.add(key);
      if (!await clickReadControl(control, 'product-detail')) continue;
      const detailConfig = { ...config, contentSelector: config.detailDialogSelector, readySelector: null };
      await page.locator(config.detailDialogSelector).first().waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
      await settle(page, detailConfig);
      const detail = await extract(page, detailConfig);
      if (store.save(currentPageId, `${view}:detail`, paginationIndex, detail, config.recordMappings, config)) stats.snapshots++;
      if (!await clickReadControl(config.detailCloseSelector, 'close-detail')) throw new Error('DETAIL_CLOSE_FAILED');
      await page.locator(config.detailDialogSelector).first().waitFor({ state: 'hidden', timeout: config.navigationTimeoutMs });
    }
  }

  async function scrollPage(reset = false) {
    return page.evaluate(({ config, reset }) => {
      const root = document.querySelector(config.contentSelector);
      let target = config.scrollContainerSelector ? document.querySelector(config.scrollContainerSelector) : null;
      if (config.scrollContainerSelector && !target) return { missing: true };
      let candidates = [];
      if (!target && config.autoScrollContainer && document.documentElement.scrollHeight <= innerHeight + 4) {
        candidates = [root, ...root.querySelectorAll('*')].filter(el => el && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY));
        if (candidates.length === 1) target = candidates[0];
      }
      const before = target ? target.scrollTop : scrollY;
      if (reset) { if (target) target.scrollTop = 0; else window.scrollTo(0, 0); }
      else if (target) target.scrollTop += Math.max(100, target.clientHeight * 0.75);
      else window.scrollBy(0, Math.max(300, innerHeight * 0.75));
      return { before, after: target ? target.scrollTop : scrollY,
        height: target ? target.scrollHeight : document.documentElement.scrollHeight,
        viewport: target ? target.clientHeight : innerHeight, ambiguous: candidates.length > 1 };
    }, { config, reset });
  }

  async function capture(view, paginationIndex) {
    const seen = new Set();
    let same = 0;
    let atBottom = false;
    for (let step = 0; step < config.maxScrollSteps; step++) {
      await assertReadable(page, config);
      const data = await extract(page, config);
      if (!data.text.trim()) throw Object.assign(new Error('CONTENT_ROOT_MISSING'), { code: 'CONTENT_ROOT_MISSING' });
      for (const link of data.links) enqueue(link.url);
      const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if (store.save(currentPageId, view, paginationIndex, data, config.recordMappings, config)) stats.snapshots++;
      await captureDetails(view, paginationIndex, data);
      if (seen.has(hash)) same++; else same = 0;
      seen.add(hash);
      const scroll = await scrollPage();
      if (scroll.missing || scroll.ambiguous) { issue('SCROLL_CONTAINER_UNCONFIRMED'); return data; }
      const bottom = scroll.after + scroll.viewport >= scroll.height - 2;
      // Two stable captures at the bottom allow delayed lazy loading to appear.
      if (bottom && atBottom && same >= 2) return data;
      atBottom = bottom;
      if (scroll.before === scroll.after && !bottom) {
        issue('NESTED_SCROLL_OR_VIRTUALIZATION', 'Há rolagem interna não percorrida automaticamente.');
        return data;
      }
      await page.waitForTimeout(config.settleMs);
    }
    issue('SCROLL_LIMIT_REACHED');
    return extract(page, config);
  }

  async function clickReadControl(selector, kind) {
    const locator = typeof selector === 'string' ? page.locator(selector).first() : selector.first();
    if (!await locator.count() || !await locator.isVisible() || !await locator.isEnabled()) return false;
    const info = await locator.evaluate(el => ({
      tag: el.tagName, role: el.getAttribute('role'), type: el.type, inForm: !!el.closest('form'),
      href: el.getAttribute('href'), label: (el.innerText || el.getAttribute('aria-label') || '').trim(),
      disabled: el.getAttribute('aria-disabled') === 'true',
    }));
    if (info.disabled) return false;
    if (unsafeControlLabel(info.label)
      || info.type === 'submit' || info.inForm
      || (info.href && !scopedUrl(info.href, config, page.url()))) {
      issue('UNSAFE_CONTROL_REFUSED', kind);
      return false;
    }
    await locator.click();
    if (!await settle(page, config)) issue('CONTENT_NOT_STABLE', kind);
    await assertReadable(page, config);
    return true;
  }

  async function collectView(name) {
    await scrollPage(true);
    const seen = new Set();
    for (let index = 0; index < config.maxPaginationPages; index++) {
      const data = await capture(name, index);
      const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if (seen.has(hash)) { issue('PAGINATION_DID_NOT_ADVANCE', name); return; }
      seen.add(hash);
      const selector = config.loadMoreSelector || config.nextSelector;
      if (!selector) {
        const candidates = await page.getByRole('button', { name: /^(?:pr[oó]xim[oa](?: p[aá]gina)?|next(?: page)?|carregar mais|ver mais)$/i }).count();
        if (candidates) issue('UNCONFIGURED_PAGINATION', 'Defina nextSelector ou loadMoreSelector depois de inspecionar o controle.');
        return;
      }
      if (index + 1 === config.maxPaginationPages) {
        const next = page.locator(selector).first();
        if (await next.count() && await next.isVisible() && await next.isEnabled() && await next.getAttribute('aria-disabled') !== 'true') issue('PAGINATION_LIMIT_REACHED', name);
        return;
      }
      if (!await clickReadControl(selector, 'pagination')) return;
      await scrollPage(true);
    }
  }

  async function autoViews(url) {
    const discover = async () => {
      const controls = await page.locator(config.contentSelector).first().evaluate((root, buttons) =>
        [...root.querySelectorAll(buttons ? '[role=tab],button,[role=button]' : '[role=tab]')]
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .map(el => ({ role: el.getAttribute('role') || 'button', label: (el.innerText || el.getAttribute('aria-label') || '').trim() })), config.autoCategoryButtons);
      const recognized = control => config.categoryTabNames.some(name => fold(name) === fold(control.label.replace(/\s*\(\d+\)$/, '')));
      if (controls.some(control => control.role === 'tab' && !unsafeControlLabel(control.label) && !recognized(control))) issueOnce('UNCONFIGURED_TABS', 'Há abas com nomes não reconhecidos; configure views ou categoryTabNames.');
      return controls.filter(control => !unsafeControlLabel(control.label) && recognized(control));
    };
    const key = control => `${control.role}:${control.label}`;
    const roots = await discover();
    const rootKeys = new Set(roots.map(key));
    const queue = roots.map(control => [control]);
    const visited = new Set();
    let count = 0;
    while (queue.length && count < config.maxTabs) {
      const trail = queue.shift();
      const trailKey = trail.map(key).join(' / ');
      if (visited.has(trailKey)) continue;
      visited.add(trailKey);
      count++;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
      await settle(page, config);
      let available = true;
      for (const control of trail) {
        if (!await clickReadControl(page.getByRole(control.role, { name: control.label, exact: true }), 'category')) { available = false; break; }
      }
      if (!available) { issue('CATEGORY_UNAVAILABLE', trailKey); continue; }
      const view = `auto:${trail.map(control => control.label).join(' / ')}`;
      await collectView(view);
      for (const child of await discover()) {
        if (!rootKeys.has(key(child)) && !trail.some(control => key(control) === key(child))) queue.push([...trail, child]);
      }
    }
    if (queue.length) issue('CATEGORY_LIMIT_REACHED');
  }

  try {
    await installReadOnlyGuard(page.context(), config, path => {
      stats.blockedRequests++;
      if (!seenBlocked.has(path)) {
        seenBlocked.add(path);
        issue('REQUEST_BLOCKED_READ_ONLY', path);
      }
    });
    if (!config.layoutVerified) issue('LAYOUT_NOT_VERIFIED', 'Seletores e cobertura ainda precisam de validação no site autenticado.');
    let processed = 0;
    while (queue.length && processed < config.maxPages) {
      const url = queue.shift();
      processed++;
      currentPageId = store.page(runId, url, sourceKind(url, config));
      onProgress({ runId, page: processed, queued: queue.length });
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
        if (response && !response.ok()) { issue('HTTP_ERROR', { status: response.status() }); throw new Error('HTTP_ERROR'); }
        await assertReadable(page, config);
        if (!await settle(page, config)) issue('CONTENT_NOT_STABLE');
        await collectView('default');
        for (const view of config.views) {
          if (view.pathPrefix && !new URL(url).pathname.startsWith(view.pathPrefix)) continue;
          // Each configured view starts from the original route so pagination cannot leak between tabs.
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
          await settle(page, config);
          if (await clickReadControl(view.selector, view.kind)) await collectView(view.name);
          else issue('VIEW_UNAVAILABLE', view.name);
        }
        if (config.autoTabs) await autoViews(url);
        const tabs = await page.locator('[role=tab][aria-selected=false]:visible').count();
        if (tabs && !config.views.length && !config.autoTabs) issue('UNCONFIGURED_TABS', 'Configure views para percorrer as abas de consulta.');
        const nested = await page.locator(config.contentSelector).first().evaluate(root => [...root.querySelectorAll('*')].some(el => {
          const style = getComputedStyle(el);
          return el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(style.overflowY);
        }));
        if (nested && !config.scrollContainerSelector && !config.autoScrollContainer) issue('NESTED_SCROLL_OR_VIRTUALIZATION');
        store.pageStatus(currentPageId, 'captured');
        stats.pagesCaptured++;
      } catch (error) {
        stats.pagesFailed++;
        const code = errorCode(error);
        store.pageStatus(currentPageId, 'failed', code);
        issue(code);
        if (['LOGIN_REQUIRED', 'AUTH_OR_SCOPE_REDIRECT', 'ACCESS_CHALLENGE'].includes(code)) {
          issue('COLLECTION_STOPPED_AUTH_OR_ACCESS');
          break;
        }
      }
    }
    if (queue.length) issue('PAGES_NOT_VISITED', { count: queue.length });
    if (config.provider === 'btg') {
      stats.productObservations = store.db.prepare('SELECT count(*) n FROM catalog_observations WHERE run_id=?').get(runId).n;
      const categories = store.db.prepare('SELECT DISTINCT category FROM catalog_observations WHERE run_id=?').all(runId).map(row => row.category);
      if (!stats.productObservations) issue('NO_PRODUCTS_IDENTIFIED', 'Os dados renderizados foram preservados, mas produtos precisam de identificação por cabeçalhos/cards.');
      for (const category of config.expectedCategories || []) if (!categories.includes(category)) issue('CATEGORY_NOT_CONFIRMED', category);
      if (categories.includes('unknown')) issue('PRODUCT_CATEGORY_UNKNOWN');
      issue('CATALOG_VISIBILITY_LIMIT', 'A coleta cobre somente o que o BTG exibe a este login; disponibilidade para compra e completude de catálogo não foram verificadas.');
    } else if (!stats.walletsDiscovered) issue('NO_WALLET_DETAILS_DISCOVERED', 'A rota e os seletores de carteiras podem precisar de ajuste; nenhuma carteira detalhada foi confirmada.');
    const status = stats.snapshots === 0 ? 'failed' : stats.issues ? 'partial' : 'captured';
    store.finish(runId, status, stats);
    return { runId, status, ...stats };
  } catch (error) {
    issue('COLLECTION_INTERRUPTED');
    store.finish(runId, stats.snapshots ? 'partial' : 'failed', stats);
    throw error;
  }
}
