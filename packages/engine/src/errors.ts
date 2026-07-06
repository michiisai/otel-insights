import type { QueryableDB, Trace } from '@otel-insights/types';

export interface ErrorSpanSummary {
  spanId: string;
  name: string;
  statusMessage: string | null;
  durationMs: number;
  exceptionType: string | null;
  exceptionMessage: string | null;
}

export interface ErrorTrace extends Trace {
  errorSpans: ErrorSpanSummary[];
}

export function getRecentErrorTraces(db: QueryableDB, limit = 10): ErrorTrace[] {
  const traceRows = db.prepare(`
    SELECT
      trace_id,
      MIN(start_time_unix_nano)  AS start_time_unix_nano,
      COUNT(*)                   AS span_count,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count,
      MAX(CASE WHEN (parent_span_id IS NULL OR parent_span_id = '')
               THEN name END)    AS root_span_name,
      MAX(service_name)          AS service_name,
      MAX(CASE WHEN (parent_span_id IS NULL OR parent_span_id = '')
               THEN duration_ms  ELSE 0 END) AS root_duration_ms
    FROM spans
    GROUP BY trace_id
    HAVING SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) > 0
    ORDER BY MIN(start_time_unix_nano) DESC
    LIMIT ?
  `).all(limit);

  return traceRows.map(r => {
    const traceId = String(r['trace_id'] ?? '');

    const errorSpanRows = db.prepare(`
      SELECT span_id, name, status_message, duration_ms, attributes
      FROM spans
      WHERE trace_id = ? AND status_code = 2
      ORDER BY start_time_unix_nano ASC
    `).all(traceId);

    const errorSpans: ErrorSpanSummary[] = errorSpanRows.map(s => {
      const attrs = parseJson(s['attributes']);
      return {
        spanId: String(s['span_id'] ?? ''),
        name: String(s['name'] ?? ''),
        statusMessage: s['status_message'] != null ? String(s['status_message']) : null,
        durationMs: Number(s['duration_ms'] ?? 0),
        exceptionType: attrs['exception.type'] != null ? String(attrs['exception.type']) : null,
        exceptionMessage: attrs['exception.message'] != null ? String(attrs['exception.message']) : null,
      };
    });

    return {
      traceId,
      rootSpanName:      String(r['root_span_name'] ?? r['trace_id'] ?? ''),
      serviceName:       String(r['service_name'] ?? ''),
      startTimeUnixNano: String(r['start_time_unix_nano'] ?? '0'),
      durationMs:        Number(r['root_duration_ms'] ?? 0),
      spanCount:         Number(r['span_count'] ?? 0),
      hasError:          true,
      errorSpans,
    };
  });
}

function parseJson(v: unknown): Record<string, unknown> {
  try { return JSON.parse(String(v ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}
