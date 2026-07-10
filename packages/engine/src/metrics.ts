import type { QueryableDB, MetricsData } from '@otel-insights/types';

// IMPORTANT: OTel attributes are stored as a flat JSON object with dotted keys,
// e.g. {"gen_ai.request.model": "gpt-4o"}.
// SQLite's json_extract treats unquoted dots as nested-object path separators, so
// every dotted key MUST be quoted inside the path string:
//   CORRECT:  json_extract(attributes, '$."gen_ai.request.model"')
//   WRONG:    json_extract(attributes, '$.gen_ai.request.model')  ← always returns NULL

export function getMetricsData(db: QueryableDB, sinceNano?: string, untilNano?: string): MetricsData {
  const spanParts: string[] = [];
  const spanParams: unknown[] = [];
  if (sinceNano) { spanParts.push('start_time_unix_nano >= ?'); spanParams.push(sinceNano); }
  if (untilNano) { spanParts.push('start_time_unix_nano <= ?'); spanParams.push(untilNano); }
  const spanWhere = spanParts.length ? `WHERE ${spanParts.join(' AND ')}` : '';

  // Slowest operations aggregated by span name
  const slowestOps = db.prepare(`
    SELECT
      name,
      AVG(duration_ms) AS avg_duration_ms,
      MAX(duration_ms) AS max_duration_ms,
      COUNT(*)         AS count,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
    FROM spans
    ${spanWhere}
    GROUP BY name
    ORDER BY avg_duration_ms DESC
    LIMIT 25
  `).all(...spanParams);

  // Token usage — supports both OTel GenAI semconv and common llm.* conventions
  const tokenTimeClause = spanParams.length
    ? `${spanWhere}\n       AND (`
    : 'WHERE (';
  const tokenRows = db.prepare(`
    SELECT
      COALESCE(
        json_extract(attributes, '$."gen_ai.request.model"'),
        json_extract(attributes, '$."llm.model"'),
        'unknown'
      ) AS model,
      SUM(COALESCE(
        CAST(json_extract(attributes, '$."gen_ai.usage.input_tokens"')   AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.prompt_tokens"')     AS REAL),
        0
      )) AS prompt_tokens,
      SUM(COALESCE(
        CAST(json_extract(attributes, '$."gen_ai.usage.output_tokens"')      AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.completion_tokens"')     AS REAL),
        0
      )) AS completion_tokens,
      COUNT(*) AS call_count
    FROM spans
    ${tokenTimeClause}
        json_extract(attributes, '$."gen_ai.request.model"') IS NOT NULL
        OR json_extract(attributes, '$."llm.model"')         IS NOT NULL
      )
    GROUP BY model
    ORDER BY (prompt_tokens + completion_tokens) DESC
  `).all(...spanParams);

  // Tool calls — spans tagged with gen_ai.tool.name or tool.name
  const toolTimeClause = spanParams.length
    ? `${spanWhere}\n       AND (`
    : 'WHERE (';
  const toolRows = db.prepare(`
    SELECT
      COALESCE(
        json_extract(attributes, '$."gen_ai.tool.name"'),
        json_extract(attributes, '$."tool.name"'),
        json_extract(attributes, '$."tool_name"'),
        name
      ) AS tool_name,
      COUNT(*)         AS count,
      AVG(duration_ms) AS avg_duration_ms,
      SUM(duration_ms) AS total_duration_ms,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
    FROM spans
    ${toolTimeClause}
        json_extract(attributes, '$."gen_ai.tool.name"') IS NOT NULL
        OR json_extract(attributes, '$."tool.name"')     IS NOT NULL
        OR json_extract(attributes, '$."tool_name"')     IS NOT NULL
        OR name LIKE 'tool.%'
        OR name LIKE 'tool:%'
      )
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 25
  `).all(...spanParams);

  // Derive aggregate stats from already-fetched rows
  const llmCalls       = tokenRows.reduce((sum, r) => sum + Number(r['call_count']        ?? 0), 0);
  const toolCallsTotal = toolRows.reduce((sum, r)  => sum + Number(r['count']             ?? 0), 0);
  const inputTokens    = Math.round(tokenRows.reduce((sum, r) => sum + Number(r['prompt_tokens']     ?? 0), 0));
  const outputTokens   = Math.round(tokenRows.reduce((sum, r) => sum + Number(r['completion_tokens'] ?? 0), 0));

  // Cache read tokens only (tokens served from cache = "cache hit").
  // cache_creation tokens are NOT included — they are a write cost, not a hit.
  const cachedAndClause = spanWhere ? `${spanWhere} AND` : 'WHERE';
  const cachedRow = db.prepare(`
    SELECT
      SUM(COALESCE(
        CAST(json_extract(attributes, '$."gen_ai.usage.cache_read.input_tokens"') AS REAL),
        CAST(json_extract(attributes, '$."gen_ai.usage.cache_read_input_tokens"') AS REAL),
        CAST(json_extract(attributes, '$."gen_ai.usage.cached_tokens"')           AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.cache_read_input_tokens"')    AS REAL),
        CAST(json_extract(attributes, '$."llm.usage.cached_tokens"')              AS REAL),
        0
      )) AS cached_tokens
    FROM spans
    ${cachedAndClause} (
      json_extract(attributes, '$."gen_ai.usage.cache_read.input_tokens"') IS NOT NULL
      OR json_extract(attributes, '$."gen_ai.usage.cache_read_input_tokens"') IS NOT NULL
      OR json_extract(attributes, '$."gen_ai.usage.cached_tokens"')           IS NOT NULL
      OR json_extract(attributes, '$."llm.usage.cache_read_input_tokens"')    IS NOT NULL
      OR json_extract(attributes, '$."llm.usage.cached_tokens"')              IS NOT NULL
    )
  `).get(...spanParams);
  const cachedTokens = Math.round(Number(cachedRow?.['cached_tokens'] ?? 0));

  // P95 latency from root spans only
  const rootDurRows = db.prepare(`
    SELECT duration_ms FROM spans
    ${spanWhere ? `${spanWhere} AND` : 'WHERE'} (parent_span_id IS NULL OR parent_span_id = '')
    ORDER BY duration_ms ASC
  `).all(...spanParams);
  const p95Ms = percentile(rootDurRows.map(r => Number(r['duration_ms'] ?? 0)), 0.95);

  // Counts for spans use start_time_unix_nano; logs/metrics use timestamp_unix_nano
  const logParts: string[] = [];
  const logParams: unknown[] = [];
  if (sinceNano) { logParts.push('timestamp_unix_nano >= ?'); logParams.push(sinceNano); }
  if (untilNano) { logParts.push('timestamp_unix_nano <= ?'); logParams.push(untilNano); }
  const logWhere = logParts.length ? `WHERE ${logParts.join(' AND ')}` : '';

  const summaryParams: unknown[] = [...spanParams, ...spanParams, ...logParams, ...logParams, ...spanParams];
  const errorWhere = spanWhere ? `${spanWhere} AND status_code = 2` : `WHERE status_code = 2`;
  const summary = db.prepare(`
    SELECT
      (SELECT COUNT(*)                 FROM spans         ${spanWhere})  AS total_spans,
      (SELECT COUNT(DISTINCT trace_id) FROM spans         ${spanWhere})  AS total_traces,
      (SELECT COUNT(*)                 FROM logs          ${logWhere})   AS total_logs,
      (SELECT COUNT(*)                 FROM metric_points ${logWhere})   AS total_metric_points,
      (SELECT COUNT(DISTINCT trace_id) FROM spans         ${errorWhere}) AS error_traces
  `).get(...summaryParams);

  return {
    slowestOperations: slowestOps.map(r => ({
      name:          String(r['name']          ?? ''),
      avgDurationMs: round2(Number(r['avg_duration_ms'] ?? 0)),
      maxDurationMs: round2(Number(r['max_duration_ms'] ?? 0)),
      count:         Number(r['count']         ?? 0),
      errorCount:    Number(r['error_count']   ?? 0),
    })),

    tokenUsage: tokenRows.map(r => {
      const prompt     = Number(r['prompt_tokens']     ?? 0);
      const completion = Number(r['completion_tokens'] ?? 0);
      return {
        model:            String(r['model'] ?? 'unknown'),
        totalTokens:      Math.round(prompt + completion),
        promptTokens:     Math.round(prompt),
        completionTokens: Math.round(completion),
        callCount:        Number(r['call_count'] ?? 0),
      };
    }),

    toolCalls: toolRows.map(r => ({
      toolName:        String(r['tool_name']        ?? ''),
      count:           Number(r['count']            ?? 0),
      avgDurationMs:   round2(Number(r['avg_duration_ms']   ?? 0)),
      totalDurationMs: round2(Number(r['total_duration_ms'] ?? 0)),
      errorCount:      Number(r['error_count']      ?? 0),
    })),

    summary: {
      totalSpans:        Number(summary?.['total_spans']         ?? 0),
      totalTraces:       Number(summary?.['total_traces']        ?? 0),
      totalLogs:         Number(summary?.['total_logs']          ?? 0),
      totalMetricPoints: Number(summary?.['total_metric_points'] ?? 0),
      llmCalls,
      toolCallsTotal,
      inputTokens,
      outputTokens,
      cachedTokens,
      errorTraces:       Number(summary?.['error_traces']        ?? 0),
      p95Ms,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) { return 0; }
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
