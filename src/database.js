import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { privateDirectory, scrubObject, scrubSnapshot, redactUrl } from './privacy.js';
import { catalogProducts } from './catalog.js';

export class Store {
  constructor(path) {
    if (path !== ':memory:') privateDirectory(dirname(path));
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        purpose TEXT NOT NULL CHECK(purpose IN ('start','rebalance')),
        status TEXT NOT NULL DEFAULT 'running', config_json TEXT NOT NULL,
        summary_json TEXT
      );
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
        source_url TEXT NOT NULL, source_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', error_code TEXT,
        UNIQUE(run_id, source_url)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id),
        captured_at TEXT NOT NULL, view_name TEXT NOT NULL, pagination_index INTEGER NOT NULL,
        title TEXT NOT NULL, headings_json TEXT NOT NULL, ownership TEXT NOT NULL,
        visible_text TEXT NOT NULL, content_hash TEXT NOT NULL,
        UNIQUE(page_id, view_name, content_hash)
      );
      CREATE TABLE IF NOT EXISTS data_tables (
        id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        table_index INTEGER NOT NULL, caption TEXT NOT NULL, headers_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS table_rows (
        id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES data_tables(id),
        row_index INTEGER NOT NULL, cells_json TEXT NOT NULL, fields_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        card_index INTEGER NOT NULL, text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        label TEXT NOT NULL, target_url TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY, row_id INTEGER NOT NULL REFERENCES table_rows(id),
        identifier TEXT NOT NULL, quantity_text TEXT, weight_text TEXT,
        price_text TEXT, value_text TEXT, mapping_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
        page_id INTEGER REFERENCES pages(id), code TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshot_page ON snapshots(page_id);
      CREATE INDEX IF NOT EXISTS row_table ON table_rows(table_id);
      CREATE VIEW IF NOT EXISTS collected_records AS
        SELECT r.*, s.captured_at, s.ownership, p.source_url, p.source_kind, p.run_id
        FROM records r JOIN table_rows tr ON tr.id=r.row_id
        JOIN data_tables t ON t.id=tr.table_id JOIN snapshots s ON s.id=t.snapshot_id
        JOIN pages p ON p.id=s.page_id;
    `);
    // Additive migration: existing Suno histories remain intact.
    const columns = this.db.prepare('PRAGMA table_info(runs)').all();
    if (!columns.some(column => column.name === 'provider')) this.db.exec("ALTER TABLE runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'suno'");
    if (!this.db.prepare('PRAGMA table_info(snapshots)').all().some(column => column.name === 'captured_url')) this.db.exec('ALTER TABLE snapshots ADD COLUMN captured_url TEXT');
    this.db.exec(`
      DROP VIEW IF EXISTS collected_records;
      CREATE VIEW collected_records AS
        SELECT r.*, s.captured_at, s.ownership, COALESCE(s.captured_url,p.source_url) AS source_url,
               p.source_kind, p.run_id, rr.provider
        FROM records r JOIN table_rows tr ON tr.id=r.row_id
        JOIN data_tables t ON t.id=tr.table_id JOIN snapshots s ON s.id=t.snapshot_id
        JOIN pages p ON p.id=s.page_id JOIN runs rr ON rr.id=p.run_id;
      CREATE TABLE IF NOT EXISTS catalog_products (
        id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        identity TEXT, fingerprint TEXT NOT NULL, name TEXT, ticker TEXT, isin TEXT,
        product_cnpj TEXT, external_id TEXT, issuer TEXT, category TEXT NOT NULL,
        category_evidence TEXT NOT NULL, category_text TEXT, product_type TEXT,
        rate_text TEXT, maturity_text TEXT, liquidity_text TEXT, minimum_text TEXT,
        price_text TEXT, currency TEXT, risk_text TEXT, guarantee_text TEXT, fees_text TEXT,
        tax_text TEXT, redemption_text TEXT, restrictions_text TEXT,
        raw_fields_json TEXT NOT NULL, location_json TEXT NOT NULL,
        availability TEXT NOT NULL DEFAULT 'observed_in_catalog',
        UNIQUE(snapshot_id,fingerprint)
      );
      CREATE INDEX IF NOT EXISTS catalog_identity ON catalog_products(identity);
      DROP VIEW IF EXISTS catalog_observations;
      CREATE VIEW catalog_observations AS
        SELECT c.*, COALESCE(s.captured_url,p.source_url) AS source_url, p.run_id, r.provider, s.captured_at,
               s.view_name, s.pagination_index
        FROM catalog_products c JOIN snapshots s ON s.id=c.snapshot_id
        JOIN pages p ON p.id=s.page_id JOIN runs r ON r.id=p.run_id;
      CREATE TABLE IF NOT EXISTS allocation_plans (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
        capital_cents INTEGER NOT NULL CHECK(capital_cents>0), currency TEXT NOT NULL,
        source_note TEXT NOT NULL, definition_hash TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS allocation_targets (
        plan_id INTEGER NOT NULL REFERENCES allocation_plans(id), asset_class TEXT NOT NULL,
        weight_basis_points INTEGER NOT NULL CHECK(weight_basis_points BETWEEN 0 AND 10000),
        amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), PRIMARY KEY(plan_id,asset_class)
      );
      PRAGMA user_version=2;
    `);
  }

  start(purpose, config) {
    return Number(this.db.prepare('INSERT INTO runs(started_at,purpose,config_json,provider) VALUES(?,?,?,?)')
      .run(new Date().toISOString(), purpose, JSON.stringify(scrubObject(config)), config.provider || 'suno').lastInsertRowid);
  }

  page(runId, url, kind) {
    return Number(this.db.prepare('INSERT INTO pages(run_id,source_url,source_kind) VALUES(?,?,?) RETURNING id').get(runId, redactUrl(url), kind).id);
  }

  pageStatus(id, status, code = null) {
    this.db.prepare('UPDATE pages SET status=?,error_code=? WHERE id=?').run(status, code, id);
  }

  issue(runId, pageId, code, detail = '') {
    this.db.prepare('INSERT INTO issues(run_id,page_id,code,detail) VALUES(?,?,?,?)')
      .run(runId, pageId, code, JSON.stringify(scrubObject(detail)));
  }

  save(pageId, view, paginationIndex, input, mappings = [], config = {}) {
    const data = scrubSnapshot(input);
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare(`INSERT OR IGNORE INTO snapshots
        (page_id,captured_at,view_name,pagination_index,title,headings_json,ownership,visible_text,content_hash,captured_url)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(pageId, new Date().toISOString(), view, paginationIndex,
        data.title, JSON.stringify(data.headings), data.ownership, data.text, hash, data.sourceUrl || null);
      if (!result.changes) { db.exec('COMMIT'); return false; }
      const snapshotId = Number(result.lastInsertRowid);
      for (const [ti, table] of data.tables.entries()) {
        const tableId = Number(db.prepare('INSERT INTO data_tables(snapshot_id,table_index,caption,headers_json) VALUES(?,?,?,?)')
          .run(snapshotId, ti, table.caption, JSON.stringify(table.headers)).lastInsertRowid);
        for (const [ri, cells] of table.rows.entries()) {
          const fields = Object.fromEntries(cells.map((cell, i) => [`${table.headers[i] || 'column'} [${i + 1}]`, cell]));
          const rowId = Number(db.prepare('INSERT INTO table_rows(table_id,row_index,cells_json,fields_json) VALUES(?,?,?,?)')
            .run(tableId, ri, JSON.stringify(cells), JSON.stringify(fields)).lastInsertRowid);
          for (const mapping of mappings) {
            if (mapping.caption && mapping.caption !== table.caption) continue;
            const lookup = (key) => {
              const header = mapping.columns[key];
              const index = typeof header === 'number' ? header : table.headers.indexOf(header);
              return index >= 0 ? cells[index] ?? null : null;
            };
            const identifier = lookup('identifier');
            if (!identifier) continue;
            db.prepare(`INSERT INTO records(row_id,identifier,quantity_text,weight_text,price_text,value_text,mapping_name)
              VALUES(?,?,?,?,?,?,?)`).run(rowId, identifier, lookup('quantity'), lookup('weight'), lookup('price'), lookup('value'), mapping.name);
          }
        }
      }
      for (const [index, card] of data.cards.entries()) {
        db.prepare('INSERT INTO cards(snapshot_id,card_index,text) VALUES(?,?,?)').run(snapshotId, index, card);
      }
      for (const link of data.links) {
        db.prepare('INSERT INTO links(snapshot_id,label,target_url) VALUES(?,?,?)').run(snapshotId, link.label, link.url);
      }
      const page = db.prepare('SELECT p.source_url,r.provider FROM pages p JOIN runs r ON r.id=p.run_id WHERE p.id=?').get(pageId);
      if (page.provider === 'btg') {
        const products = catalogProducts(data, { url: data.sourceUrl || page.source_url, view, config });
        const fields = ['identity','fingerprint','name','ticker','isin','product_cnpj','external_id','issuer','category','category_evidence','category_text','product_type','rate_text','maturity_text','liquidity_text','minimum_text','price_text','currency','risk_text','guarantee_text','fees_text','tax_text','redemption_text','restrictions_text'];
        const statement = db.prepare(`INSERT INTO catalog_products(snapshot_id,${fields.join(',')},raw_fields_json,location_json)
          VALUES(${Array(fields.length + 3).fill('?').join(',')})`);
        for (const product of products) statement.run(snapshotId, ...fields.map(field => product[field] ?? null), JSON.stringify(product.raw_fields), JSON.stringify(product.location));
      }
      db.exec('COMMIT');
      return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  finish(runId, status, summary) {
    this.db.prepare('UPDATE runs SET finished_at=?,status=?,summary_json=? WHERE id=?')
      .run(new Date().toISOString(), status, JSON.stringify(scrubObject(summary)), runId);
  }

  close() { this.db.close(); }
}
