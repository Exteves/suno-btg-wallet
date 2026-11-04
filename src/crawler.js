import { createHash } from 'node:crypto';
import { extract, assertReadable, settle } from './extract.js';
import { scopedUrl, sourceKind, installReadOnlyGuard, unsafeControlLabel, fold, discoverCatalogRoute, collectionPolicy } from './policy.js';
import { scrollRenderedPage, walkProgressiveList, watchCollectionLoads } from './scroll.js';

function errorCode(error) {
  return ['CONTENT_ROOT_MISSING', 'AUTH_OR_SCOPE_REDIRECT', 'LOGIN_REQUIRED', 'ACCESS_CHALLENGE', 'APPLICATION_LOAD_ERROR', 'API_AUTHENTICATION_REQUIRED'].includes(error.code)
    ? error.code : error.name === 'TimeoutError' ? 'TIMEOUT' : 'PAGE_COLLECTION_FAILED';
}

export async function collect({ page, config, store, purpose, onProgress = () => {} }) {
  config = collectionPolicy(config);
  const runId = store.start(purpose, config);
  const queue = [];
  const queued = new Set();
  const stats = { pagesCaptured: 0, pagesFailed: 0, snapshots: 0, issues: 0, blockedRequests: 0, walletsDiscovered: 0 };
  if (config.provider === 'btg') { stats.productObservations = 0; stats.distinctProductRecords = 0; stats.pageResults = []; }
  let currentResult = null;
  let currentPageNumber = 0;
  let loads;
  let currentPageId = null;
  const issue = (code, detail = '') => {
    stats.issues++;
    store.issue(runId, currentPageId, code, detail);
  };
  const enqueue = (raw, base = config.baseUrl) => {
    const url = scopedUrl(raw, config, base);
    if (url && !queued.has(url)) {
      if (sourceKind(url, config) === 'suno_wallet_area' && new URL(url).pathname !== config.walletsPath) stats.walletsDiscovered++;
      queued.add(url);
      queue.push(url);
    }
  };
  // A transferred session starts on about:blank. Configured starting routes
  // must be resolved against the site, independent of the current page URL.
  const seeds = config.seedPaths || [config.portfolioPath, config.walletsPath];
  for (const path of seeds) enqueue(path);
  const seenBlocked = new Set();
  const detailsSeen = new Set();
  const warningsSeen = new Set();
  let activeCategory = null;
  const issueOnce = (code, detail = '') => {
    const key = `${currentPageId}:${code}`;
    if (!warningsSeen.has(key)) { warningsSeen.add(key); issue(code, detail); }
  };
  async function assertCollectionReadable() {
    const checkAuthorization = () => {
      if (loads?.requiresAuthentication()) throw Object.assign(new Error('API_AUTHENTICATION_REQUIRED'), { code: 'API_AUTHENTICATION_REQUIRED' });
    };
    checkAuthorization();
    try { await assertReadable(page, config); }
    catch (error) { checkAuthorization(); throw error; }
    checkAuthorization();
  }

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
    return scrollRenderedPage(page, config, { reset });
  }

  async function capture(view, paginationIndex) {
    const result = await walkProgressiveList({
      config,
      scroll: options => scrollRenderedPage(page, config, options),
      wait: milliseconds => page.waitForTimeout(milliseconds),
      isLoading: () => loads?.isLoading() || false,
      onProgress: progress => {
        const records = config.provider === 'btg' ? store.db.prepare('SELECT count(DISTINCT c.fingerprint) n FROM catalog_products c JOIN snapshots s ON s.id=c.snapshot_id WHERE s.page_id=?').get(currentPageId).n : undefined;
        onProgress({ phase: 'scroll', runId, page: currentPageNumber, queued: queue.length,
          distinctProductRecords: records, pendingRequests: loads?.pendingCount() || 0, ...progress });
      },
      capture: async () => {
        await assertCollectionReadable();
        const data = await extract(page, config);
        if (data.unidentifiedTables?.length) issueOnce('PRODUCT_TABLE_TITLES_UNRESOLVED', data.unidentifiedTables);
        if (!data.text.trim() && !data.tables.some(table => table.rows.length) && !data.productBlocks.length) {
          throw Object.assign(new Error('CONTENT_ROOT_MISSING'), { code: 'CONTENT_ROOT_MISSING' });
        }
        if (config.followDiscoveredLinks !== false) for (const link of data.links) enqueue(link.url, page.url());
        const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        if (store.save(currentPageId, view, paginationIndex, data, config.recordMappings, config)) stats.snapshots++;
        await captureDetails(view, paginationIndex, data);
        return { data, fingerprint };
      },
    });
    if (currentResult && (!currentResult.scrollCompletion || currentResult.scrollCompletion === 'end_observed')) {
      currentResult.scrollCompletion = result.reason;
    }
    const warnings = { container_unconfirmed: 'SCROLL_CONTAINER_UNCONFIRMED', scroll_stalled: 'NESTED_SCROLL_OR_VIRTUALIZATION',
      step_limit: 'SCROLL_LIMIT_REACHED', time_limit: 'SCROLL_TIME_LIMIT_REACHED', loading_stalled: 'SCROLL_LOADING_STALLED' };
    if (warnings[result.reason]) issueOnce(warnings[result.reason], result.state || '');
    if (currentResult && result.state) currentResult.scrollState = result.state;
    if (currentResult) {
      currentResult.scrollSteps = (currentResult.scrollSteps || 0) + result.steps;
      currentResult.scrollElapsedMs = (currentResult.scrollElapsedMs || 0) + result.elapsedMs;
    }
    return result.data;
  }

  async function clickReadControl(selector, kind, categoryLabel = null) {
    const locator = typeof selector === 'string' ? page.locator(selector).first() : selector.first();
    if (!await locator.count() || !await locator.isVisible() || !await locator.isEnabled()) return false;
    const info = await locator.evaluate(el => ({
      tag: el.tagName, role: el.getAttribute('role'), type: el.type, inForm: !!el.closest('form'),
      href: el.getAttribute('href'), label: (el.innerText || el.getAttribute('aria-label') || '').trim(),
      disabled: el.getAttribute('aria-disabled') === 'true',
    }));
    if (info.disabled) return false;
    if (categoryLabel && fold(info.label) !== fold(categoryLabel)) return false;
    if (unsafeControlLabel(info.label)
      || info.type === 'submit' || info.inForm
      || (info.href && !scopedUrl(info.href, config, page.url())
        && !discoverCatalogRoute(new URL(info.href, page.url()).href, categoryLabel || '', config))) {
      issue('UNSAFE_CONTROL_REFUSED', kind);
      return false;
    }
    activeCategory = categoryLabel;
    try {
      await locator.click();
      if (!await settle(page, config)) issue('CONTENT_NOT_STABLE', kind);
      // Angular category tiles may navigate through a click handler rather
      // than an anchor. Admit only the same restricted catalog route shapes
      // already used for discovered category links.
      if (categoryLabel) {
        const path = discoverCatalogRoute(page.url(), categoryLabel, config);
        if (path && !config.scopePaths.includes(path)) config.scopePaths.push(path);
      }
      await assertCollectionReadable();
    } finally { activeCategory = null; }
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
      const controls = await page.locator(config.contentSelector).first().evaluate((root, { buttons, names }) => {
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const controls = [...root.querySelectorAll(buttons ? '[role=tab],button,[role=button]' : '[role=tab]')]
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .map(el => ({ role: el.getAttribute('role') || 'button', label: (el.innerText || el.getAttribute('aria-label') || '').trim() }));
        if (!buttons) return controls;
        const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        for (const el of root.querySelectorAll('*')) {
          if (!visible(el) || el.closest('form,nav,header,[data-private]')) continue;
          const label = (el.innerText || '').trim();
          if (!names.some(name => normalize(name) === normalize(label))) continue;
          if ([...el.children].some(child => visible(child) && (child.innerText || '').trim() === label)) continue;
          if (controls.some(control => normalize(control.label) === normalize(label))) continue;
          // Native roles are not always present on the category tiles. Require
          // an actual interactive ancestor/cursor, not just a heading.
          if (!el.closest('a,button,[role=button],[role=tab],[tabindex],[routerlink],[data-href],[onclick]')
            && getComputedStyle(el).cursor !== 'pointer') continue;
          const segments = [];
          for (let node = el; node && node !== root; node = node.parentElement) {
            segments.unshift(`:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`);
          }
          controls.push({ role: 'category-text', label, selector: `:scope > ${segments.join(' > ')}` });
        }
        return controls;
      }, { buttons: config.autoCategoryButtons, names: config.categoryTabNames });
      const recognized = control => config.categoryTabNames.some(name => fold(name) === fold(control.label.replace(/\s*\(\d+\)$/, '')));
      if (controls.some(control => control.role === 'tab' && !unsafeControlLabel(control.label) && !recognized(control))) issueOnce('UNCONFIGURED_TABS', 'Há abas com nomes não reconhecidos; configure views ou categoryTabNames.');
      return controls.filter(control => !unsafeControlLabel(control.label) && recognized(control));
    };
    const key = control => `${control.role}:${control.label}`;
    const roots = await discover();
    if (!roots.length && config.provider === 'btg') issueOnce('CATALOG_CATEGORIES_NOT_FOUND', 'Não foram encontrados controles de categorias reconhecidos nesta página.');
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
        const locator = control.selector ? page.locator(config.contentSelector).first().locator(control.selector)
          : page.getByRole(control.role, { name: control.label, exact: true });
        if (!await clickReadControl(locator, 'category', control.label)) { available = false; break; }
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
    if (!queue.length) {
      stats.failureReason = 'INITIAL_URLS_REJECTED';
      issue('INITIAL_URLS_REJECTED', { configuredSeeds: seeds.length });
      store.finish(runId, 'failed', stats);
      return { runId, status: 'failed', ...stats };
    }
    await installReadOnlyGuard(page.context(), config, (path, metadata) => {
      stats.blockedRequests++;
      const key = JSON.stringify([currentPageId, path, metadata]);
      if (!seenBlocked.has(key)) {
        seenBlocked.add(key);
        const detail = { path, ...metadata };
        issue('REQUEST_BLOCKED_READ_ONLY', detail);
        if (currentResult && path.startsWith('/investments/')) (currentResult.blockedRequestTypes ||= []).push(detail);
      }
    }, () => activeCategory);
    loads = watchCollectionLoads(page, config, (code, detail) => {
      const key = JSON.stringify([currentPageId, code, detail]);
      if (!seenBlocked.has(key)) {
        seenBlocked.add(key);
        issue(code, detail);
        if (currentResult) (currentResult.dataRequestFailures ||= []).push({ code, ...detail });
      }
    });
    if (!config.layoutVerified) issue('LAYOUT_NOT_VERIFIED', 'Seletores e cobertura ainda precisam de validação no site autenticado.');
    let processed = 0;
    while (queue.length && processed < config.maxPages) {
      const url = queue.shift();
      processed++;
      currentPageNumber = processed;
      currentPageId = store.page(runId, url, sourceKind(url, config));
      currentResult = config.provider === 'btg' ? { url, status: 'running', snapshots: 0, productObservations: 0, distinctProductRecords: 0, scrollCompletion: null } : null;
      if (currentResult) stats.pageResults.push(currentResult);
      onProgress({ phase: 'page_start', runId, page: processed, queued: queue.length });
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
        if (response && !response.ok()) { issue('HTTP_ERROR', { status: response.status() }); throw new Error('HTTP_ERROR'); }
        await assertCollectionReadable();
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
        if (tabs && !config.views.length && !config.autoTabs && config.followDiscoveredLinks !== false) issue('UNCONFIGURED_TABS', 'Configure views para percorrer as abas de consulta.');
        const nested = await page.locator(config.contentSelector).first().evaluate(root => [...root.querySelectorAll('*')].some(el => {
          const style = getComputedStyle(el);
          return el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(style.overflowY);
        }));
        if (nested && !config.scrollContainerSelector && !config.autoScrollContainer) issue('NESTED_SCROLL_OR_VIRTUALIZATION');
        store.pageStatus(currentPageId, 'captured');
        stats.pagesCaptured++;
        if (currentResult) currentResult.status = 'captured';
      } catch (error) {
        stats.pagesFailed++;
        const code = loads?.requiresAuthentication() ? 'API_AUTHENTICATION_REQUIRED' : errorCode(error);
        store.pageStatus(currentPageId, 'failed', code);
        issue(code);
        if (currentResult) { currentResult.status = 'failed'; currentResult.error = code; }
        if (code === 'API_AUTHENTICATION_REQUIRED') {
          stats.failureReason = code;
          stats.reauthenticationRequired = true;
        }
        if (['LOGIN_REQUIRED', 'AUTH_OR_SCOPE_REDIRECT', 'ACCESS_CHALLENGE', 'API_AUTHENTICATION_REQUIRED'].includes(code)) {
          issue('COLLECTION_STOPPED_AUTH_OR_ACCESS');
          break;
        }
      } finally {
        if (currentResult) {
          const counts = store.db.prepare('SELECT count(*) observations,count(DISTINCT c.fingerprint) distinct_records FROM catalog_products c JOIN snapshots s ON s.id=c.snapshot_id WHERE s.page_id=?').get(currentPageId);
          currentResult.snapshots = store.db.prepare('SELECT count(*) n FROM snapshots WHERE page_id=?').get(currentPageId).n;
          currentResult.productObservations = counts.observations;
          currentResult.distinctProductRecords = counts.distinct_records;
          if (currentResult.status === 'captured' && !counts.observations) {
            currentResult.status = 'no_products';
            issue('NO_PRODUCTS_ON_PAGE');
          } else if (currentResult.status === 'captured' && currentResult.scrollCompletion !== 'end_observed') {
            currentResult.status = 'partial';
          }
          onProgress({ phase: 'page_end', runId, page: processed, queued: queue.length, status: currentResult.status,
            distinctProductRecords: currentResult.distinctProductRecords, scrollCompletion: currentResult.scrollCompletion, error: currentResult.error });
        }
      }
    }
    if (queue.length) { stats.pagesNotVisited = queue.length; issue('PAGES_NOT_VISITED', { count: queue.length }); }
    if (config.provider === 'btg') {
      stats.productObservations = store.db.prepare('SELECT count(*) n FROM catalog_observations WHERE run_id=?').get(runId).n;
      stats.distinctProductRecords = store.db.prepare('SELECT count(DISTINCT fingerprint) n FROM catalog_observations WHERE run_id=?').get(runId).n;
      const categories = store.db.prepare('SELECT DISTINCT category FROM catalog_observations WHERE run_id=?').all(runId).map(row => row.category);
      if (!stats.reauthenticationRequired) {
        if (!stats.productObservations) issue('NO_PRODUCTS_IDENTIFIED', 'Os dados renderizados foram preservados, mas produtos precisam de identificação por cabeçalhos/cards.');
        for (const category of config.expectedCategories || []) if (!categories.includes(category)) issue('CATEGORY_NOT_CONFIRMED', category);
        if (categories.includes('unknown')) issue('PRODUCT_CATEGORY_UNKNOWN');
        issue('CATALOG_VISIBILITY_LIMIT', 'A coleta cobre somente o que o BTG exibe a este login; disponibilidade para compra e completude de catálogo não foram verificadas.');
      }
    } else if (!stats.walletsDiscovered) issue('NO_WALLET_DETAILS_DISCOVERED', 'A rota e os seletores de carteiras podem precisar de ajuste; nenhuma carteira detalhada foi confirmada.');
    const status = stats.snapshots === 0 ? 'failed' : stats.issues ? 'partial' : 'captured';
    store.finish(runId, status, stats);
    return { runId, status, ...stats };
  } catch (error) {
    issue('COLLECTION_INTERRUPTED');
    store.finish(runId, stats.snapshots ? 'partial' : 'failed', stats);
    throw error;
  } finally {
    loads?.detach();
  }
}
