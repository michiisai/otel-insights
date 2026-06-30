import * as fs from 'fs';
import * as path from 'path';
import type SqlJs from 'sql.js';
import type { QueryableDB } from '@otel-insights/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id             TEXT    NOT NULL,
  span_id              TEXT    NOT NULL UNIQUE,
  parent_span_id       TEXT,
  name                 TEXT    NOT NULL,
  kind                 INTEGER NOT NULL DEFAULT 0,
  start_time_unix_nano TEXT    NOT NULL,
  end_time_unix_nano   TEXT    NOT NULL,
  duration_ms          REAL    NOT NULL DEFAULT 0,
  status_code          INTEGER NOT NULL DEFAULT 0,
  status_message       TEXT,
  attributes           TEXT    NOT NULL DEFAULT '{}',
  service_name         TEXT    NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_spans_trace   ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_name    ON spans(name);
CREATE INDEX IF NOT EXISTS idx_spans_start   ON spans(start_time_unix_nano);
CREATE INDEX IF NOT EXISTS idx_spans_service ON spans(service_name);

CREATE TABLE IF NOT EXISTS metric_points (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  value                REAL,
  timestamp_unix_nano  TEXT    NOT NULL DEFAULT '0',
  attributes           TEXT    NOT NULL DEFAULT '{}',
  unit                 TEXT,
  service_name         TEXT    NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_metric_name ON metric_points(name);
CREATE INDEX IF NOT EXISTS idx_metric_ts   ON metric_points(timestamp_unix_nano);

CREATE TABLE IF NOT EXISTS logs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_unix_nano  TEXT    NOT NULL DEFAULT '0',
  severity_number      INTEGER NOT NULL DEFAULT 0,
  severity_text        TEXT    NOT NULL DEFAULT '',
  body                 TEXT    NOT NULL DEFAULT '',
  attributes           TEXT    NOT NULL DEFAULT '{}',
  trace_id             TEXT,
  span_id              TEXT,
  service_name         TEXT    NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_logs_severity ON logs(severity_number);
CREATE INDEX IF NOT EXISTS idx_logs_ts       ON logs(timestamp_unix_nano);
CREATE INDEX IF NOT EXISTS idx_logs_trace    ON logs(trace_id);
`;

// ── Row types ────────────────────────────────────────────────────────────────

export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  statusCode: number;
  statusMessage: string | null;
  attributes: string;
  serviceName: string;
}

export interface MetricRow {
  name: string;
  value: number | null;
  timestampUnixNano: string;
  attributes: string;
  unit: string | null;
  serviceName: string;
}

export interface LogRow {
  timestampUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: string;
  traceId: string | null;
  spanId: string | null;
  serviceName: string;
}

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

    // Run schema (sql.js only supports one statement per run() call)
    for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
      this.sqlDb.run(stmt);
    }

    this.adapter = new DatabaseAdapter(this.sqlDb);
    // Persist to disk every 30 s to survive crashes.
    this.saveTimer = setInterval(() => this.flush(), 30_000);
  }

  getDb(): QueryableDB {
    return this.adapter;
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  insertSpans(rows: SpanRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(`
        INSERT OR IGNORE INTO spans
          (trace_id, span_id, parent_span_id, name, kind,
           start_time_unix_nano, end_time_unix_nano, duration_ms,
           status_code, status_message, attributes, service_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const r of rs) {
        s.run([r.traceId, r.spanId, r.parentSpanId, r.name, r.kind,
               r.startTimeUnixNano, r.endTimeUnixNano, r.durationMs,
               r.statusCode, r.statusMessage, r.attributes, r.serviceName]);
      }
      s.free();
    });
  }

  insertMetrics(rows: MetricRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(`
        INSERT INTO metric_points
          (name, value, timestamp_unix_nano, attributes, unit, service_name)
        VALUES (?,?,?,?,?,?)
      `);
      for (const r of rs) {
        s.run([r.name, r.value, r.timestampUnixNano, r.attributes, r.unit, r.serviceName]);
      }
      s.free();
    });
  }

  insertLogs(rows: LogRow[]): void {
    if (!rows.length) { return; }
    this.adapter.runInTransaction(rows, (db, rs) => {
      const s = db.prepare(`
        INSERT INTO logs
          (timestamp_unix_nano, severity_number, severity_text,
           body, attributes, trace_id, span_id, service_name)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      for (const r of rs) {
        s.run([r.timestampUnixNano, r.severityNumber, r.severityText,
               r.body, r.attributes, r.traceId, r.spanId, r.serviceName]);
      }
      s.free();
    });
  }

  clear(): void {
    for (const tbl of ['spans', 'metric_points', 'logs']) {
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
