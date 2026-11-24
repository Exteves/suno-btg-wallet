// `npm run btg:carteira`: on-demand snapshot of the BTG positions, for
// rebalancing. Opens a temporary Chrome on the BTG login; after the manual
// login/MFA the home page loads the consolidated position by itself, and this
// script only reads that response. It sends no request and clicks nothing.
// `npm run btg:carteira -- --mostrar` prints the last snapshot without a browser.
import { parseArgs } from 'node:util';
import { privatePath } from '../privacy.js';
import { publicError } from '../errors.js';
import { openTemporaryChrome, eachPage } from './chrome.js';
import { ALLOCATION_PATH, parseAllocation } from './parse.js';
import { WalletStore } from './store.js';

process.umask(0o077);
const DB_PATH = 'privado/btg-carteira.sqlite';
const brl = v => v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = v => v === null || v === undefined ? '' : `${v.toFixed(1).replace('.', ',')}%`;
const issueText = {
  CLASS_NOT_PARSED: i => `classe "${i.name || i.classId}" com saldo, mas sem leitura dos ativos (só o total foi gravado)`,
  CATEGORY_UNKNOWN: i => `lista de renda variável desconhecida (${i.key}); ativos gravados com esse nome`,
  CLASS_TOTAL_MISMATCH: i => `soma dos ativos de ${i.classId} (${brl(i.positionsSum)}) difere do total da classe (${brl(i.classValue)})`,
  TOTAL_MISMATCH: i => `soma das classes (${brl(i.classSum)}) difere do patrimônio total (${brl(i.total)})`,
};

function printSnapshot(s) {
  console.log(`\nCarteira BTG — posição de ${s.position_date || '?'} (coletada ${new Date(s.captured_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`);
  console.log(`Total: ${brl(s.total_value)}\n`);
  for (const c of s.classes) console.log(`  ${(c.name || c.class_id).padEnd(22)} ${brl(c.value).padStart(16)} ${pct(c.pct_of_total).padStart(7)}  ${c.positions ? `${c.positions} ativos` : ''}`);
  let category;
  for (const p of s.positions) {
    if (p.category !== category) { category = p.category; console.log(`\n  ${category}`); }
    const extra = [p.maturity_date && `venc. ${p.maturity_date}`, p.rate].filter(Boolean).join(', ');
    console.log(`    ${(p.ticker || p.description || '?').padEnd(18)} qtd ${String(p.quantity ?? '—').padStart(10)} ${brl(p.gross_value).padStart(15)} ${pct(p.pct_of_total).padStart(6)}  ${extra}`);
  }
  for (const issue of s.issues) console.log(`\n⚠ ${issueText[issue.code]?.(issue) || issue.code}`);
}

async function collect({ port, timeoutMinutes }) {
  const chrome = await openTemporaryChrome({ port });
  const interrupt = () => { void chrome.close().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    console.log('Chrome temporário aberto (janela anônima, perfil descartável).');
    console.log('Faça login e MFA. A posição é lida sozinha quando a página inicial carregar; não precisa clicar em mais nada.');
    console.log('Se a página inicial não mostrar seus investimentos, abra o menu Investimentos.');
    const captured = new Promise(resolve => {
      eachPage(chrome.browser, page => page.on('response', async response => {
        try {
          const request = response.request();
          const url = new URL(request.url());
          if (request.method() !== 'GET' || url.hostname !== 'app.btgpactual.com' || !ALLOCATION_PATH.test(url.pathname) || response.status() !== 200) return;
          resolve(await response.json());
        } catch { /* unreadable body: wait for the next load */ }
      }));
    });
    const result = await Promise.race([
      captured,
      chrome.closed.then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMinutes * 60000)),
    ]);
    if (result === 'closed' || result === 'timeout') {
      console.error(result === 'closed' ? 'O Chrome foi fechado antes de a posição carregar. Nada foi gravado.'
        : `A posição não carregou em ${timeoutMinutes} min. Nada foi gravado.`);
      return 3;
    }
    const parsed = parseAllocation(result);
    if (parsed.error) { console.error('A resposta da posição veio num formato desconhecido. Nada foi gravado.'); return 1; }
    const store = new WalletStore(privatePath(DB_PATH));
    try {
      const { id, status } = store.saveSnapshot(parsed, { source: 'statement-position/allocation/MARKET/summary' });
      printSnapshot(store.latest());
      console.log(`\nFoto #${id} gravada em ${DB_PATH} (${parsed.positions.length} ativos). O Chrome temporário será fechado.`);
      return status === 'ok' ? 0 : 2;
    } finally { store.close(); }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await chrome.close();
  }
}

try {
  const { values } = parseArgs({ options: {
    mostrar: { type: 'boolean' }, port: { type: 'string', default: '9223' }, 'timeout-min': { type: 'string', default: '15' },
  } });
  if (values.mostrar) {
    const store = new WalletStore(privatePath(DB_PATH));
    const latest = store.latest();
    store.close();
    if (latest) printSnapshot(latest); else console.log('Nenhuma foto da carteira ainda: rode "npm run btg:carteira".');
  } else {
    process.exitCode = await collect({ port: Number(values.port), timeoutMinutes: Number(values['timeout-min']) });
  }
} catch (error) {
  const safe = publicError(error);
  console.error(`[${safe.code}] ${safe.message}`);
  process.exitCode = 1;
}
