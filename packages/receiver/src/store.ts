import * as fs from 'fs';
import * as path from 'path';
import type SqlJs from 'sql.js';
import type { QueryableDB } from '@otel-insights/types';

// Rebuilds the flat, dotted-key attributes object the engine expects
// (e.g. {"gen_ai.request.model":"gpt-4o"}) from an OTLP attribute array
// [{key, value:{stringValue|intValue|...}}] at `arrPath` inside `e.raw`.
// Array values (e.g. gen_ai.response.finish_reasons -> ["end_turn"]) are
// preserved as a nested JSON array of their scalar elements; kvlist/bytes
// values collapse to null (no engine query relies on them).
const flatAttrs = (arrPath: string): string => `
    (SELECT COALESCE(json_group_object(
       json_extract(a.value, '$.key'),
       CASE
         WHEN json_type(a.value, '$.value.arrayValue.values') = 'array' THEN
           (SELECT json_group_array(
              COALESCE(
                json_extract(v.value, '$.stringValue'),
                CAST(json_extract(v.value, '$.intValue') AS INTEGER),
                json_extract(v.value, '$.doubleValue'),
                json_extract(v.value, '$.boolValue')
              ))
            FROM json_each(json_extract(a.value, '$.value.arrayValue.values')) v)
         ELSE COALESCE(
           json_extract(a.value, '$.value.stringValue'),
           CAST(json_extract(a.value, '$.value.intValue') AS INTEGER),
           json_extract(a.value, '$.value.doubleValue'),
           json_extract(a.value, '$.value.boolValue')
         )
       END
     ), '{}')
     FROM json_each(COALESCE(json_extract(e.raw, '${arrPath}'), '[]')) a)`;

// Extracts service.name from the resource attributes inside `e.raw`.
const SERVICE_NAME = `
    (SELECT COALESCE(json_extract(r.value, '$.value.stringValue'), '')
     FROM json_each(COALESCE(json_extract(e.raw, '$.resource.attributes'), '[]')) r
     WHERE json_extract(r.value, '$.key') = 'service.name'
     LIMIT 1)`;

// Raw tables are the single source of truth: each row stores one full,
// self-contained OTLP entity ({ resource, scope, <entity> }) as JSON in `raw`.
// The `spans` / `logs` / `metric_points` VIEWS derive the columns the engine
// queries — nothing is duplicated. Expression indexes back the hot filters.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_spans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  raw        TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_spans_spanid ON raw_spans(json_extract(raw, '$.span.spanId'));
CREATE INDEX IF NOT EXISTS idx_raw_spans_trace ON raw_spans(json_extract(raw, '$.span.traceId'));
CREATE INDEX IF NOT EXISTS idx_raw_spans_start ON raw_spans(json_extract(raw, '$.span.startTimeUnixNano'));

CREATE TABLE IF NOT EXISTS raw_metrics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  raw        TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_raw_metrics_name ON raw_metrics(json_extract(raw, '$.metric.name'));
CREATE INDEX IF NOT EXISTS idx_raw_metrics_ts   ON raw_metrics(json_extract(raw, '$.dataPoint.timeUnixNano'));

CREATE TABLE IF NOT EXISTS raw_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  raw        TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_raw_logs_severity ON raw_logs(json_extract(raw, '$.logRecord.severityNumber'));
CREATE INDEX IF NOT EXISTS idx_raw_logs_ts       ON raw_logs(json_extract(raw, '$.logRecord.timeUnixNano'));

-- Views are derived (no stored data), so drop-and-recreate on every init to
-- pick up definition changes on existing databases without touching raw_*.
DROP VIEW IF EXISTS spans;
DROP VIEW IF EXISTS metric_points;
DROP VIEW IF EXISTS logs;

