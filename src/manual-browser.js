import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createManualLogin, localCdpEndpoint } from './cdp.js';
import { AppError, publicError } from './errors.js';

export function manualChromeArgs(profile, port) {
  localCdpEndpoint(`http://127.0.0.1:${port}`);
  return [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--no-startup-window'];
}

async function requireFreePort(port) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', () => reject(new AppError('CDP_PORT_UNAVAILABLE')));
    server.listen(port, '127.0.0.1', () => server.close(resolvePromise));
  });
}

async function run() {
  process.umask(0o077);
  const { values } = parseArgs({ options: { port: { type: 'string', default: '9222' }, 'browser-path': { type: 'string', default: 'google-chrome' } } });
  const port = Number(values.port);
  const endpoint = localCdpEndpoint(`http://127.0.0.1:${port}`);
  await requireFreePort(port);
  const profile = await mkdtemp(join(tmpdir(), 'btg-manual-'));
  await chmod(profile, 0o700);
  let child;
  let exited;
  let exitCode;
  const stop = () => child?.kill('SIGTERM');
  try {
    child = spawn(values['browser-path'], manualChromeArgs(profile, port), { stdio: 'ignore', shell: false });
    exited = new Promise(resolvePromise => {
      child.once('error', () => { exitCode = 1; resolvePromise(); });
      child.once('close', code => { exitCode = code ?? 1; resolvePromise(); });
    });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const deadline = Date.now() + 15000;
    let opened = false;
    while (Date.now() < deadline && exitCode === undefined) {
      try { await createManualLogin(endpoint, 'https://app.btgpactual.com/login'); opened = true; break; }
      catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 250)); }
    }
    if (!opened) throw new AppError('CDP_CONNECTION_FAILED');
    console.log('Chrome temporário aberto em janela anônima. Faça login/MFA manualmente e abra Produtos de investimento.');
    console.log(`Em outro terminal, execute: npm run scrape:btg -- --cdp ${endpoint}`);
    console.log('Mantenha este terminal aberto. Ao terminar, feche as janelas deste Chrome para remover o perfil temporário.');
    await exited;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (child && exitCode === undefined) {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolvePromise => { timer = setTimeout(resolvePromise, 5000); })]);
      clearTimeout(timer);
      if (exitCode === undefined) { child.kill('SIGKILL'); await exited; }
    }
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await run(); }
  catch (error) { const safe = publicError(error); console.error(`[${safe.code}] ${safe.message}`); process.exitCode = 1; }
}
