const networkCodes = new Set([
  'ERR_NAME_NOT_RESOLVED', 'ERR_DNS_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_BLOCKED_BY_CLIENT',
  'ERR_FAILED', 'ERR_ABORTED', 'ERR_INTERNET_DISCONNECTED',
]);
const resourceTypes = new Set(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other']);

export function startupErrorCode(value, fallback) {
  const text = typeof value === 'string' ? value.slice(0, 4096) : '';
  if (/blocked by CORS|CORS policy|Access-Control-Allow-Origin|Cross-Origin Request Blocked/i.test(text)) return 'CORS_ERROR';
  if (/Content Security Policy|Content-Security-Policy|violates.*(?:script-src|connect-src|frame-src)/i.test(text)) return 'CONTENT_SECURITY_POLICY_ERROR';
  if (/MIME type|strict MIME type checking/i.test(text)) return 'SCRIPT_MIME_TYPE_ERROR';
  if (/ChunkLoadError|Loading (?:CSS )?chunk.*failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Failed to load module script/i.test(text)) return 'SCRIPT_MODULE_LOAD_ERROR';
  if (/(?:service\s*worker).*(?:error|failed|denied)|(?:error|failed|denied).*(?:service\s*worker)/i.test(text)) return 'SERVICE_WORKER_ERROR';
  if (/QuotaExceededError|(?:localStorage|sessionStorage|IndexedDB).*(?:denied|not allowed|not available)|(?:denied|not allowed|not available).*(?:localStorage|sessionStorage|IndexedDB)/i.test(text)) return 'BROWSER_STORAGE_ERROR';
  if (/unsupported browser|browser is not supported|navegador n[aã]o suportado/i.test(text)) return 'UNSUPPORTED_BROWSER_MESSAGE';
  if (/\bTypeError\b|Cannot read properties of (?:undefined|null)|is not a function/.test(text)) return 'JAVASCRIPT_TYPE_ERROR';
  if (/\bReferenceError\b/.test(text)) return 'JAVASCRIPT_REFERENCE_ERROR';
  if (/\bSyntaxError\b/.test(text)) return 'JAVASCRIPT_SYNTAX_ERROR';
  const network = text.match(/\bERR_[A-Z_]+\b/);
  if (networkCodes.has(network?.[0])) return network[0];
  if (/Failed to load resource:.*(?:status of|HTTP)/i.test(text)) return 'RESOURCE_HTTP_ERROR';
  return fallback;
}

export async function loginPageState(page, { timeoutMs = 2000 } = {}) {
  let timer;
  try {
    const state = await Promise.race([
      page.evaluate(() => {
        const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const inputs = [...document.querySelectorAll('input:not([type=hidden])')].filter(visible);
        return { ready_state: document.readyState, top_level_visible_inputs: inputs.length,
          top_level_visible_password_inputs: inputs.filter(el => el.type === 'password').length,
          top_level_visible_forms: [...document.querySelectorAll('form')].filter(visible).length,
          top_level_busy_indicators: [...document.querySelectorAll('[aria-busy=true],[role=progressbar]')].filter(visible).length };
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), timeoutMs); }),
    ]);
    const count = value => Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
    return { observation: 'available', ready_state: ['loading', 'interactive', 'complete'].includes(state.ready_state) ? state.ready_state : 'unknown',
      top_level_visible_inputs: count(state.top_level_visible_inputs),
      top_level_visible_password_inputs: count(state.top_level_visible_password_inputs),
      top_level_visible_forms: count(state.top_level_visible_forms),
      top_level_busy_indicators: count(state.top_level_busy_indicators) };
  } catch { return { observation: 'unavailable' }; }
  finally { clearTimeout(timer); }
}

// Only aggregate fixed codes and counts. Never retain URLs, headers, bodies,
// cookies, console messages, exception stacks or page text.
export function loginDiagnostics(context, { baseUrl, provider, classifyStartupErrors = false } = {}) {
  const counters = new Map();
  const pageHandlers = new Map();
  let pageState;
  let applicationOrigin;
  try { if (baseUrl) applicationOrigin = new URL(baseUrl).origin; } catch {}
  const providerDomain = provider === 'btg' ? 'btgpactual.com' : provider === 'suno' ? 'suno.com.br' : null;
  const originScope = request => {
    if (!applicationOrigin) return 'unknown';
    try {
      // Inspect the address only to derive a fixed category. Never retain it.
      const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return 'unknown';
      if (url.origin === applicationOrigin) return 'application';
      if (providerDomain && (url.hostname === providerDomain || url.hostname.endsWith(`.${providerDomain}`))) return 'provider';
      return 'external';
    } catch { return 'unknown'; }
  };
  const count = (event, code, resource = 'other', origin = 'unknown') => {
    const type = resourceTypes.has(resource) ? resource : 'other';
    const key = `${event}:${code}:${type}:${origin}`;
    const entry = counters.get(key) || { event, code, resource_type: type, origin_scope: origin, count: 0 };
    entry.count++;
    if (counters.size < 100 || counters.has(key)) counters.set(key, entry);
  };
  const failed = request => {
    const match = String(request.failure()?.errorText || '').match(/\bERR_[A-Z_]+\b/);
    count('request_failed', networkCodes.has(match?.[0]) ? match[0] : 'NETWORK_ERROR', request.resourceType(), originScope(request));
  };
  const response = result => {
    const status = result.status();
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      const request = result.request();
      count('http_error', status, request.resourceType(), originScope(request));
    }
  };
  const attachPage = page => {
    if (pageHandlers.has(page)) return;
    const error = value => {
      let code = 'PAGE_SCRIPT_ERROR';
      if (classifyStartupErrors) { try { code = startupErrorCode(value?.message, code); } catch {} }
      count('javascript_error', code, 'script');
    };
    const consoleError = message => {
      if (message.type() !== 'error') return;
      let code = 'BROWSER_CONSOLE_ERROR';
      if (classifyStartupErrors) { try { code = startupErrorCode(message.text(), code); } catch {} }
      count('console_error', code);
    };
    page.on('pageerror', error);
    page.on('console', consoleError);
    pageHandlers.set(page, { error, consoleError });
  };
  context.on('requestfailed', failed);
  context.on('response', response);
  context.on('page', attachPage);
  for (const page of context.pages()) attachPage(page);
  return {
    observePage: async page => { pageState = await loginPageState(page); },
    summary: () => ({ type: 'login_load_diagnostic', diagnostic_version: 2, events: [...counters.values()],
      ...(pageState ? { page_state: pageState } : {}),
      note: 'Contagens de falhas; não comprovam sozinhas a causa. URLs, credenciais e conteúdo não foram registrados.' }),
    detach() {
      context.off('requestfailed', failed);
      context.off('response', response);
      context.off('page', attachPage);
      for (const [page, handlers] of pageHandlers) { page.off('pageerror', handlers.error); page.off('console', handlers.consoleError); }
      pageHandlers.clear();
    },
  };
}
