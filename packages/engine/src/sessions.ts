import type { QueryableDB, Session } from '@otel-insights/types';

/**
 * SQL expression that resolves a session id for a group of spans sharing a
 * trace_id. The id lives on some spans (e.g. `chat`) but not others (e.g.
 * `permission`, `execute_tool`), so it must be resolved at the trace level —
 * a trace inherits its session id from any span that carries one. Falls back
 * to trace_id (a safety net that does not fire for real agent traces, which
 * always carry a conversation/session id somewhere in the trace).
 *
 * MUST be used inside a `GROUP BY trace_id` context (it uses MAX aggregates).
 */
export const SESSION_ID_EXPR = `COALESCE(
  MAX(json_extract(attributes,'$."gen_ai.conversation.id"')),
  MAX(json_extract(attributes,'$."session.id"')),
  MAX(json_extract(attributes,'$."copilot_chat.chat_session_id"')),
  trace_id
)`;

/**
 * Sessions exclude copilot-chat: those spans are plain vscode LM API / utility
 * calls (title & summary generation, embeddings) with no conversation key —
 * they are surfaced separately (Home), not as agent sessions.
 */
export const SESSION_TRACE_FILTER = `service_name != 'copilot-chat'`;

/** Span-name predicate: an LLM request/chat turn. */
const LLM_PREDICATE  = `(name LIKE 'chat %' OR name = 'chat' OR name LIKE '%llm_request%')`;
/** Span-name predicate: a single tool execution (avoids double-counting claude's tool wrapper spans). */
const TOOL_PREDICATE = `(name LIKE 'execute_tool%' OR name LIKE '%tool.execution%')`;

/** Token attributes summed for the session token total (gen_ai semconv). */
const TOKENS_EXPR = `(
  COALESCE(CAST(json_extract(attributes,'$."gen_ai.usage.input_tokens"')  AS INTEGER), 0) +
  COALESCE(CAST(json_extract(attributes,'$."gen_ai.usage.output_tokens"') AS INTEGER), 0)
)`;

export interface GetSessionsOptions {
  limit?: number;
  errorsOnly?: boolean;
  nameSearch?: string;
  sortOrder?: 'desc' | 'asc';
}

/**
 * Lists agent sessions — conversations grouping multiple traces — newest first.
 * Each row aggregates the session's traces/spans, LLM-request and tool-call
 * counts, distinct models, token total, and failure state.
 */
export function getSessions(db: QueryableDB, opts: GetSessionsOptions = {}): Session[] {
  const { limit = 500, errorsOnly, nameSearch, sortOrder = 'desc' } = opts;

  const params: unknown[] = [];

  // Per-trace search: match a session if any of its traces matches the term
  // (trace id, span name, span id, or attribute values).
  let searchClause = '';
  if (nameSearch) {
    searchClause = `AND trace_id IN (
      SELECT DISTINCT trace_id FROM spans
      WHERE name LIKE ? OR span_id LIKE ? OR trace_id LIKE ? OR attributes LIKE ?
    )`;
  }

  // 1) Resolve each trace to its session id (and carry per-trace rollups).
  // 2) Aggregate traces into sessions.
  const sql = `
    WITH trace_session AS (
      SELECT
        trace_id,
        ${SESSION_ID_EXPR}                       AS session_id,
        MAX(service_name)                        AS service_name,
        MIN(start_time_unix_nano)                AS trace_start,
        MAX(end_time_unix_nano)                  AS trace_end,
        COUNT(*)                                 AS span_count,
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)      AS error_count,
        SUM(CASE WHEN ${LLM_PREDICATE}  THEN 1 ELSE 0 END)   AS llm_count,
        SUM(CASE WHEN ${TOOL_PREDICATE} THEN 1 ELSE 0 END)   AS tool_count,
        SUM(${TOKENS_EXPR})                      AS token_sum,
        group_concat(DISTINCT json_extract(attributes,'$."gen_ai.request.model"')) AS models,
        MAX(CASE WHEN status_code = 2 THEN status_message END) AS failure_reason
      FROM spans
      WHERE ${SESSION_TRACE_FILTER}
      ${searchClause}
      GROUP BY trace_id
    )
    SELECT
      session_id,
      MAX(service_name)              AS service_name,
      MIN(trace_start)              AS start_time_unix_nano,
      MAX(trace_end)               AS end_time_unix_nano,
      COUNT(*)                      AS trace_count,
      SUM(span_count)              AS span_count,
      SUM(error_count)             AS error_count,
      SUM(llm_count)               AS llm_request_count,
      SUM(tool_count)              AS tool_call_count,
      SUM(token_sum)               AS total_tokens,
      group_concat(models)         AS models,
      MAX(failure_reason)          AS failure_reason
    FROM trace_session
    GROUP BY session_id
    ${errorsOnly ? 'HAVING SUM(error_count) > 0' : ''}
    ORDER BY MIN(trace_start) ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
    LIMIT ?
  `;

  if (nameSearch) {
    const like = `%${nameSearch}%`;
    params.push(like, like, like, like);
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  return rows.map(r => {
    const startNano = String(r['start_time_unix_nano'] ?? '0');
    const endNano   = String(r['end_time_unix_nano']   ?? '0');
    return {
      sessionId:         String(r['session_id']        ?? ''),
      serviceName:       String(r['service_name']      ?? ''),
      models:            dedupeModels(r['models']),
      startTimeUnixNano: startNano,
      endTimeUnixNano:   endNano,
      durationMs:        nanoSpanMs(startNano, endNano),
      traceCount:        Number(r['trace_count']       ?? 0),
      spanCount:         Number(r['span_count']        ?? 0),
      llmRequestCount:   Number(r['llm_request_count'] ?? 0),
      toolCallCount:     Number(r['tool_call_count']   ?? 0),
      totalTokens:       Number(r['total_tokens']      ?? 0),
      hasError:          Number(r['error_count']       ?? 0) > 0,
      failureReason:     r['failure_reason'] != null ? String(r['failure_reason']) : null,
    };
  });
}

/** Splits a comma-joined group_concat of model names into a unique, non-empty list. */
function dedupeModels(v: unknown): string[] {
  if (v == null) { return []; }
  const seen = new Set<string>();
  for (const part of String(v).split(',')) {
    const m = part.trim();
    if (m && m !== 'null') { seen.add(m); }
  }
  return [...seen];
}

/** Wall-clock ms between two epoch-nanosecond strings (BigInt-safe). */
function nanoSpanMs(startNano: string, endNano: string): number {
  try {
    const ms = (BigInt(endNano) - BigInt(startNano)) / 1_000_000n;
    return ms > 0n ? Number(ms) : 0;
  } catch {
    return 0;
  }
}
