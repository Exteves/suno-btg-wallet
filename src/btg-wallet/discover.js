// `npm run btg:carteira:mapear`: only needed if BTG changes where the app
// loads positions from. Opens the temporary Chrome; while the user logs in and
// browses the portfolio pages by hand, it only LISTENS and keeps the scrubbed
// JSON responses from btgpactual.com in privado/run/btg-descoberta/.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticPath, privateDirectory, privatePath } from '../privacy.js';
import { openTemporaryChrome, eachPage } from './chrome.js';
import { scrubWallet } from './scrub.js';

process.umask(0o077);
const outDir = privatePath('privado/run/btg-descoberta');
privateDirectory(outDir);
const authPath = /(?:^|\/)(?:login|logout|auth|oauth|token|tokens|session|sessions|mfa|otp|password|senha|device|devices)(?:\/|$)/i;
const minutes = Number(process.argv[2] || 30);
let seq = 0;
const navigations = [];
const index = [];
const flush = () => writeFileSync(join(outDir, 'indice.json'), JSON.stringify({ navigations, responses: index }, null, 2), { mode: 0o600 });

const chrome = await openTemporaryChrome();
const stop = () => { void chrome.close().finally(() => process.exit(130)); };
process.once('SIGINT', stop);
try {
  eachPage(chrome.browser, page => {
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) { navigations.push({ at: new Date().toISOString(), path: diagnosticPath(frame.url()) }); flush(); }
    });
    page.on('response', async response => {
      try {
        const request = response.request();
        const url = new URL(request.url());
        if (!['xhr', 'fetch'].includes(request.resourceType())) return;
        if (url.hostname !== 'btgpactual.com' && !url.hostname.endsWith('.btgpactual.com')) return;
        if (authPath.test(url.pathname) || !/json/i.test(response.headers()['content-type'] || '')) return;
        const text = JSON.stringify(scrubWallet(await response.json()));
        const path = diagnosticPath(request.url());
        const host = url.hostname.split('.')[0];
        const file = `${String(++seq).padStart(4, '0')}-${request.method()}-${host}${path.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 120)}.json`;
        index.push({ file, method: request.method(), host, path, query: [...url.searchParams.keys()], status: response.status(), bytes: text.length, page: diagnosticPath(page.url()) });
        if (text.length < 5e6) writeFileSync(join(outDir, file), text, { mode: 0o600 });
        flush();
      } catch { /* bodies of redirects/aborted requests are unavailable */ }
    });
  });
  console.log(`Ouvindo por até ${minutes} min. Faça login e abra as páginas da sua carteira; feche o Chrome ao terminar.`);
  await Promise.race([chrome.closed, new Promise(r => setTimeout(r, minutes * 60000))]);
} finally {
  flush();
  await chrome.close();
  console.log(`${index.length} respostas JSON registradas em ${outDir}`);
}
