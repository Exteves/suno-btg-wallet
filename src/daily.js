// Coleta diária da Suno (Relatórios, Carteiras, Cobertura, Fundos) para a base
// de conhecimento em privado/. Somente consulta. Sem Enter quando a sessão
// criptografada continua válida; login/MFA permanecem manuais.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from 'node:fs';
import { chromium } from 'playwright';
import { privatePath, privateDirectory } from './privacy.js';
import { SecretServiceKeyring } from './keyring.js';
import { SessionVault, filterSessionState } from './session-vault.js';
import { contextOptions } from './browser.js';
import { AppError, publicError } from './errors.js';
import { loadDailyConfig } from './suno-kb/config.js';
import { KnowledgeStore } from './suno-kb/store.js';
import { classifyEndpoint } from './suno-kb/endpoints.js';
import { ResponseRecorder, checkAuthenticated, collectSuno, installGuard, onLoginPage } from './suno-kb/collector.js';
import { collectReportContents } from './suno-kb/content.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBrowser, displayState } from './suno-kb/diagnostics.js';

process.umask(0o077);
const EXIT = { captured: 0, failed: 1, partial: 2, login: 3, locked: 4 };
const log = message => console.log(`${new Date().toISOString()} ${message}`);

function acquireLock(path) {
  privateDirectory(privatePath('privado/run'));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* already gone */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      try { if (pid) { process.kill(pid, 0); return null; } } catch { /* stale lock */ }
      unlinkSync(path);
    }
  }
  return null;
}

let browser;
let store;
let trigger = 'manual';
let dbPath = 'privado/suno-conhecimento.sqlite';
let finished = false;
// Current step, printed with any failure so the journal says where it stopped.
let stage = 'início';
const setStage = name => { stage = name; log(`Etapa: ${name}.`); };

// Leaves a 'failed' run in the database even when the failure happened before
// the run started (it used to show up only in the journal).
function recordFailure(code, detail = {}) {
  if (finished) return;
  finished = true;
  try {
    store ??= new KnowledgeStore(privatePath(dbPath));
    if (!store.runId) store.start(trigger);
    store.issue(code, { stage, ...detail });
    store.finish('failed', { error: code, stage });
  } catch { /* database unavailable: the journal line is all we have */ }
}

// A promise that never settles (e.g. the browser died mid-call) drains the
// event loop and Node exits with 13 without reaching catch/finally.
process.on('exit', code => {
  if (code !== 13) return;
  log(`Encerrado com uma operação pendente na etapa "${stage}" (código 13). Ambiente: ${JSON.stringify(displayState())}`);
  recordFailure('UNSETTLED_EXIT');
});
let releaseLock;
let terminal;
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  shuttingDown = true;
  terminal?.close();
  void browser?.close().catch(() => {});
});

