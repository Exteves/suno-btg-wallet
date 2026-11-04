import { AppError } from './errors.js';

export function launchOptions({ browserPath, browserChannel } = {}) {
  if (browserPath && browserChannel) throw new AppError('CLI_USAGE');
  if (browserChannel && !['chromium', 'chrome', 'msedge'].includes(browserChannel)) throw new AppError('CLI_USAGE');
  return { headless: false,
    ...(browserPath ? { executablePath: browserPath } : {}),
    ...(browserChannel && browserChannel !== 'chromium' ? { channel: browserChannel } : {}),
  };
}

export function contextOptions(config, phase = 'collection') {
  if (!['authentication', 'collection'].includes(phase)) throw new AppError('CONFIG_INVALID');
  return {
    acceptDownloads: false,
    serviceWorkers: phase === 'authentication' ? config.authServiceWorkers || 'block' : 'block',
    locale: 'pt-BR', viewport: { width: 1440, height: 1000 },
  };
}

export async function collectionContext(browser, authContext, authPage, config, { captureState, closeAuthContext = true } = {}) {
  if (config.authServiceWorkers !== 'allow' && !captureState) return { context: authContext, page: authPage };
  let context;
  try {
    // No path: cookies, localStorage and IndexedDB are transferred in memory only.
    const state = captureState ? await captureState() : await authContext.storageState({ indexedDB: true });
    const origin = new URL(config.baseUrl).origin;
    const session = await authPage.evaluate(expectedOrigin => {
      if (location.origin !== expectedOrigin) throw new Error('origin mismatch');
      return Object.entries(sessionStorage);
    }, origin);
    context = await browser.newContext({ ...contextOptions(config, 'collection'), storageState: state });
    await context.addInitScript(({ origin, session }) => {
      if (location.origin !== origin) return;
      for (const [key, value] of session) {
        // Preserve tokens refreshed by the application on subsequent navigations.
        if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
      }
    }, { origin, session });
    const page = await context.newPage();
    // Closing authentication also stops its workers before collection starts.
    if (closeAuthContext) await authContext.close();
    return { context, page };
  } catch {
    await context?.close().catch(() => {});
    throw new AppError('SESSION_MEMORY_TRANSFER_FAILED');
  }
}
