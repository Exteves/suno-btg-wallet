import { maySend, requestOriginScope } from './policy.js';
import { diagnosticPath, scrubRequestDiagnostic } from './privacy.js';

export async function scrollRenderedPage(page, config, { reset = false, advance = false } = {}) {
  return page.evaluate(({ config, reset, advance }) => {
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const root = [...document.querySelectorAll(config.contentSelector)].find(visible);
    if (!root) return { missing: true };
    const documentScroller = document.scrollingElement;
    let target = config.scrollContainerSelector ? document.querySelector(config.scrollContainerSelector) : null;
    if (config.scrollContainerSelector && (!target || !visible(target))) return { missing: true };
    if (!target && config.autoScrollContainer) {
      // The list can scroll inside main, or inside an ancestor of main, even
      // when the document itself also has a scrollbar.
      const ancestors = [];
      for (let el = root.parentElement; el; el = el.parentElement) ancestors.push(el);
      const candidates = [...new Set([root, ...root.querySelectorAll('*'), ...ancestors])].filter(el =>
        el !== documentScroller && visible(el) && el.clientHeight > 40
        && el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY));
      const productSelector = `table,[role=table],[role=grid],${config.cardSelector}`;
      const withProducts = candidates.filter(el => el.matches(productSelector) || el.querySelector(productSelector));
      const pool = withProducts.length ? withProducts : candidates;
      const innermost = pool.filter(el => !pool.some(other => el !== other && el.contains(other)));
      if (innermost.length > 1) return { ambiguous: true };
      target = innermost[0] || null;
    }
    const isDocument = !target || target === documentScroller;
    target ||= documentScroller;
    const before = target.scrollTop;
    const viewport = isDocument ? innerHeight : target.clientHeight;
    if (reset || advance) {
      const top = reset ? 0 : before + Math.max(1, Math.floor(viewport * 0.7));
      // scrollTop assignments inherit CSS smooth scrolling. Use an immediate
      // move so observing the same position does not misclassify an animation.
      if (isDocument) window.scrollTo({ top, behavior: 'instant' });
      else target.scrollTo({ top, behavior: 'instant' });
    }
    const busyIndicators = [...root.querySelectorAll('[aria-busy=true],[role=progressbar],[data-loading=true]')].filter(el => {
      if (!visible(el)) return false;
      if (el.getAttribute('aria-busy') === 'true' || el.getAttribute('data-loading') === 'true') return true;
      const value = el.getAttribute('aria-valuenow');
      const maximum = el.getAttribute('aria-valuemax') ?? '100';
      return value === null || !Number.isFinite(Number(value)) || !Number.isFinite(Number(maximum)) || Number(value) < Number(maximum);
    }).length;
    const busy = busyIndicators > 0
      || root.getAttribute('aria-busy') === 'true' || target.getAttribute('aria-busy') === 'true';
    return { before, after: target.scrollTop, height: target.scrollHeight, viewport, busy, busyIndicators,
      target: isDocument ? 'document' : `${target.tagName.toLowerCase()}:${[...document.querySelectorAll('*')].indexOf(target)}` };
  }, { config, reset, advance });
}