CREATE VIEW IF NOT EXISTS spans AS
  SELECT
    e.id AS id,
    json_extract(e.raw, '$.span.traceId')      AS trace_id,
    json_extract(e.raw, '$.span.spanId')       AS span_id,
    json_extract(e.raw, '$.span.parentSpanId') AS parent_span_id,
    json_extract(e.raw, '$.span.name')         AS name,
    COALESCE(json_extract(e.raw, '$.span.kind'), 0) AS kind,
    json_extract(e.raw, '$.span.startTimeUnixNano') AS start_time_unix_nano,
    json_extract(e.raw, '$.span.endTimeUnixNano')   AS end_time_unix_nano,
    (CAST(COALESCE(json_extract(e.raw, '$.span.endTimeUnixNano'),   '0') AS INTEGER)
     - CAST(COALESCE(json_extract(e.raw, '$.span.startTimeUnixNano'), '0') AS INTEGER)) / 1000000.0 AS duration_ms,
    COALESCE(json_extract(e.raw, '$.span.status.code'), 0) AS status_code,
    json_extract(e.raw, '$.span.status.message') AS status_message,
    ${flatAttrs('$.span.attributes')} AS attributes,
    ${SERVICE_NAME} AS service_name,
    e.raw AS raw
  FROM raw_spans e;

CREATE VIEW IF NOT EXISTS metric_points AS
  SELECT
    e.id AS id,
    json_extract(e.raw, '$.metric.name') AS name,
    COALESCE(
      json_extract(e.raw, '$.dataPoint.asDouble'),
      CAST(json_extract(e.raw, '$.dataPoint.asInt') AS REAL),
      json_extract(e.raw, '$.dataPoint.sum')
    ) AS value,
    COALESCE(json_extract(e.raw, '$.dataPoint.timeUnixNano'), '0') AS timestamp_unix_nano,
    ${flatAttrs('$.dataPoint.attributes')} AS attributes,
    json_extract(e.raw, '$.metric.unit') AS unit,
    ${SERVICE_NAME} AS service_name,
    e.raw AS raw
  FROM raw_metrics e;

CREATE VIEW IF NOT EXISTS logs AS
  SELECT
    e.id AS id,
    COALESCE(json_extract(e.raw, '$.logRecord.timeUnixNano'),
             json_extract(e.raw, '$.logRecord.observedTimeUnixNano'), '0') AS timestamp_unix_nano,
    COALESCE(json_extract(e.raw, '$.logRecord.severityNumber'), 0) AS severity_number,
    COALESCE(json_extract(e.raw, '$.logRecord.severityText'), '')  AS severity_text,
    COALESCE(json_extract(e.raw, '$.logRecord.body.stringValue'),
             json_extract(e.raw, '$.logRecord.body'), '') AS body,
    ${flatAttrs('$.logRecord.attributes')} AS attributes,
    json_extract(e.raw, '$.logRecord.traceId') AS trace_id,
    json_extract(e.raw, '$.logRecord.spanId')  AS span_id,
    ${SERVICE_NAME} AS service_name,
    e.raw AS raw
  FROM raw_logs e;
