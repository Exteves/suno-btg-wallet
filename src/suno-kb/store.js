import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateDirectory, scrubObject } from '../privacy.js';
import { CUMULATIVE_KINDS, DAILY_SCOPED_KINDS } from './endpoints.js';
import { findCollections, describeItem, scopeOf, stableJson, hashOf, totalOf } from './normalize.js';

const SCHEMA_VERSION = 1;

export function collectionDate(date = new Date(), timeZone = 'America/Sao_Paulo') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export class KnowledgeStore {
  constructor(path, { now = () => new Date() } = {}) {
    if (path !== ':memory:') privateDirectory(dirname(path));
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.now = now;
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=10000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        collection_date TEXT NOT NULL, trigger TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', summary_json TEXT
      );
      -- Content-addressed JSON: unchanged responses/items cost nothing on later days.
      CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, json TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
        captured_at TEXT NOT NULL, kind TEXT NOT NULL, template TEXT NOT NULL,
        url TEXT NOT NULL, query_json TEXT NOT NULL, page_route TEXT, via TEXT NOT NULL,
        status INTEGER NOT NULL, item_count INTEGER NOT NULL,
        body_hash TEXT NOT NULL REFERENCES blobs(hash)
      );
      -- One row per item ever seen, with first/last sighting (cumulative knowledge).
      CREATE TABLE IF NOT EXISTS items (
        kind TEXT NOT NULL, item_key TEXT NOT NULL, scope_key TEXT NOT NULL,
        title TEXT, ticker TEXT, published TEXT,
        first_seen_at TEXT NOT NULL, first_run_id INTEGER NOT NULL REFERENCES runs(id),
        last_seen_at TEXT NOT NULL, last_run_id INTEGER NOT NULL REFERENCES runs(id),
        data_hash TEXT NOT NULL REFERENCES blobs(hash),
        PRIMARY KEY (kind, scope_key, item_key)
      );
      CREATE TABLE IF NOT EXISTS item_revisions (
        kind TEXT NOT NULL, scope_key TEXT NOT NULL, item_key TEXT NOT NULL,
        data_hash TEXT NOT NULL REFERENCES blobs(hash), run_id INTEGER NOT NULL REFERENCES runs(id),
        seen_at TEXT NOT NULL, PRIMARY KEY (kind, scope_key, item_key, data_hash)
      );
      -- Daily state: what each wallet/coverage/fund list contained on that run.
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
        collection_date TEXT NOT NULL, kind TEXT NOT NULL, scope_key TEXT NOT NULL,
        collection_path TEXT NOT NULL, item_key TEXT NOT NULL, item_index INTEGER NOT NULL,
        title TEXT, ticker TEXT, data_hash TEXT NOT NULL REFERENCES blobs(hash),
        response_id INTEGER NOT NULL REFERENCES responses(id),
        UNIQUE (run_id, kind, scope_key, collection_path, item_key)
      );
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
        section TEXT NOT NULL, route TEXT NOT NULL, final_route TEXT, status TEXT NOT NULL,
        error_code TEXT, tabs_clicked INTEGER NOT NULL DEFAULT 0, responses INTEGER NOT NULL DEFAULT 0,
        UNIQUE (run_id, route)
      );
      CREATE TABLE IF NOT EXISTS page_texts (
        page_id INTEGER PRIMARY KEY REFERENCES pages(id), text_hash TEXT NOT NULL REFERENCES blobs(hash)
      );
      -- Endpoint shapes not stored (personal or unknown), without bodies, to extend coverage.
      CREATE TABLE IF NOT EXISTS endpoint_inventory (
        run_id INTEGER NOT NULL REFERENCES runs(id), shape TEXT NOT NULL, method TEXT NOT NULL,
        decision TEXT NOT NULL, status INTEGER, count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (run_id, shape, method, decision, status)
      );
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
        at TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL
      );
      -- Full content of each report (fetched once). JSON/HTML bodies go to blobs,
      -- PDFs to files under privado/; extracted text is searchable in report_text.
      CREATE TABLE IF NOT EXISTS report_contents (
        report_key TEXT PRIMARY KEY, slug TEXT, type TEXT, format TEXT, status TEXT NOT NULL,
        http_status INTEGER, attempts INTEGER NOT NULL DEFAULT 1, run_id INTEGER REFERENCES runs(id),
        fetched_at TEXT NOT NULL, source_url TEXT, body_hash TEXT REFERENCES blobs(hash),
        file_path TEXT, file_sha256 TEXT, file_size INTEGER, text_chars INTEGER, detail TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS report_text USING fts5(
        report_key UNINDEXED, title, text, tokenize='unicode61 remove_diacritics 2'
      );
      CREATE INDEX IF NOT EXISTS obs_date ON observations(kind, collection_date, scope_key);
      CREATE INDEX IF NOT EXISTS obs_ticker ON observations(ticker);
      CREATE INDEX IF NOT EXISTS items_ticker ON items(ticker);
      CREATE INDEX IF NOT EXISTS responses_run ON responses(run_id, kind);

      -- Latest usable run of each day (a day may be collected more than once).
      CREATE VIEW IF NOT EXISTS daily_runs AS
        SELECT collection_date, max(id) AS run_id FROM runs
        WHERE status IN ('captured','partial') GROUP BY collection_date;

      CREATE VIEW IF NOT EXISTS reports AS
        SELECT i.item_key, i.title, i.published, i.ticker, i.first_seen_at, i.last_seen_at,
               b.json AS data_json
        FROM items i JOIN blobs b ON b.hash=i.data_hash WHERE i.kind='report';

      CREATE VIEW IF NOT EXISTS report_documents AS
        SELECT r.item_key, r.title, r.published, json_extract(r.data_json, '$.type') AS type,
               json_extract(r.data_json, '$.slug') AS slug, c.status AS content_status, c.format,
               c.fetched_at, c.file_path, c.text_chars, b.json AS content_json,
               (SELECT t.text FROM report_text t WHERE t.report_key=r.item_key) AS content_text
        FROM reports r LEFT JOIN report_contents c ON c.report_key=r.item_key
        LEFT JOIN blobs b ON b.hash=c.body_hash;

      CREATE VIEW IF NOT EXISTS daily_items AS
        SELECT o.collection_date, o.kind, o.scope_key, o.collection_path, o.item_key, o.item_index,
               o.title, o.ticker, b.json AS data_json, o.run_id
        FROM observations o JOIN daily_runs d ON d.run_id=o.run_id
        JOIN blobs b ON b.hash=o.data_hash;

      CREATE VIEW IF NOT EXISTS wallet_positions AS
        SELECT * FROM daily_items WHERE kind='wallet_asset';
      CREATE VIEW IF NOT EXISTS coverage_daily AS
        SELECT * FROM daily_items WHERE kind='coverage';
      CREATE VIEW IF NOT EXISTS funds_daily AS
        SELECT * FROM daily_items WHERE kind='fund';

      -- Entries and exits of each wallet/list between consecutive collected days.
      -- Lists not collected on a day are compared with their previous collection.
      CREATE VIEW IF NOT EXISTS composition_changes AS
        WITH days AS (
          SELECT DISTINCT kind, scope_key, collection_path, collection_date FROM daily_items
        ), pairs AS (
          SELECT kind, scope_key, collection_path, collection_date,
                 lag(collection_date) OVER (PARTITION BY kind, scope_key, collection_path ORDER BY collection_date) AS previous_date
          FROM days
        )
        SELECT p.kind, p.scope_key, p.collection_path, p.collection_date, p.previous_date, 'entrou' AS change,
               cur.item_key, cur.ticker, cur.title
        FROM pairs p JOIN daily_items cur ON cur.kind=p.kind AND cur.scope_key=p.scope_key
          AND cur.collection_path=p.collection_path AND cur.collection_date=p.collection_date
        WHERE p.previous_date IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM daily_items prev WHERE prev.kind=p.kind AND prev.scope_key=p.scope_key
            AND prev.collection_path=p.collection_path AND prev.collection_date=p.previous_date AND prev.item_key=cur.item_key)
        UNION ALL
        SELECT p.kind, p.scope_key, p.collection_path, p.collection_date, p.previous_date, 'saiu',
               prev.item_key, prev.ticker, prev.title
        FROM pairs p JOIN daily_items prev ON prev.kind=p.kind AND prev.scope_key=p.scope_key
          AND prev.collection_path=p.collection_path AND prev.collection_date=p.previous_date
        WHERE NOT EXISTS (
          SELECT 1 FROM daily_items cur WHERE cur.kind=p.kind AND cur.scope_key=p.scope_key
            AND cur.collection_path=p.collection_path AND cur.collection_date=p.collection_date AND cur.item_key=prev.item_key);
    `);
    this.db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }

  start(trigger) {
    const now = this.now();
    this.date = collectionDate(now);
    this.runId = Number(this.db.prepare('INSERT INTO runs(started_at, collection_date, trigger) VALUES (?, ?, ?)')
      .run(now.toISOString(), this.date, trigger).lastInsertRowid);
    return this.runId;
  }

  finish(status, summary) {
    this.db.prepare('UPDATE runs SET finished_at=?, status=?, summary_json=? WHERE id=?')
      .run(this.now().toISOString(), status, JSON.stringify(summary), this.runId);
  }

  issue(code, detail = '') {
    this.db.prepare('INSERT INTO issues(run_id, at, code, detail) VALUES (?, ?, ?, ?)')
      .run(this.runId, this.now().toISOString(), code, JSON.stringify(scrubObject(detail)));
  }

  inventory(shape, method, decision, status) {
    this.db.prepare(`INSERT INTO endpoint_inventory(run_id, shape, method, decision, status) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET count=count+1`).run(this.runId, shape, method, decision, status ?? 0);
  }

  page(section, route) {
    this.db.prepare('INSERT OR IGNORE INTO pages(run_id, section, route, status) VALUES (?, ?, ?, ?)').run(this.runId, section, route, 'pending');
    return this.db.prepare('SELECT id FROM pages WHERE run_id=? AND route=?').get(this.runId, route).id;
  }

  pageDone(id, { status, finalRoute = null, errorCode = null, tabsClicked = 0, responses = 0 }) {
    this.db.prepare('UPDATE pages SET status=?, final_route=?, error_code=?, tabs_clicked=?, responses=? WHERE id=?')
      .run(status, finalRoute, errorCode, tabsClicked, responses, id);
  }

  blob(value) {
    const json = typeof value === 'string' ? value : stableJson(value);
    const hash = hashOf(json);
    this.db.prepare('INSERT OR IGNORE INTO blobs(hash, json, size) VALUES (?, ?, ?)').run(hash, json, Buffer.byteLength(json));
    return hash;
  }

  // Known before this run: used to stop paginating cumulative lists early.
  knownBefore(kind, scopeKey, itemKey) {
    return !!this.db.prepare('SELECT 1 FROM items WHERE kind=? AND scope_key=? AND item_key=? AND first_run_id<?')
      .get(kind, scopeKey, itemKey, this.runId);
  }

  knownCount(kind, scopeKey) {
    return this.db.prepare('SELECT count(*) n FROM items WHERE kind=? AND scope_key=?').get(kind, scopeKey).n;
  }

  // Stores one scrubbed JSON response and its items. Returns item keys for pagination.
  ingest({ classified, url, body, status, route, via }) {
    const clean = scrubObject(body);
    const at = this.now().toISOString();
    this.db.exec('BEGIN');
    try {
      const responseId = Number(this.db.prepare(`INSERT INTO responses(run_id, captured_at, kind, template, url, query_json,
        page_route, via, status, item_count, body_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(this.runId, at, classified.kind, classified.template, url, JSON.stringify(classified.query || {}), route ?? null, via, status,
          0, this.blob(clean)).lastInsertRowid);
      const result = this.ingestItems({ classified, clean, at, runId: this.runId, date: this.date, responseId });
      this.db.prepare('UPDATE responses SET item_count=? WHERE id=?').run(result.itemCount, responseId);
      this.db.exec('COMMIT');
      return { responseId, ...result, total: totalOf(clean) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ingestItems({ classified, clean, at, runId, date, responseId }) {
    const collections = findCollections(clean).filter(c => !classified.collections || classified.collections.includes(c.path));
    const itemCount = collections.reduce((sum, c) => sum + (c.single ? 0 : c.items.length), 0);
    const kind = classified.kind;
    const scope = CUMULATIVE_KINDS.has(kind) && kind !== 'wallet_event' ? 'all' : scopeOf(classified);
    const keys = [];
    const freshKeys = [];
    for (const collection of collections) {
      // Single-object responses are kept raw; only lists become items.
      if (collection.single) continue;
      const seen = new Set();
      collection.items.forEach((item, index) => {
        // Report lists also carry upsell products (e.g. "Suno Black"): no id, not a report.
        if (kind === 'report' && (item?.id === undefined || item?.id === null)) return;
        const info = describeItem(item, { preferTicker: !CUMULATIVE_KINDS.has(kind) });
        let key = info.key;
        // Duplicate keys inside one list (e.g. same ticker twice): keep both.
        if (seen.has(key)) key = `${key}#${index}`;
        seen.add(key);
        const itemScope = collections.length > 1 && !CUMULATIVE_KINDS.has(kind) ? `${scope}|${collection.path}` : scope;
        const hash = this.blob(item);
        keys.push(key);
        if (!this.db.prepare('SELECT 1 FROM items WHERE kind=? AND scope_key=? AND item_key=? AND first_run_id<?')
          .get(kind, itemScope, key, runId)) freshKeys.push(key);
        this.db.prepare(`INSERT INTO items(kind, item_key, scope_key, title, ticker, published, first_seen_at, first_run_id,
            last_seen_at, last_run_id, data_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(kind, scope_key, item_key) DO UPDATE SET title=coalesce(excluded.title, title),
            ticker=coalesce(excluded.ticker, ticker), published=coalesce(excluded.published, published),
            last_seen_at=excluded.last_seen_at, last_run_id=excluded.last_run_id, data_hash=excluded.data_hash`)
          .run(kind, key, itemScope, info.title, info.ticker, info.published, at, runId, at, runId, hash);
        this.db.prepare('INSERT OR IGNORE INTO item_revisions(kind, scope_key, item_key, data_hash, run_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(kind, itemScope, key, hash, runId, at);
        if (DAILY_SCOPED_KINDS.has(kind)) {
          this.db.prepare(`INSERT INTO observations(run_id, collection_date, kind, scope_key, collection_path, item_key,
              item_index, title, ticker, data_hash, response_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO UPDATE SET item_index=excluded.item_index, title=excluded.title, ticker=excluded.ticker,
              data_hash=excluded.data_hash, response_id=excluded.response_id`)
            .run(runId, date, kind, scope, collection.path, key, index, info.title, info.ticker, hash, responseId);
        }
      });
    }
    return { itemCount, keys, freshKeys };
  }

  // Rebuilds items/observations from the stored raw responses, e.g. after the
  // extraction heuristics improve. Raw responses and runs stay untouched.
  reindex(classify) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM observations; DELETE FROM item_revisions; DELETE FROM items;');
      const rows = this.db.prepare(`SELECT r.id, r.run_id, r.captured_at, r.url, b.json, u.collection_date
        FROM responses r JOIN blobs b ON b.hash=r.body_hash JOIN runs u ON u.id=r.run_id ORDER BY r.id`).all();
      let count = 0;
      for (const row of rows) {
        const classified = classify(row.url);
        if (classified.decision !== 'stored') continue;
        const result = this.ingestItems({ classified, clean: JSON.parse(row.json), at: row.captured_at, runId: row.run_id,
          date: row.collection_date, responseId: row.id });
        this.db.prepare('UPDATE responses SET kind=?, template=?, item_count=? WHERE id=?').run(classified.kind, classified.template, result.itemCount, row.id);
        count++;
      }
      this.db.exec('COMMIT');
      return count;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Reports whose content is still to be fetched, newest first. Failed fetches
  // are retried up to maxAttempts; 'no_access' is retried once access appears.
  pendingReportContents(limit, maxAttempts = 3) {
    return this.db.prepare(`SELECT i.item_key, i.title, json_extract(b.json, '$.slug') AS slug, json_extract(b.json, '$.type') AS type,
        json_extract(b.json, '$.user_metadata.has_access') AS has_access
      FROM items i JOIN blobs b ON b.hash=i.data_hash LEFT JOIN report_contents c ON c.report_key=i.item_key
      WHERE i.kind='report' AND (c.report_key IS NULL OR (c.status='error' AND c.attempts < ?)
        OR (c.status='no_access' AND json_extract(b.json, '$.user_metadata.has_access') != 0))
      ORDER BY coalesce(i.published, '') DESC, i.item_key DESC LIMIT ?`).all(maxAttempts, limit);
  }

  saveReportContent({ reportKey, slug, type, title, format = null, status, httpStatus = null, url = null, json, text, file, detail = null }) {
    this.db.exec('BEGIN');
    try {
      const bodyHash = json === undefined ? null : this.blob(json);
      this.db.prepare(`INSERT INTO report_contents(report_key, slug, type, format, status, http_status, run_id, fetched_at,
          source_url, body_hash, file_path, file_sha256, file_size, text_chars, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(report_key) DO UPDATE SET slug=excluded.slug, type=excluded.type, format=excluded.format,
          status=excluded.status, http_status=excluded.http_status, attempts=attempts+1, run_id=excluded.run_id,
          fetched_at=excluded.fetched_at, source_url=excluded.source_url, body_hash=excluded.body_hash,
          file_path=excluded.file_path, file_sha256=excluded.file_sha256, file_size=excluded.file_size,
          text_chars=excluded.text_chars, detail=excluded.detail`)
        .run(reportKey, slug ?? null, type ?? null, format, status, httpStatus, this.runId ?? null, this.now().toISOString(), url,
          bodyHash, file?.path ?? null, file?.sha256 ?? null, file?.size ?? null, text ? text.length : null, detail);
      this.db.prepare('DELETE FROM report_text WHERE report_key=?').run(reportKey);
      if (text) this.db.prepare('INSERT INTO report_text(report_key, title, text) VALUES (?, ?, ?)').run(reportKey, title ?? null, text);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  contentCounts() {
    return Object.fromEntries(this.db.prepare(`SELECT coalesce(c.status, 'pendente') AS status, count(*) n
      FROM items i LEFT JOIN report_contents c ON c.report_key=i.item_key WHERE i.kind='report' GROUP BY 1`).all()
      .map(row => [row.status, row.n]));
  }

  counts() {
    return Object.fromEntries(this.db.prepare(`SELECT kind, count(*) n FROM responses WHERE run_id=? GROUP BY kind`)
      .all(this.runId).map(row => [row.kind, row.n]));
  }

  close() { this.db.close(); }
}