// Track only allowed first-party data reads, in memory. Analytics POSTs and
// aborted writes must not keep the list waiting forever. No payload is retained.
export function watchCollectionLoads(page, config, onFailure = () => {}) {
  const pending = new Set();
  const catalogPending = new Set();
  const unauthorized = new Set();
  const origin = new URL(config.baseUrl);
  const start = request => {
    try {
      const url = new URL(request.url());
      const providerHost = config.provider === 'btg' && (url.hostname === 'btgpactual.com' || url.hostname.endsWith('.btgpactual.com'));
      if (['xhr', 'fetch'].includes(request.resourceType()) && (url.origin === origin.origin || providerHost) && maySend(request, config)) {
        pending.add(request);
        if (config.provider !== 'btg' || /^\/investments\/api\/(?:fixed-income|government-bond|treasury|fund-subscription|product-management)(?:\/|$)/.test(url.pathname)) catalogPending.add(request);
      }
    } catch { /* Unclassifiable requests cannot contribute to readiness. */ }
  };
  const finish = request => { pending.delete(request); catalogPending.delete(request); };
  const diagnostic = request => ({ path: diagnosticPath(request.url()), method: request.method(),
    resource_type: request.resourceType(), origin_scope: requestOriginScope(request, config) });
  const response = response => {
    const request = response.request();
    const status = response.status();
    if (pending.has(request) && config.provider === 'btg') {
      const path = new URL(request.url()).pathname;
      if (/^\/investments\/api\/(?:fixed-income|government-bond|treasury|fund-subscription|product-management)(?:\/|$)/.test(path)) {
        const key = `${request.method()}:${diagnosticPath(path)}`;
        if (status === 401) unauthorized.add(key);
        else if (status >= 200 && status < 300) unauthorized.delete(key);
      }
    }
    if (pending.has(request) && status >= 400) onFailure('DATA_REQUEST_HTTP_ERROR', scrubRequestDiagnostic({ ...diagnostic(request), status }));
  };
  const failed = request => {
    if (pending.has(request)) {
      const match = request.failure?.()?.errorText?.match(/ERR_[A-Z_]+/)?.[0];
      const detail = scrubRequestDiagnostic({ ...diagnostic(request), failure: match });
      detail.failure ||= 'NETWORK_ERROR';
      onFailure('DATA_REQUEST_FAILED', detail);
    }
    finish(request);
  };
  page.on('request', start);
  page.on('requestfinished', finish);
  page.on('requestfailed', failed);
  page.on('response', response);
  return { isLoading: () => catalogPending.size > 0, pendingCount: () => catalogPending.size,
    requiresAuthentication: () => unauthorized.size > 0, detach: () => {
    page.off('request', start);
    page.off('requestfinished', finish);
    page.off('requestfailed', failed);
    page.off('response', response);
    pending.clear();
    catalogPending.clear();
    unauthorized.clear();
  } };
}

// Capture the initial viewport and every subsequent rendered window. A list's
// height alone is insufficient: virtualized lists can replace rows in place.
export async function walkProgressiveList({ capture, scroll, wait, isLoading = () => false, now = Date.now, config, onProgress = () => {} }) {
  const started = now();
  let sample = await capture();
  let previous = null;
  let quietSince = null;
  let bottomSamples = 0;
  let stalledSamples = 0;
  let lastChange = started;
  let lastProgress = -Infinity;
  const finish = (reason, steps, state) => ({ reason, data: sample.data, steps, elapsedMs: now() - started, ...(state ? { state } : {}) });
  for (let step = 0; step < config.maxScrollSteps; step++) {
    if (now() - started >= config.maxScrollDurationMs) return finish('time_limit', step);
    const movement = await scroll({ advance: true });
    if (movement.missing || movement.ambiguous) return finish('container_unconfirmed', step, movement);
    await wait(config.settleMs);
    sample = await capture();
    const state = await scroll({});
    if (state.missing || state.ambiguous) return finish('container_unconfirmed', step + 1, state);
    const bottom = state.after + state.viewport >= state.height - 2;
    // The DOM index used to describe a target can change when unrelated nodes
    // are inserted. It is diagnostic metadata, not evidence of list progress.
    const signature = JSON.stringify([sample.fingerprint, state.after, state.height, state.viewport]);
    if (signature !== previous) lastChange = now();
    const loading = isLoading();
    const elapsedMs = now() - started;
    const unchangedMs = now() - lastChange;
    if (now() - lastProgress >= (config.progressIntervalMs ?? 10000)) {
      lastProgress = now();
      onProgress({ step: step + 1, elapsedMs, unchangedMs, atBottom: bottom, busy: !!state.busy,
        waitingForRequests: loading, position: state.after, height: state.height, viewport: state.viewport });
    }
    if (bottom && !state.busy && !loading) {
      if (signature !== previous || quietSince === null) { quietSince = now(); bottomSamples = 1; }
      else bottomSamples++;
      if (bottomSamples >= config.scrollBottomSamples && now() - quietSince >= config.scrollIdleMs) {
        return finish('end_observed', step + 1);
      }
    } else { quietSince = null; bottomSamples = 0; }
    if (unchangedMs >= (config.scrollNoProgressMs ?? 45000)) {
      return finish(state.busy || loading ? 'loading_stalled' : 'scroll_stalled', step + 1, { ...state, waitingForRequests: loading, unchangedMs });
    }
    if (!bottom && movement.before === state.after && state.height === movement.height
      && state.target === movement.target && !state.busy && !loading) {
      stalledSamples = signature === previous ? stalledSamples + 1 : 1;
      if (stalledSamples >= config.scrollBottomSamples) return finish('scroll_stalled', step + 1, state);
    } else stalledSamples = 0;
    previous = signature;
  }
  return finish('step_limit', config.maxScrollSteps);
}
