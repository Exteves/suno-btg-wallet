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
import { launchOptions, contextOptions, collectionContext } from './browser.js';
import { loginDiagnostics } from './login-diagnostics.js';
import { attachCatalog, localCdpEndpoint } from './cdp.js';
import { AppError, classifyBrowserError, classifyNetworkError, publicError } from './errors.js';

process.umask(0o077);
let browser;
let store;
let terminal;
let diagnostics;
let ownedContext;
let diagnoseLogin = false;
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
    'browser-path': { type: 'string' }, 'browser-channel': { type: 'string' },
    cdp: { type: 'string' },
    'diagnose-login': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    login: { type: 'boolean' }, 'no-session': { type: 'boolean' }, 'forget-session': { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Uso: npm run scrape -- --source suno|btg --purpose start|rebalance [--no-session] [--config arquivo.json] [--db privado/suno.sqlite]');
    console.log('Navegador: --browser-channel chrome|msedge|chromium OU --browser-path /caminho/chromium. Diagnóstico de carregamento: --diagnose-login.');
    console.log('Login Suno e sessão: npm run login | npm run session:forget. Diagnóstico do ambiente: npm run doctor.');
    console.log('Sessão BTG manual: npm run btg:browser; depois npm run scrape:btg -- --cdp http://127.0.0.1:9222.');
  } else {
    if (!['suno', 'btg'].includes(values.source)) throw new AppError('CLI_USAGE');
    diagnoseLogin = !!values['diagnose-login'];
    if (values.cdp) {
      localCdpEndpoint(values.cdp);
      if (values.source !== 'btg' || values.login || values['forget-session'] || diagnoseLogin || values['browser-path'] || values['browser-channel']) throw new AppError('CLI_USAGE');
    }
    const launch = launchOptions({ browserPath: values['browser-path'], browserChannel: values['browser-channel'] });
    if (diagnoseLogin && (values.login || values['forget-session'])) throw new AppError('CLI_USAGE');
    if (values.source === 'btg') {
      if (values.login || values['forget-session']) throw new AppError('CLI_USAGE');
      values['no-session'] = true;
      values.purpose ??= 'start';
    }
    if (values['forget-session'] && (values.login || values.purpose || values['no-session'])) throw new AppError('CLI_USAGE');
    if (!values['forget-session'] && !values.login && !diagnoseLogin && !['start', 'rebalance'].includes(values.purpose)) throw new AppError('CLI_USAGE');
    if (values.login && (values['no-session'] || values.purpose)) throw new AppError('CLI_USAGE');
    const persist = !values['no-session'] && !diagnoseLogin;
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
      if (persist) await keyring.check();
      const restored = vault ? await vault.load() : { state: null, reason: 'disabled' };
      if (restored.reason === 'restored') console.log('Sessão descriptografada em memória. A validade será conferida no navegador.');
      if (restored.reason === 'expired') console.log('A sessão local expirou. Faça login novamente no navegador.');
      if (diagnoseLogin) console.log('Modo diagnóstico de carregamento: não digite credenciais. A janela fecha após a observação; não haverá coleta nem gravação de sessão.');
      let context;
      let page;
      let attached;
      if (values.cdp) {
        attached = await attachCatalog(chromium, values.cdp, config);
        ({ browser, context, page } = attached);
        console.log('Catálogo localizado na janela anônima do Chrome temporário. A conexão não inicia o login nem altera o perfil habitual.');
      } else {
        try { browser = await chromium.launch(launch); }
        catch (error) { throw classifyBrowserError(error); }
        context = await browser.newContext({ ...contextOptions(config, 'authentication'), storageState: restored.state || undefined });
        // No persistent profile, plaintext state file, tracing, videos, screenshots, HAR, or body logging.
        diagnostics = loginDiagnostics(context, { ...config, classifyStartupErrors: diagnoseLogin });
        page = await context.newPage();
        page.on('dialog', dialog => dialog.dismiss());
        if (diagnoseLogin) console.log(JSON.stringify({ browser: values['browser-channel'] || (values['browser-path'] ? 'custom-executable' : 'bundled-chromium'), version: browser.version(), auth_service_workers: config.authServiceWorkers,
          initial_navigation: config.loginPath === config.entryPath ? 'collection_entry' : 'login' }));
        try {
          const response = await page.goto(new URL(config.loginPath, config.baseUrl).href, {
            waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs,
          });
          if (response && !response.ok()) throw new AppError('HTTP_ERROR');
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw classifyNetworkError(error);
        }
      }
      if (diagnoseLogin) {
        await page.waitForTimeout(15000);
        await diagnostics.observePage(page);
      } else {
        await confirmAuthentication(page, config, async () => {
          if (!stdin.isTTY) throw new AppError('SESSION_LOGIN_REQUIRED');
          console.log(attached ? 'Confirme que esta é a aba do catálogo que deseja consultar. Pressione Enter para iniciar a coleta.' : values.source === 'btg'
            ? 'Faça login e MFA diretamente no BTG e abra Produtos de investimento. A sessão será temporária, sem gravar cookies ou tokens em disco.'
            : 'Confira Portfólio no navegador. Se solicitado, faça login e MFA diretamente nele. Não envie senha ou códigos ao terminal.');
          terminal = createInterface({ input: stdin, output: stdout });
          await terminal.question('Com a página autenticada carregada, pressione Enter: ', { signal: cancellation.signal });
          terminal.close();
        });
        diagnostics?.detach();
        diagnostics = undefined;
        if (shuttingDown) throw new AppError('SESSION_CANCELLED');
        if (!values.login) {
          if (config.authServiceWorkers === 'allow') console.log('Página confirmada no navegador. Preparando contexto temporário; a autorização das APIs será verificada durante a coleta.');
          const authPage = page;
          ({ context, page } = await collectionContext(browser, context, page, config,
            attached ? { captureState: attached.captureState, closeAuthContext: false } : undefined));
          if (attached) ownedContext = context;
          if (page !== authPage) page.on('dialog', dialog => dialog.dismiss());
        }
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
            onProgress: progress => {
              const { runId, page: count, queued } = progress;
              if (progress.phase === 'scroll') {
                const state = progress.busy && progress.waitingForRequests ? 'aguardando carregamento e consultas'
                  : progress.busy ? 'aguardando indicador de carregamento'
                  : progress.waitingForRequests ? 'aguardando consultas de produtos'
                  : progress.atBottom ? 'confirmando fim da lista' : 'percorrendo lista';
                const records = progress.distinctProductRecords === undefined ? '' : `; ${progress.distinctProductRecords} registros distintos`;
                console.log(`Execução ${runId}: página ${count}; ${Math.floor(progress.elapsedMs / 1000)}s; passo ${progress.step}${records}; ${state}.`);
              } else if (progress.phase === 'page_end') {
                console.log(`Execução ${runId}: página ${count} encerrada (${progress.status}); ${progress.distinctProductRecords} registros; ${progress.error || progress.scrollCompletion || 'sem rolagem'}.`);
              } else console.log(`Execução ${runId}: página ${count}; ${queued} na fila.`);
            },
          });
          const authFailures = store.db.prepare("SELECT count(*) n FROM issues WHERE run_id=? AND code IN ('LOGIN_REQUIRED','AUTH_OR_SCOPE_REDIRECT','ACCESS_CHALLENGE','API_AUTHENTICATION_REQUIRED')").get(result.runId).n;
          if (vault && authFailures) {
            await vault.forget();
            console.log('A autenticação falhou durante a coleta. A sessão local foi removida; será necessário novo login.');
          } else if (vault && result.pagesCaptured) await saveSession();
          console.log(JSON.stringify(result, null, 2));
          if (result.reauthenticationRequired) console.log('O BTG respondeu 401 nas APIs de produtos. A coleta foi interrompida. Faça login novamente na janela manual e confirme que os ativos aparecem após recarregar; a tela do catálogo, sozinha, não confirma autorização das APIs.');
          console.log('Banco salvo em privado/. Consulte issues para limites, bloqueios e falhas de cobertura.');
          process.exitCode = result.status === 'captured' ? 0 : result.status === 'partial' ? 2 : 1;
        }
      }
    }
  }
} catch (error) {
  const safe = publicError(shuttingDown ? new AppError('SESSION_CANCELLED') : error);
  console.error(`[${safe.code}] ${safe.message}`);
  process.exitCode = 1;
} finally {
  if (diagnostics && (diagnoseLogin || diagnostics.summary().events.length)) console.log(JSON.stringify(diagnostics.summary(), null, 2));
  diagnostics?.detach();
  terminal?.close();
  await ownedContext?.close().catch(() => {});
  await browser?.close().catch(() => {});
  store?.close();
}
