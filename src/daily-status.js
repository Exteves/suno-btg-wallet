// `npm run daily:status`: last collections, report-content backlog, schedule
// and saved session, in one screen. Read-only.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { privatePath } from './privacy.js';
import { readHealth, STALE_HOURS } from './suno-kb/health.js';
import { loadDailyConfig } from './suno-kb/config.js';

const fmt = at => at ? new Date(at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
const mb = bytes => `${(bytes / 1048576).toFixed(0)} MB`;
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim(); } catch { return null; } };
const statusLabel = { captured: 'completa', partial: 'parcial', failed: 'falhou', login_required: 'login necessário', running: 'em andamento',
  content_ok: 'conteúdo ok', content_partial: 'conteúdo parcial' };

const config = await loadDailyConfig('suno-daily.config.json');
const health = readHealth(privatePath('privado/suno-conhecimento.sqlite'));
if (!health.exists) { console.log('Base ainda não criada: rode "npm run daily".'); process.exit(0); }

console.log('Coletas recentes');
for (const r of health.recent) {
  const minutes = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 60000) : null;
  console.log(`  #${r.id}  ${fmt(r.started_at).padEnd(20)} ${r.trigger.padEnd(7)} ${(statusLabel[r.status] || r.status).padEnd(17)}${minutes === null ? '' : `${minutes} min`}`);
}
const hours = Math.round(health.hoursSinceData);
console.log(`\nÚltima coleta com dados: ${fmt(health.lastData)}${health.stale ? `  ⚠ há mais de ${STALE_HOURS}h` : ` (há ${hours}h)`}`);
console.log(`Base: ${health.totals.reports} relatórios; no último dia, ${health.totals.wallet_positions} posições de carteira, `
  + `${health.totals.coverage_daily} ativos na cobertura, ${health.totals.funds_daily} fundos. SQLite ${mb(health.dbBytes)}.`);

if (health.content) {
  const c = health.content;
  const order = ['ok', 'pendente', 'error', 'unavailable', 'no_access', 'unsupported'];
  const names = { ok: 'baixados', pendente: 'pendentes', error: 'com erro', unavailable: 'indisponíveis', no_access: 'sem acesso', unsupported: 'formato sem conteúdo' };
  const parts = order.filter(k => c[k]).map(k => `${c[k]} ${names[k]}`);
  const pdfDir = privatePath(config.content.pdfDir);
  const pdfBytes = existsSync(pdfDir) ? readdirSync(pdfDir).reduce((sum, f) => sum + statSync(join(pdfDir, f)).size, 0) : 0;
  console.log(`Conteúdo dos relatórios: ${parts.join(', ')}. PDFs ${mb(pdfBytes)}.`);
  if (c.pendente > config.content.maxPerRun) console.log(`  Carga inicial: "npm run daily:conteudo" baixa os pendentes de uma vez (senão, ${config.content.maxPerRun} por dia).`);
}

const prop = name => run('systemctl', ['--user', 'show', 'suno-daily.timer', '-p', name, '--value']);
const [active, next] = [prop('ActiveState'), prop('NextElapseUSecRealtime')];
console.log(`\nAgendamento (systemd): ${active === 'active' ? `ativo, próxima execução ${next || '—'}` : 'inativo — rode "npm run schedule:install"'}`);
const task = run('/mnt/c/Windows/System32/schtasks.exe', ['/Query', '/TN', 'Suno - manter WSL ativo']);
console.log(`Tarefa do Windows que mantém o WSL ativo: ${task ? 'instalada' : 'não encontrada — rode "npm run schedule:windows"'}`);

const vaultPath = privatePath('privado/auth/suno.session.enc.json');
if (existsSync(vaultPath)) {
  const saved = statSync(vaultPath).mtime;
  console.log(`Sessão Suno: salva em ${fmt(saved)}; expira localmente em ${fmt(new Date(saved.getTime() + config.sessionTtlHours * 3600000))}`
    + ' se nenhuma coleta a renovar (a Suno pode revogá-la antes).');
} else console.log('Sessão Suno: nenhuma salva — rode "npm run daily" num terminal e faça login.');
