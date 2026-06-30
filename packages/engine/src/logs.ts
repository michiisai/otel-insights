import type { QueryableDB, LogRecord } from '@otel-insights/types';

export interface LogQueryOptions {
  filter?: string;
  minSeverity?: number;
  limit?: number;
}

export function getLogs(db: QueryableDB, opts: LogQueryOptions = {}): LogRecord[] {
  const { filter = '', minSeverity = 0, limit = 500 } = opts;

  const conditions: string[] = ['severity_number >= ?'];
  const params: unknown[]   = [minSeverity];

  if (filter.trim()) {
    conditions.push('(body LIKE ? OR service_name LIKE ? OR severity_text LIKE ?)');
    const like = `%${filter.trim()}%`;
    params.push(like, like, like);
  }

  const rows = db.prepare(`
    SELECT * FROM logs
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp_unix_nano DESC, id DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map(r => ({
    id:                Number(r['id']                 ?? 0),
    timestampUnixNano: String(r['timestamp_unix_nano'] ?? '0'),
    severityNumber:    Number(r['severity_number']    ?? 0),
    severityText:      String(r['severity_text']      ?? ''),
    body:              String(r['body']               ?? ''),
    attributes:        parseJson(r['attributes']),
    traceId:           r['trace_id'] != null ? String(r['trace_id']) : null,
    spanId:            r['span_id']  != null ? String(r['span_id'])  : null,
    serviceName:       String(r['service_name']       ?? ''),
  }));
}

function parseJson(v: unknown): Record<string, unknown> {
  try { return JSON.parse(String(v ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}