`;

// ── Row types ────────────────────────────────────────────────────────────────
// A stored row is just the full OTLP entity as a JSON string; the queryable
// columns are derived by the views above.

export interface SpanRow  { raw: string }
export interface MetricRow { raw: string }
export interface LogRow   { raw: string }

// ── DatabaseAdapter ───────────────────────────────────────────────────────────

/**
 * Wraps sql.js (WASM SQLite) with a synchronous API compatible with
 * the `QueryableDB` interface consumed by @otel-insights/engine.
 */
class DatabaseAdapter implements QueryableDB {
  constructor(private readonly sqlDb: SqlJs.Database) {}

  prepare(sql: string) {
    const self = this;
    return {
      all(...args: unknown[]) { return self.query(sql, args); },
      get(...args: unknown[]) { return self.query(sql, args)[0]; },
      run(...args: unknown[]) {
        self.sqlDb.run(sql, args.length ? (args as SqlJs.BindParams) : undefined);
      },
    };
  }

  exec(sql: string): void {
    this.sqlDb.run(sql);
  }

  runInTransaction<T>(rows: T[], fn: (db: SqlJs.Database, rows: T[]) => void): void {
    this.sqlDb.run('BEGIN');
    try {
      fn(this.sqlDb, rows);
      this.sqlDb.run('COMMIT');
    } catch (err) {
      this.sqlDb.run('ROLLBACK');
      throw err;
    }
  }

  private query(sql: string, args: unknown[]): Record<string, unknown>[] {
    const stmt = this.sqlDb.prepare(sql);
    if (args.length) { stmt.bind(args as SqlJs.BindParams); }
    const out: Record<string, unknown>[] = [];
    while (stmt.step()) { out.push(stmt.getAsObject() as Record<string, unknown>); }
    stmt.free();
    return out;
  }
}

// ── TelemetryStore ────────────────────────────────────────────────────────────

// Maximum rows retained per table. Oldest rows (by insertion order / autoincrement id)
// are pruned after each insert so the database never grows unbounded.
const MAX_SPANS   = 50_000;
const MAX_METRICS = 50_000;
const MAX_LOGS    = 50_000;

export class TelemetryStore {
  private sqlDb!: SqlJs.Database;
  private adapter!: DatabaseAdapter;
  private saveTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    // Dynamic require keeps sql.js external from the esbuild bundle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const initSqlJs = require('sql.js') as (cfg?: any) => Promise<SqlJs.SqlJsStatic>;
    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      this.sqlDb = new SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      this.sqlDb = new SQL.Database();
    }

    this.dropLegacyTables();

    // Run schema (sql.js only supports one statement per run() call)
    for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }

    this.adapter = new DatabaseAdapter(this.sqlDb);
    // Persist to disk every 30 s to survive crashes.
    this.saveTimer = setInterval(() => this.flush(), 30_000);
  }

  // Drops legacy layouts left by earlier extension versions.
  private dropLegacyTables(): void {
    const isTable = (name: string): boolean => {
      const res = this.sqlDb.exec(
        `SELECT type FROM sqlite_master WHERE name = '${name}'`,
      )[0];
      return res?.values?.[0]?.[0] === 'table';
    };
    for (const name of ['spans', 'metric_points', 'logs']) {
      if (isTable(name)) { this.sqlDb.run(`DROP TABLE ${name}`); }
    }
  }

  getDb(): QueryableDB {
    return this.adapter;
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  insertSpans(rows: SpanRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      // INSERT OR IGNORE dedupes by span_id via the unique expression index.
      const s = db.prepare(`INSERT OR IGNORE INTO raw_spans (raw) VALUES (?)`);
      for (const r of rs) { s.run([r.raw]); }
      s.free();
    });
    this.pruneTable('raw_spans', MAX_SPANS);
  }

  insertMetrics(rows: MetricRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(`INSERT INTO raw_metrics (raw) VALUES (?)`);
      for (const r of rs) { s.run([r.raw]); }
      s.free();
    });
    this.pruneTable('raw_metrics', MAX_METRICS);
  }

  insertLogs(rows: LogRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(`INSERT INTO raw_logs (raw) VALUES (?)`);
      for (const r of rs) { s.run([r.raw]); }
      s.free();
    });
    this.pruneTable('raw_logs', MAX_LOGS);
  }

  /**
   * Deletes the oldest rows in `table` (by autoincrement `id`, i.e. insertion order)
   * once its row count exceeds `maxRows`, keeping only the most recent `maxRows` rows.
   */
  private pruneTable(table: 'raw_spans' | 'raw_metrics' | 'raw_logs', maxRows: number): void {
    const countRow = this.sqlDb.exec(`SELECT COUNT(*) AS c FROM ${table}`)[0];
    const count = Number(countRow?.values?.[0]?.[0] ?? 0);
    if (count <= maxRows) { return; }
    this.sqlDb.run(
      `DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ${maxRows})`,
    );
  }

  clear(): void {
    for (const tbl of ['raw_spans', 'raw_metrics', 'raw_logs']) {
      this.sqlDb.run(`DELETE FROM ${tbl}`);
    }
    this.flush();
  }

  flush(): void {
    const data = this.sqlDb.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    if (this.saveTimer) { clearInterval(this.saveTimer); }
    this.flush();
    this.sqlDb.close();
  }
}
