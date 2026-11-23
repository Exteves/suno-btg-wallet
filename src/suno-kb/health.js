// Read-only view of the collection's health, for `daily:status` and the
// notification that runs after each scheduled collection.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';

export const STALE_HOURS = 48;

export function readHealth(dbPath, { now = new Date() } = {}) {
  if (!existsSync(dbPath)) return { exists: false };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const recent = db.prepare(`SELECT id, trigger, status, started_at, finished_at, collection_date FROM runs
      ORDER BY id DESC LIMIT 7`).all().map(row => ({ ...row }));
    const lastData = db.prepare(`SELECT max(started_at) AS at FROM runs WHERE status IN ('captured','partial')`).get().at;
    const lastCaptured = db.prepare(`SELECT max(started_at) AS at FROM runs WHERE status='captured'`).get().at;
    const hoursSince = at => at ? (now - new Date(at)) / 3600000 : Infinity;
    let content = null;
    try {
      content = Object.fromEntries(db.prepare(`SELECT coalesce(c.status, 'pendente') AS status, count(*) n
        FROM items i LEFT JOIN report_contents c ON c.report_key=i.item_key WHERE i.kind='report' GROUP BY 1`).all()
        .map(row => [row.status, row.n]));
    } catch { /* Database from before report contents existed. */ }
    const totals = Object.fromEntries(['reports', 'wallet_positions', 'coverage_daily', 'funds_daily'].map(view => {
      try {
        const sql = view === 'reports' ? 'SELECT count(*) n FROM reports'
          : `SELECT count(*) n FROM ${view} WHERE collection_date=(SELECT max(collection_date) FROM ${view})`;
        return [view, db.prepare(sql).get().n];
      } catch { return [view, null]; }
    }));
    return { exists: true, recent, lastData, lastCaptured, hoursSinceData: hoursSince(lastData),
      stale: hoursSince(lastData) > STALE_HOURS, content, totals, dbBytes: statSync(dbPath).size };
  } finally {
    db.close();
  }
}

// Message for the Windows notification after a scheduled run (null = silent).
export function notificationFor(exitStatus, health) {
  const code = String(exitStatus ?? '');
  const days = Number.isFinite(health?.hoursSinceData) ? Math.floor(health.hoursSinceData / 24) : null;
  const stale = health?.stale ? (days === null ? ' Nenhuma coleta completa registrada.' : ` Última coleta com dados há ${days} dia(s).`) : '';
  if (code === '3') return { title: 'Suno: login necessário', message: `A sessão expirou. Rode "npm run daily" num terminal e faça login.${stale}` };
  if (code === '2') return { title: 'Suno: coleta parcial', message: `Dados gravados com avisos. Veja "npm run daily:status".${stale}` };
  if (code !== '0' && code !== '4') return { title: 'Suno: coleta falhou', message: `Veja "npm run daily:status" e "journalctl --user -u suno-daily".${stale}` };
  if (health?.stale) return { title: 'Suno: coleta atrasada', message: stale.trim() };
  return null;
}