try {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'suno-daily.config.json' },
    db: { type: 'string', default: 'privado/suno-conhecimento.sqlite' },
    full: { type: 'boolean' }, trigger: { type: 'string', default: 'manual' },
    'browser-path': { type: 'string' }, headless: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    'wait-login': { type: 'string' },
    reindex: { type: 'boolean' },
    'content-only': { type: 'boolean' }, 'content-limit': { type: 'string' },
  } });
  if (values.help) {
    console.log('Uso: npm run daily [-- --full] [--db privado/suno-conhecimento.sqlite] [--config suno-daily.config.json]');
    console.log('--reindex recalcula itens e observações a partir das respostas brutas já gravadas (sem navegador).');
    console.log('--wait-login N espera até N minutos pelo login manual na janela, sem terminal interativo.');
    console.log('--full percorre novamente todas as páginas de relatórios e eventos, não só as novidades.');
    console.log('--content-only baixa só o conteúdo pendente dos relatórios (carga inicial: npm run daily:conteudo).');
    console.log('--content-limit N limita quantos conteúdos de relatório baixar nesta execução (0 desliga).');
    console.log('Sem sessão válida: em terminal interativo abre o login manual; agendado, termina com código 3.');
    process.exit(0);
  }
  if (!['manual', 'timer'].includes(values.trigger)) throw new AppError('CLI_USAGE');
  trigger = values.trigger;
  dbPath = values.db;
  const waitLoginMinutes = values['wait-login'] === undefined ? 0 : Number(values['wait-login']);
  if (!Number.isInteger(waitLoginMinutes) || waitLoginMinutes < 0 || waitLoginMinutes > 30) throw new AppError('CLI_USAGE');
  let config;
  try { config = await loadDailyConfig(values.config); } catch { throw new AppError('CONFIG_INVALID'); }
  const contentOnly = !!values['content-only'];
  const contentLimit = values['content-limit'] !== undefined ? Number(values['content-limit'])
    : contentOnly ? config.content.maxPerContentRun : config.content.maxPerRun;
  if (!Number.isInteger(contentLimit) || contentLimit < 0) throw new AppError('CLI_USAGE');
  if (values.reindex) {
    // Offline: recomputes items/observations from stored raw responses.
    store = new KnowledgeStore(privatePath(values.db));
    log(`${store.reindex(url => classifyEndpoint(url, 'GET'))} respostas reprocessadas.`);
    process.exit(0);
  }
  releaseLock = acquireLock(privatePath('privado/run/suno-daily.lock'));
  if (!releaseLock) { log('Outra coleta diária está em andamento.'); process.exitCode = EXIT.locked; }
  else {
    const runTimer = setTimeout(() => { log('Tempo máximo da execução atingido; encerrando o navegador.'); shuttingDown = true; void browser?.close().catch(() => {}); },
      (contentOnly ? config.content.contentRunTimeoutMinutes : config.runTimeoutMinutes) * 60000);
    runTimer.unref();
    setStage('abrindo sessão');
    const keyring = new SecretServiceKeyring();
    await keyring.check();
    const vault = new SessionVault(privatePath('privado/auth/suno.session.enc.json'), keyring, { ttlMs: config.sessionTtlHours * 3600000 });
    const restored = await vault.load();
    log(restored.reason === 'restored' ? 'Sessão descriptografada em memória.' : restored.reason === 'expired' ? 'Sessão local expirada.' : 'Sem sessão salva.');
    store = new KnowledgeStore(privatePath(values.db));
    const abandoned = store.abandonRunning();
    if (abandoned.length) log(`Execução(ões) ${abandoned.join(', ')} interrompida(s) sem encerrar (processo morto); marcada(s) como falha.`);
    setStage('abrindo navegador');
    // Cloudflare blocks headless Chromium on this site (verified 2026-11-23).
    const opened = await openBrowser({ chromium, log,
      launchOptions: { headless: !!values.headless, ...(values['browser-path'] ? { executablePath: values['browser-path'] } : {}) },
      contextOptions: { ...contextOptions({ authServiceWorkers: 'block' }, 'collection'), storageState: restored.state || undefined },
      onBrowser: b => { browser = b; } });
    const { context, page, browserLog } = opened;
    browser.on('disconnected', () => {
      if (shuttingDown || finished) return;
      log(`Navegador desconectado na etapa "${stage}". Ambiente: ${JSON.stringify(displayState())}`);
      for (const line of browserLog.tail()) log(`  [chromium] ${line}`);
    });
    page.on('dialog', dialog => dialog.dismiss());
    const recorder = new ResponseRecorder({ store, full: !!values.full, log });
    recorder.attach(page);
    const sessionConfig = { baseUrl: config.baseUrl, sessionLocalStorageKeys: config.sessionLocalStorageKeys };

    // Report contents: direct GETs with the session headers the page itself
    // just used (memory only). Reopening /relatorios makes the app renew them.
    const refreshAuth = async () => {
      const before = recorder.authorizedOk;
      try { await page.goto(new URL('/relatorios', config.baseUrl).href, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs }); }
      catch { /* A redirect to login can interrupt the navigation. */ }
      const start = Date.now();
      while (Date.now() - start < config.authTimeoutMs && !shuttingDown) {
        if (onLoginPage(page)) return false;
        if (recorder.authorizedOk > before && recorder.authHeaders?.['x-auth']) return true;
        await sleep(500);
      }
      return false;
    };
    const fetchContents = async limit => {
      recorder.enabled = false;
      if (!limit) return { stats: { pending: 0 } };
      if (!recorder.authHeaders?.['x-auth'] && !(await refreshAuth())) return { stats: {}, authLost: true };
      log(`Conteúdo dos relatórios: até ${limit} pendentes.`);
      const result = await collectReportContents({
        store, limit, refreshAuth, headers: () => recorder.authHeaders,
        request: async (url, headers) => {
          const response = await context.request.get(url, { headers, timeout: 120000, maxRedirects: 0, failOnStatusCode: false });
          return { status: response.status(), contentType: response.headers()['content-type'] || '', body: await response.body() };
        },
        delayMs: config.pagination.delayMs, pdfDir: privatePath(config.content.pdfDir), since: config.reportsSince,
        refreshEveryMs: config.content.refreshMinutes * 60000, maxAttempts: config.content.maxAttempts, shouldStop: () => shuttingDown,
        onProgress: ({ index, total }) => { if (index % 100 === 1 || index === total) log(`[conteúdo] ${index}/${total}`); },
      });
      const { error = 0, attempted = 0 } = result.stats;
      if (error > Math.max(3, attempted * 0.1)) store.issue('CONTENT_ERRORS', { error, attempted });
      return result;
    };

    setStage('confirmando login');
    let authenticated = await checkAuthenticated(page, recorder, config);
    if (!authenticated && waitLoginMinutes && !shuttingDown) {
      // No terminal: the person logs in in the window; an authorized API
      // response on the investor area confirms it. Credentials never pass here.
      log(`Faça login e MFA diretamente na janela do navegador (aguardando até ${waitLoginMinutes} min).`);
      const deadline = Date.now() + waitLoginMinutes * 60000;
      const before = recorder.authorizedOk;
      while (!authenticated && !shuttingDown && Date.now() < deadline) {
        await sleep(2000);
        const onSite = (() => { try { return new URL(page.url()).hostname === new URL(config.baseUrl).hostname; } catch { return false; } })();
        if (onSite && !onLoginPage(page) && recorder.authorizedOk > before) authenticated = await checkAuthenticated(page, recorder, config);
      }
    }
    if (!authenticated && stdin.isTTY && !shuttingDown) {
      log('Faça login e MFA diretamente no navegador. Não digite senha ou códigos no terminal.');
      terminal = createInterface({ input: stdin, output: stdout });
      await terminal.question('Quando a área do investidor estiver aberta, pressione Enter: ');
      terminal.close();
      authenticated = await checkAuthenticated(page, recorder, config);
    }
    if (!authenticated) {
      if (restored.state) await vault.forget();
      store.start(values.trigger);
      store.issue('LOGIN_REQUIRED', 'Sessão ausente, expirada ou revogada.');
      store.finish('login_required', {});
      finished = true;
      log('Login necessário: execute `npm run daily` em um terminal e autentique no navegador.');
      process.exitCode = EXIT.login;
    } else if (contentOnly) {
      await vault.save(filterSessionState(await context.storageState(), sessionConfig));
      const runId = store.start(values.trigger);
      log(`Execução ${runId}: somente conteúdo de relatórios.`);
      await installGuard(context, config, (shape, method) => store.inventory(shape, method, 'blocked', null));
      let content;
      try { content = await fetchContents(contentLimit); }
      catch (error) { if (!shuttingDown) throw error; content = { stats: {}, interrupted: true }; }
      await recorder.flush();
      if (shuttingDown) content.interrupted = true;
      const issues = store.db.prepare('SELECT count(*) n FROM issues WHERE run_id=?').get(runId).n;
      // Not 'captured'/'partial': daily views must keep using the day's full collection.
      const status = content.authLost || content.interrupted || issues ? 'content_partial' : 'content_ok';
      const summary = { content: content.stats, contentTotals: store.contentCounts(config.reportsSince) };
      store.finish(status, summary);
      finished = true;
      if (content.authLost) await vault.forget();
      else if (!shuttingDown) await context.storageState().then(state => vault.save(filterSessionState(state, sessionConfig))).catch(() => {});
      console.log(JSON.stringify({ runId, status, ...summary }, null, 2));
      process.exitCode = content.authLost ? EXIT.login : status === 'content_ok' ? EXIT.captured : EXIT.partial;
    } else {
      await vault.save(filterSessionState(await context.storageState(), sessionConfig));
      log('Sessão confirmada por resposta autorizada da API e salva criptografada.');
      const runId = store.start(values.trigger);
      log(`Execução ${runId} (${store.date}) iniciada${values.full ? ' em modo completo' : ''}.`);
      setStage('coletando páginas');
      let result;
      try {
        result = await collectSuno({ context, page, config, store, recorder, log,
          onProgress: ({ section, route, page: n }) => log(`[${section}] página ${n}: ${route}`) });
      } catch (error) {
        if (!shuttingDown) throw error;
        result = { stats: {}, authLost: false, interrupted: true };
      }
      await recorder.flush();
      let content = { stats: {} };
      if (!result.authLost && !result.interrupted && !shuttingDown) {
        setStage('baixando conteúdo dos relatórios');
        try { content = await fetchContents(contentLimit); }
        catch (error) { if (!shuttingDown) throw error; result.interrupted = true; }
        if (content.authLost) result.authLost = true;
        if (content.interrupted) result.interrupted = true;
      }
      const issues = store.db.prepare('SELECT code, count(*) n FROM issues WHERE run_id=? GROUP BY code').all(runId)
        .map(row => ({ code: row.code, n: row.n }));
      const counts = store.counts();
      const status = !Object.keys(counts).length ? 'failed'
        : issues.length || result.interrupted || result.authLost ? 'partial' : 'captured';
      const summary = { ...result.stats, responsesByKind: counts, items: recorder.stats.items, content: content.stats, issues };
      store.finish(status, summary);
      finished = true;
      if (result.authLost) await vault.forget();
      else if (!shuttingDown) await context.storageState().then(state => vault.save(filterSessionState(state, sessionConfig))).catch(() => {});
      console.log(JSON.stringify({ runId, date: store.date, status, ...summary }, null, 2));
      process.exitCode = result.authLost ? EXIT.login : EXIT[status];
    }
    clearTimeout(runTimer);
  }
} catch (error) {
  const safe = publicError(shuttingDown ? new AppError('SESSION_CANCELLED') : error);
  console.error(`[${safe.code}] ${safe.message} (etapa: ${error?.stage || stage})`);
  if (!shuttingDown) log(`Ambiente na falha: ${JSON.stringify(displayState())}`);
  recordFailure(safe.code, error?.stage ? { step: error.stage } : {});
  process.exitCode = EXIT.failed;
} finally {
  terminal?.close();
  await browser?.close().catch(() => {});
  store?.close();
  releaseLock?.();
}
