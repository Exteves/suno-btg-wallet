// privado/btg-carteira.sqlite: one snapshot per on-demand collection.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateDirectory } from '../privacy.js';

const POSITION_COLUMNS = ['class_id', 'category', 'ticker', 'isin', 'description', 'issuer', 'sector', 'quantity', 'price',
  'gross_value', 'net_value', 'invested_value', 'average_price', 'income_tax', 'iof_tax', 'issue_date', 'maturity_date',
  'index_name', 'rate', 'rate_type', 'daily_liquidity'];
const camel = name => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export class WalletStore {
  constructor(path) {
    if (path !== ':memory:') privateDirectory(dirname(path));
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY, captured_at TEXT NOT NULL, position_date TEXT, total_value REAL,
        status TEXT NOT NULL, issues_json TEXT NOT NULL, source TEXT NOT NULL, raw_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS class_totals (
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), class_id TEXT NOT NULL, name TEXT,
        value REAL, positions INTEGER NOT NULL, parsed INTEGER NOT NULL, PRIMARY KEY (snapshot_id, class_id)
      );
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        ${POSITION_COLUMNS.map(c => `${c} ${/value|price|quantity|tax/.test(c) ? 'REAL' : c === 'daily_liquidity' ? 'INTEGER' : 'TEXT'}`).join(', ')},
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS positions_snapshot ON positions(snapshot_id);
      CREATE VIEW IF NOT EXISTS latest_positions AS
        SELECT s.captured_at, s.position_date, p.*,
          round(100.0 * p.gross_value / nullif(s.total_value, 0), 2) AS pct_of_total
        FROM positions p JOIN snapshots s ON s.id = p.snapshot_id
        WHERE s.id = (SELECT max(id) FROM snapshots);
      CREATE VIEW IF NOT EXISTS latest_classes AS
        SELECT s.captured_at, s.position_date, c.*, round(100.0 * c.value / nullif(s.total_value, 0), 2) AS pct_of_total
        FROM class_totals c JOIN snapshots s ON s.id = c.snapshot_id
        WHERE s.id = (SELECT max(id) FROM snapshots);
    `);
  }

  saveSnapshot(parsed, { capturedAt = new Date().toISOString(), source }) {
    const status = parsed.issues.length ? 'partial' : 'ok';
    this.db.exec('BEGIN');
    try {
      const { lastInsertRowid: id } = this.db.prepare(`INSERT INTO snapshots (captured_at, position_date, total_value, status, issues_json, source, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(capturedAt, parsed.positionDate, parsed.total, status, JSON.stringify(parsed.issues), source, JSON.stringify(parsed.raw));
      const classRow = this.db.prepare('INSERT INTO class_totals VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of parsed.classes) classRow.run(id, c.classId, c.name, c.value, c.positions, c.parsed ? 1 : 0);
      const positionRow = this.db.prepare(`INSERT INTO positions (snapshot_id, ${POSITION_COLUMNS.join(', ')}, raw_json)
        VALUES (${Array(POSITION_COLUMNS.length + 2).fill('?').join(', ')})`);
      for (const p of parsed.positions) {
        const values = POSITION_COLUMNS.map(c => p[camel(c)] ?? null).map(v => typeof v === 'boolean' ? Number(v) : v);
        positionRow.run(id, ...values, JSON.stringify(p.raw));
      }
      this.db.exec('COMMIT');
      return { id: Number(id), status };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  latest() {
    const snapshot = this.db.prepare('SELECT id, captured_at, position_date, total_value, status, issues_json FROM snapshots ORDER BY id DESC LIMIT 1').get();
    if (!snapshot) return null;
    return {
      ...snapshot, issues: JSON.parse(snapshot.issues_json),
      classes: this.db.prepare('SELECT class_id, name, value, positions, pct_of_total FROM latest_classes ORDER BY value DESC').all(),
      positions: this.db.prepare(`SELECT class_id, category, ticker, description, quantity, gross_value, net_value, maturity_date, rate, pct_of_total
        FROM latest_positions ORDER BY class_id, category, gross_value DESC`).all(),
    };
  }

  close() { this.db.close(); }
}
