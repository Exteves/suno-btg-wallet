import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { Store } from './database.js';
import { collect } from './crawler.js';
import { loadConfig } from './config.js';
import { privatePath } from './privacy.js';
import { SecretServiceKeyring } from './keyring.js';
import { SessionVault, filterSessionState } from './session-vault.js';
import { confirmAuthentication } from './auth.js';
import { AppError, classifyBrowserError, classifyNetworkError, publicError } from './errors.js';

process.umask(0o077);
let browser;
let store;
let terminal;
let shuttingDown = false;
const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  shuttingDown = true;
  cancellation.abort();
  terminal?.close();
  void browser?.close().catch(() => {});
});

try {
  const { values } = parseArgs({ options: {
    source: { type: 'string', default: 'suno' }, purpose: { type: 'string' }, config: { type: 'string' },
    db: { type: 'string', default: 'privado/suno.sqlite' },
    'browser-path': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    login: { type: 'boolean' }, 'no-session': { type: 'boolean' }, 'forget-session': { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Uso: npm run scrape -- --source suno|btg --purpose start|rebalance [--no-session] [--config arquivo.json] [--db privado/suno.sqlite] [--browser-path /caminho/chromium]');
    console.log('Login e sessão: npm run login | npm run session:forget. Diagnóstico: npm run doctor.');
  } else {
    if (!['suno', 'btg'].includes(values.source)) throw new AppError('CLI_USAGE');
    if (values.source === 'btg') {
      if (values.login || values['forget-session']) throw new AppError('CLI_USAGE');
      values['no-session'] = true;
      values.purpose ??= 'start';
    }
    if (values['forget-session'] && (values.login || values.purpose || values['no-session'])) throw new AppError('CLI_USAGE');
    if (!values['forget-session'] && !values.login && !['start', 'rebalance'].includes(values.purpose)) throw new AppError('CLI_USAGE');
    if (values.login && (values['no-session'] || values.purpose)) throw new AppError('CLI_USAGE');
    const persist = !values['no-session'];
    const keyring = new SecretServiceKeyring();
    const sessionPath = privatePath('privado/auth/suno.session.enc.json');
    if (values['forget-session']) {
      await new SessionVault(sessionPath, keyring).forget();
      console.log('Sessão local removida. Isso não revoga a sessão no servidor da Suno.');
    } else {
      let config;
      try {
        config = await loadConfig(values.config || `${values.source}.config.json`);
        if (config.provider !== values.source) throw new Error();
      } catch { throw new AppError('CONFIG_INVALID'); }
      const dbPath = privatePath(values.db);
      const vault = persist ? new SessionVault(sessionPath, keyring, { ttlMs: config.sessionTtlHours * 3600000 }) : null;
      // No fallback to plaintext, environment variables, or a key next to the vault.
      if (persist) await keyring.check();
      const restored = vault ? await vault.load() : { state: null, reason: 'disabled' };
      if (restored.reason === 'restored') console.log('Sessão descriptografada em memória. A validade será conferida no navegador.');
      if (restored.reason === 'expired') console.log('A sessão local expirou. Faça login novamente no navegador.');
      try {
        browser = await chromium.launch({ headless: false, executablePath: values['browser-path'] });
      } catch (error) { throw classifyBrowserError(error); }
      const context = await browser.newContext({
        storageState: restored.state || undefined,
        acceptDownloads: false, serviceWorkers: 'block', locale: 'pt-BR', viewport: { width: 1440, height: 1000 },
      });
      // No persistent profile, plaintext state file, tracing, videos, screenshots, HAR, or body logging.
      const page = await context.newPage();
      page.on('dialog', dialog => dialog.dismiss());
      try {
        const response = await page.goto(new URL(config.entryPath, config.baseUrl).href, {
          waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs,
        });
        if (response && !response.ok()) throw new AppError('HTTP_ERROR');
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw classifyNetworkError(error);
      }
      await confirmAuthentication(page, config, async () => {
        if (!stdin.isTTY) throw new AppError('SESSION_LOGIN_REQUIRED');
        console.log(values.source === 'btg'
          ? 'Faça login e MFA diretamente no BTG e abra Produtos de investimento. A sessão do BTG será temporária, sem exportar cookies ou tokens.'
          : 'Confira Portfólio no navegador. Se solicitado, faça login e MFA diretamente nele. Não envie senha ou códigos ao terminal.');
        terminal = createInterface({ input: stdin, output: stdout });
        await terminal.question('Com a página autenticada carregada, pressione Enter: ', { signal: cancellation.signal });
        terminal.close();
      });
      if (shuttingDown) throw new AppError('SESSION_CANCELLED');
      const saveSession = async () => {
        const state = filterSessionState(await context.storageState(), config);
        await vault.save(state);
      };
      if (vault) {
        await saveSession();
        console.log('Sessão salva com criptografia; chave protegida pelo chaveiro do sistema.');
      }
      if (!values.login) {
        store = new Store(dbPath);
        const result = await collect({ page, config, store, purpose: values.purpose,
          onProgress: ({ runId, page: count, queued }) => console.log(`Execução ${runId}: página ${count}; ${queued} na fila.`),
        });
        const authFailures = store.db.prepare("SELECT count(*) n FROM issues WHERE run_id=? AND code IN ('LOGIN_REQUIRED','AUTH_OR_SCOPE_REDIRECT','ACCESS_CHALLENGE')").get(result.runId).n;
        if (vault && authFailures) {
          await vault.forget();
          console.log('A autenticação falhou durante a coleta. A sessão local foi removida; será necessário novo login.');
        } else if (vault && result.pagesCaptured) await saveSession();
        console.log(JSON.stringify(result, null, 2));
        console.log('Banco salvo em privado/. Consulte issues para limites, bloqueios e falhas de cobertura.');
        process.exitCode = result.status === 'captured' ? 0 : result.status === 'partial' ? 2 : 1;
      }
    }
  }
} catch (error) {
  const safe = publicError(shuttingDown ? new AppError('SESSION_CANCELLED') : error);
  // Only fixed, allowlisted messages: never dump browser stacks, URLs or DOM content.
  console.error(`[${safe.code}] ${safe.message}`);
  process.exitCode = 1;
} finally {
  terminal?.close();
  await browser?.close().catch(() => {});
  store?.close();
}
