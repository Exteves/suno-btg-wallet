import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { SecretServiceKeyring } from './keyring.js';
import { classifyBrowserError, classifyNetworkError, publicError } from './errors.js';
import { launchOptions } from './browser.js';

async function check(name, task, classify) {
  try { await task(); return { check: name, status: 'ok' }; }
  catch (error) { return { check: name, status: 'failed', ...publicError(classify ? classify(error) : error) }; }
}

export async function diagnose({ executablePath, browserChannel, source = 'suno' } = {}) {
  const hostname = source === 'btg' ? 'app.btgpactual.com' : 'investidor.suno.com.br';
  return Promise.all([
    check('browser', async () => {
      const browser = await chromium.launch({ ...launchOptions({ browserPath: executablePath, browserChannel }), timeout: 15000 });
      await browser.close();
    }, classifyBrowserError),
    check('dns', async () => {
      let timer;
      try {
        await Promise.race([lookup(hostname), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'EAI_AGAIN' })), 8000);
        })]);
      } finally { clearTimeout(timer); }
    }, classifyNetworkError),
    ...(source === 'btg' ? [] : [check('keyring', () => new SecretServiceKeyring().check())]),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string', default: 'suno' }, 'browser-path': { type: 'string' }, 'browser-channel': { type: 'string' } } });
  if (!['suno', 'btg'].includes(values.source)) throw new Error('Fonte inválida: suno ou btg.');
  const report = await diagnose({ source: values.source, executablePath: values['browser-path'], browserChannel: values['browser-channel'] });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.some(result => result.status === 'failed') ? 1 : 0;
}
