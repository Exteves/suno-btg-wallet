import { AppError } from './errors.js';
import { scopedUrl } from './policy.js';

export function localCdpEndpoint(value) {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error();
    return url.origin;
  } catch { throw new AppError('CDP_ENDPOINT_INVALID'); }
}

// Used only to open an isolated incognito window before the user logs in.
// No credentials, page contents or protocol messages are logged or saved.
export async function createManualLogin(endpoint, loginUrl, { fetchImpl = fetch, Socket = WebSocket } = {}) {
  const base = localCdpEndpoint(endpoint);
  let socket;
  let timer;
  const pending = new Map();
  try {
    const response = await fetchImpl(`${base}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error();
    const info = await response.json();
    const ws = new URL(info.webSocketDebuggerUrl);
    if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || ws.port !== new URL(base).port
      || !ws.pathname.startsWith('/devtools/browser/') || ws.search || ws.hash || ws.username || ws.password) throw new Error();
    socket = new Socket(ws.href);
    await new Promise((resolve, reject) => {
      timer = setTimeout(reject, 3000);
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    clearTimeout(timer);
    let nextId = 0;
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error()); else entry.resolve(message.result);
      } catch { /* Never print raw protocol payloads. */ }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error()); }, 3000);
      pending.set(id, { resolve, reject, timer: timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
    await send('Target.createTarget', { url: loginUrl, browserContextId, newWindow: true });
  } catch { throw new AppError('CDP_CONNECTION_FAILED'); }
  finally {
    clearTimeout(timer);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new AppError('CDP_CONNECTION_FAILED')); }
    pending.clear();
    socket?.close();
  }
}

export function selectCatalogTarget(targets, privateContexts, config) {
  const catalog = targets.filter(target => target.type === 'page' && scopedUrl(target.url, config));
  const candidates = catalog.filter(target => privateContexts.includes(target.browserContextId));
  if (!candidates.length) throw new AppError(catalog.length ? 'CDP_PRIVATE_CONTEXT_REQUIRED' : 'CDP_CATALOG_REQUIRED');
  if (candidates.length !== 1) throw new AppError('CDP_MULTIPLE_CATALOGS');
  return candidates[0];
}

export function transferCookies(cookies) {
  return cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return domain === 'btgpactual.com' || domain.endsWith('.btgpactual.com');
  }).map(cookie => {
    const result = Object.fromEntries(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure'].map(key => [key, cookie[key]]));
    result.sameSite = cookie.sameSite || 'Lax';
    if (cookie.partitionKey) {
      // First-party authentication must not silently inherit a partitioned cookie
      // with semantics this transfer cannot represent.
      throw new AppError('SESSION_MEMORY_TRANSFER_FAILED');
    }
    return result;
  });
}

export async function attachCatalog(chromium, endpoint, config) {
  const address = localCdpEndpoint(endpoint);
  if (config.provider !== 'btg') throw new AppError('CLI_USAGE');
  let browser;
  try {
    browser = await chromium.connectOverCDP(address, { timeout: 10000, noDefaults: true });
    const root = await browser.newBrowserCDPSession();
    const { browserContextIds } = await root.send('Target.getBrowserContexts');
    const { targetInfos } = await root.send('Target.getTargets');
    const target = selectCatalogTarget(targetInfos, browserContextIds, config);
    let selected;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const session = await context.newCDPSession(page);
        try {
          const info = await session.send('Target.getTargetInfo');
          if (info.targetInfo.targetId === target.targetId) selected = page;
        } finally { await session.detach(); }
      }
    }
    if (!selected) throw new AppError('CDP_CATALOG_REQUIRED');
    const captureState = async () => {
      // CDP attaches unknown pre-existing incognito contexts through Playwright's
      // default context wrapper. Always use the real CDP context ID for cookies.
      const { cookies } = await root.send('Storage.getCookies', { browserContextId: target.browserContextId });
      const origin = new URL(config.baseUrl).origin;
      const localStorage = await selected.evaluate(expectedOrigin => {
        if (location.origin !== expectedOrigin) throw new Error();
        return Object.entries(window.localStorage).map(([name, value]) => ({ name, value }));
      }, origin);
      // Do not call storageState() on CDP's shared default wrapper: it may include
      // unrelated profiles/origins. This path transfers only the selected page's
      // first-party cookies, localStorage and (in collectionContext) sessionStorage.
      return { cookies: transferCookies(cookies), origins: [{ origin, localStorage }] };
    };
    return { browser, page: selected, context: selected.context(), captureState };
  } catch (error) {
    // For a CDP connection, close disconnects the client, not the external Chrome.
    await browser?.close().catch(() => {});
    if (error instanceof AppError) throw error;
    throw new AppError('CDP_CONNECTION_FAILED');
  }
}
