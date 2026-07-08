import * as vscode from 'vscode';
import type { TelemetryStore } from '@otel-insights/receiver';
import {
  getRecentErrorTraces,
  getSpansByTraceId,
  getTraces,
  getMetricsData,
  getLogs,
  getServiceNames,
  getServiceSummary,
  parseSinceNano,
  parseUntilNano,
  type GetTracesOptions,
} from '@otel-insights/engine';

// convert nanoseconds to ISO date string, or return the original string if invalid
function nanoToDate(nano: string): string {
  try {
    const ms = Number(BigInt(nano) / 1_000_000n);
    return new Date(ms).toISOString();
  } catch {
    return nano;
  }
}

function severityLabel(n: number): string {
  if (n === 0)  { return 'UNSPEC'; }
  if (n <= 4)   { return 'TRACE'; }
  if (n <= 8)   { return 'DEBUG'; }
  if (n <= 12)  { return 'INFO'; }
  if (n <= 16)  { return 'WARN'; }
  if (n <= 20)  { return 'ERROR'; }
  return 'FATAL';
}

const SPAN_KIND: Record<number, string> = {
  0: 'UNSPECIFIED', 1: 'INTERNAL', 2: 'SERVER', 3: 'CLIENT', 4: 'PRODUCER', 5: 'CONSUMER',
};

const SPAN_STATUS: Record<number, string> = { 0: 'UNSET', 1: 'OK', 2: 'ERROR' };

interface TokenSummary {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
}

/** Aggregate gen_ai / llm token attributes across a set of spans, grouped by model. */
function aggregateTokens(spans: { attributes: Record<string, unknown> }[]): TokenSummary[] {
  const byModel = new Map<string, TokenSummary>();

  for (const s of spans) {
    const a = s.attributes;
    const model = String(
      a['gen_ai.request.model'] ?? a['llm.model'] ?? ''
    );
    const prompt = Number(a['gen_ai.usage.input_tokens'] ?? a['llm.usage.prompt_tokens'] ?? 0);
    const completion = Number(a['gen_ai.usage.output_tokens'] ?? a['llm.usage.completion_tokens'] ?? 0);

    if (!model && prompt === 0 && completion === 0) { continue; }

    const key = model || 'unknown';
    const existing = byModel.get(key);
    if (existing) {
      existing.promptTokens     += prompt;
      existing.completionTokens += completion;
      existing.totalTokens      += prompt + completion;
      existing.callCount        += 1;
    } else {
      byModel.set(key, {
        model: key,
        promptTokens:     prompt,
        completionTokens: completion,
        totalTokens:      prompt + completion,
        callCount:        1,
      });
    }
  }

  return [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}


interface FindRecentErrorsInput {
  limit?: number;
  since?: string;
  until?: string;
}

class FindRecentErrorsTool implements vscode.LanguageModelTool<FindRecentErrorsInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindRecentErrorsInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const limit = options.input.limit ?? 5;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const errors = getRecentErrorTraces(this.store.getDb(), limit, sinceNano ?? undefined, untilNano ?? undefined);

    if (!errors.length) {
      const qualifier = (sinceNano || untilNano) ? ` in the requested time window` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No error traces found${qualifier} in the telemetry store.`),
      ]);
    }

    const lines: string[] = [`Found ${errors.length} error trace(s) — most recent first:\n`];

    for (const t of errors) {
      lines.push(`## ${t.rootSpanName} [${t.serviceName}]`);
      lines.push(`- traceId: ${t.traceId}`);
      lines.push(`- time: ${nanoToDate(t.startTimeUnixNano)}`);
      lines.push(`- duration: ${t.durationMs}ms | spans: ${t.spanCount} | errors: ${t.errorSpans.length}`);

      for (const es of t.errorSpans) {
        lines.push(`\n  ❌ span: ${es.name} (${es.durationMs}ms)`);
        if (es.statusMessage)   { lines.push(`     status: ${es.statusMessage}`); }
        if (es.exceptionType)   { lines.push(`     exception.type: ${es.exceptionType}`); }
        if (es.exceptionMessage) { lines.push(`     exception.message: ${es.exceptionMessage}`); }
      }
      lines.push('');
    }

    lines.push('To inspect the full span tree for a trace, call getTrace with its traceId.');

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetErrorTraceInput {
  traceId: string;
}

/** Attributes surfaced in the trace drill-down. */
const NOTABLE_ATTRS = [
  'exception.type', 'exception.message', 'exception.stacktrace',
  'gen_ai.request.model', 'gen_ai.tool.name',
  'http.method', 'http.url', 'http.status_code',
  'db.system', 'db.statement',
  'rpc.method', 'rpc.service',
];

class GetAgentMetricsTool implements vscode.LanguageModelTool<{ since?: string; until?: string }> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { tokenUsage, toolCalls } = getMetricsData(this.store.getDb(), sinceNano ?? undefined, untilNano ?? undefined);

    const hasTokens = tokenUsage.length > 0;
    const hasTools  = toolCalls.length > 0;

    if (!hasTokens && !hasTools) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No agent metrics found. Make sure your LLM spans include ' +
          'gen_ai.usage.input_tokens / gen_ai.usage.output_tokens (token usage) ' +
          'and gen_ai.tool.name or tool.name (tool calls).',
        ),
      ]);
    }

    const lines: string[] = ['# Agent Metrics\n'];

    if (hasTokens) {
      const grandTotal = tokenUsage.reduce((s, r) => s + r.totalTokens, 0);
      lines.push(`## Token Usage — ${grandTotal.toLocaleString()} tokens total\n`);
      for (const r of tokenUsage) {
        const ratio = r.promptTokens > 0
          ? (r.completionTokens / r.promptTokens).toFixed(2)
          : 'N/A';
        lines.push(`### ${r.model}`);
        lines.push(`- Calls: ${r.callCount}`);
        lines.push(`- Total: ${r.totalTokens.toLocaleString()} (${r.promptTokens.toLocaleString()} in / ${r.completionTokens.toLocaleString()} out, ratio ${ratio})`);
        lines.push('');
      }
    } else {
      lines.push('_No token usage data. Ensure LLM spans carry gen_ai.usage.input_tokens / output_tokens._\n');
    }

    if (hasTools) {
      const totalCalls  = toolCalls.reduce((s, r) => s + r.count, 0);
      const totalErrors = toolCalls.reduce((s, r) => s + r.errorCount, 0);
      const overallErrorPct = ((totalErrors / totalCalls) * 100).toFixed(1);
      lines.push(`## Tool Calls — ${totalCalls} total | ${totalErrors} errors (${overallErrorPct}%)\n`);
      for (const r of toolCalls) {
        const errorPct = r.count > 0 ? ((r.errorCount / r.count) * 100).toFixed(1) : '0.0';
        const flag = r.errorCount > 0 ? '⚠️' : '✅';
        lines.push(`${flag} **${r.toolName}**`);
        lines.push(`- Calls: ${r.count} | Errors: ${r.errorCount} (${errorPct}%)`);
        lines.push(`- Avg duration: ${r.avgDurationMs}ms | Total time: ${r.totalDurationMs}ms`);
        lines.push('');
      }
    } else {
      lines.push('_No tool call data. Ensure agent spans carry gen_ai.tool.name or tool.name._\n');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetSlowestSpansInput {
  limit?: number;
  since?: string;
  until?: string;
}

class GetSlowestSpansTool implements vscode.LanguageModelTool<GetSlowestSpansInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSlowestSpansInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const limit = options.input.limit ?? 10;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { slowestOperations } = getMetricsData(this.store.getDb(), sinceNano ?? undefined, untilNano ?? undefined);
    const ops = slowestOperations.slice(0, limit);

    if (!ops.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No span data found.'),
      ]);
    }

    const lines: string[] = [`# Slowest Operations (by average duration)\n`];

    ops.forEach((op, i) => {
      const errorPct = op.count > 0 ? ((op.errorCount / op.count) * 100).toFixed(1) : '0.0';
      const flag = op.errorCount > 0 ? ' ⚠️' : '';
      lines.push(`${i + 1}. **${op.name}**${flag}`);
      lines.push(`   avg: ${op.avgDurationMs}ms | max: ${op.maxDurationMs}ms | calls: ${op.count} | errors: ${op.errorCount} (${errorPct}%)`);
    });

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface SearchLogsInput {
  query: string;
  minSeverity?: number;
  limit?: number;
  since?: string;
  until?: string;
}

class SearchLogsTool implements vscode.LanguageModelTool<SearchLogsInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchLogsInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { query = '', minSeverity = 0, limit = 50 } = options.input;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const logs = getLogs(this.store.getDb(), { filter: query, minSeverity, limit, sinceNano: sinceNano ?? undefined, untilNano: untilNano ?? undefined });

    if (!logs.length) {
      const qualifier = query ? ` matching "${query}"` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No logs found${qualifier}.`),
      ]);
    }

    const lines: string[] = [
      `# Log Search${query ? `: "${query}"` : ''} — ${logs.length} result(s)\n`,
    ];

    for (const log of logs) {
      const time = nanoToDate(log.timestampUnixNano);
      const sev  = severityLabel(log.severityNumber);
      lines.push(`[${time}] [${sev}] [${log.serviceName}] ${log.body}`);
      if (log.traceId) { lines.push(`  → traceId: ${log.traceId}`); }
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

// high-level overview of recent telemetry data, including counts, health metrics, slowest operations, token usage, and tool calls.
class SummarizeRecentActivityTool implements vscode.LanguageModelTool<{ since?: string; until?: string }> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ since?: string; until?: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const db = this.store.getDb();
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);
    const { summary, slowestOperations, tokenUsage, toolCalls } = getMetricsData(db, sinceNano ?? undefined, untilNano ?? undefined);

    if (summary.totalSpans === 0 && summary.totalLogs === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No telemetry data yet. Point your OTLP exporter at the receiver to start collecting data.',
        ),
      ]);
    }

    const timeAndParts: string[] = [];
    const timeParam: unknown[] = [];
    if (sinceNano) { timeAndParts.push('AND start_time_unix_nano >= ?'); timeParam.push(sinceNano); }
    if (untilNano) { timeAndParts.push('AND start_time_unix_nano <= ?'); timeParam.push(untilNano); }
    const timeAnd = timeAndParts.join(' ');

    const errorStats = db.prepare(`
      SELECT
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)             AS error_spans,
        COUNT(DISTINCT CASE WHEN status_code = 2 THEN trace_id END)  AS error_traces
      FROM spans
      WHERE 1=1 ${timeAnd}
    `).get(...timeParam);

    const errorSpans  = Number(errorStats?.['error_spans']  ?? 0);
    const errorTraces = Number(errorStats?.['error_traces'] ?? 0);
    const errorRate   = summary.totalSpans > 0
      ? ((errorSpans / summary.totalSpans) * 100).toFixed(1)
      : '0.0';

    // p95 latency from root spans, computed in JS to avoid SQLite dynamic OFFSET
    const durationRows = db.prepare(`
      SELECT duration_ms FROM spans
      WHERE (parent_span_id IS NULL OR parent_span_id = '') ${timeAnd}
      ORDER BY duration_ms ASC
    `).all(...timeParam);
    const durations = durationRows.map(r => Number(r['duration_ms'] ?? 0));
    const p95 = durations.length > 0
      ? durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1]
      : 0;

    const lines: string[] = ['# Recent Activity Summary\n'];

    lines.push('## Counts');
    lines.push(`- Traces: ${summary.totalTraces}`);
    lines.push(`- Spans: ${summary.totalSpans}`);
    lines.push(`- Logs: ${summary.totalLogs}`);
    lines.push(`- Metric points: ${summary.totalMetricPoints}`);

    lines.push('\n## Health');
    lines.push(`- Error traces: ${errorTraces} / ${summary.totalTraces}`);
    lines.push(`- Span error rate: ${errorRate}% (${errorSpans} errored span(s))`);
    lines.push(`- p95 trace duration: ${p95}ms`);

    if (slowestOperations.length) {
      const top = slowestOperations[0];
      lines.push('\n## Slowest operation');
      lines.push(`- ${top.name} — avg ${top.avgDurationMs}ms, max ${top.maxDurationMs}ms (${top.count} call(s))`);
    }

    if (tokenUsage.length) {
      const totalTokens = tokenUsage.reduce((s, r) => s + r.totalTokens, 0);
      lines.push('\n## LLM token usage');
      lines.push(`- Total: ${totalTokens.toLocaleString()} tokens across ${tokenUsage.length} model(s)`);
      lines.push(`- Models: ${tokenUsage.map(r => r.model).join(', ')}`);
    }

    if (toolCalls.length) {
      const totalToolCalls = toolCalls.reduce((s, r) => s + r.count, 0);
      const failingTools   = toolCalls.filter(r => r.errorCount > 0).map(r => r.toolName);
      lines.push('\n## Tool calls');
      lines.push(`- Total: ${totalToolCalls} call(s) across ${toolCalls.length} tool(s)`);
      if (failingTools.length) {
        lines.push(`- Tools with errors: ${failingTools.join(', ')}`);
      }
    }

    lines.push(
      '\n---\n' +
      'For deeper analysis use: findRecentErrors, getTrace, getSlowestSpans, ' +
      'searchLogs, getAgentMetrics, getServiceSummary.',
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetServiceSummaryInput {
  serviceName?: string;
  since?: string;
  until?: string;
}

class GetServiceSummaryTool implements vscode.LanguageModelTool<GetServiceSummaryInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetServiceSummaryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const db = this.store.getDb();
    const { serviceName } = options.input;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);

    // No serviceName → list available services so the caller can pick
    if (!serviceName?.trim()) {
      const names = getServiceNames(db);
      if (!names.length) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'No telemetry data found. Point your OTLP exporter at the receiver to start collecting data.',
          ),
        ]);
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `# Available Services (${names.length})\n\n` +
          names.map(n => `- ${n}`).join('\n') +
          '\n\nCall this tool again with a serviceName to see its detailed summary.',
        ),
      ]);
    }

    const summary = getServiceSummary(db, serviceName.trim(), sinceNano ?? undefined, untilNano ?? undefined);
    if (!summary) {
      const names = getServiceNames(db);
      const hint = names.length
        ? `\n\nAvailable services: ${names.join(', ')}`
        : '\n\nNo telemetry data found at all.';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Service "${serviceName}" not found in telemetry.${hint}`),
      ]);
    }

    const errorTraceRate = summary.totalTraces > 0
      ? ((summary.errorTraces / summary.totalTraces) * 100).toFixed(1)
      : '0.0';
    const errorSpanRate = summary.totalSpans > 0
      ? ((summary.errorSpans / summary.totalSpans) * 100).toFixed(1)
      : '0.0';

    const lines: string[] = [`# Service Summary: ${summary.serviceName}\n`];

    lines.push('## Overview');
    lines.push(`- Traces: ${summary.totalTraces} (${summary.errorTraces} errored, ${errorTraceRate}% error rate)`);
    lines.push(`- Spans:  ${summary.totalSpans} (${summary.errorSpans} errored, ${errorSpanRate}% error rate)`);
    lines.push(`- p50 trace duration: ${summary.p50Ms}ms`);
    lines.push(`- p95 trace duration: ${summary.p95Ms}ms`);

    if (summary.slowestOperations.length) {
      lines.push('\n## Slowest Operations');
      summary.slowestOperations.forEach((op, i) => {
        const flag = op.errorCount > 0 ? ' ⚠️' : '';
        lines.push(`${i + 1}. **${op.name}**${flag}`);
        lines.push(`   avg: ${op.avgDurationMs}ms | max: ${op.maxDurationMs}ms | calls: ${op.count} | errors: ${op.errorCount}`);
      });
    }

    if (summary.tokenUsage.length) {
      const grandTotal = summary.tokenUsage.reduce((s, r) => s + r.totalTokens, 0);
      lines.push(`\n## LLM Token Usage (total: ${grandTotal.toLocaleString()})`);
      for (const r of summary.tokenUsage) {
        const ratio = r.promptTokens > 0
          ? (r.completionTokens / r.promptTokens).toFixed(2)
          : 'N/A';
        lines.push(`### ${r.model}`);
        lines.push(`- Calls: ${r.callCount} | Total: ${r.totalTokens.toLocaleString()} (${r.promptTokens.toLocaleString()} in / ${r.completionTokens.toLocaleString()} out, ratio ${ratio})`);
      }
    }

    if (summary.toolCalls.length) {
      const totalCalls  = summary.toolCalls.reduce((s, r) => s + r.count, 0);
      const totalErrors = summary.toolCalls.reduce((s, r) => s + r.errorCount, 0);
      lines.push(`\n## Tool Calls (${totalCalls} total, ${totalErrors} errors)`);
      for (const r of summary.toolCalls) {
        const errorPct = r.count > 0 ? ((r.errorCount / r.count) * 100).toFixed(1) : '0.0';
        const flag = r.errorCount > 0 ? '⚠️' : '✅';
        lines.push(`${flag} **${r.toolName}** — ${r.count} calls | ${errorPct}% errors | avg ${r.avgDurationMs}ms`);
      }
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface ListTracesInput {
  serviceName?: string;
  since?: string;
  until?: string;
  limit?: number;
  errorsOnly?: boolean;
  attributeKey?: string;
  attributeValue?: string;
}

class ListTracesTool implements vscode.LanguageModelTool<ListTracesInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListTracesInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { serviceName, errorsOnly = false, attributeKey, attributeValue } = options.input;
    const limit     = options.input.limit ?? 20;
    const sinceNano = parseSinceNano(options.input.since);
    const untilNano = parseUntilNano(options.input.until);

    const tracesOpts: GetTracesOptions = {
      limit,
      sinceNano:      sinceNano ?? undefined,
      untilNano:      untilNano ?? undefined,
      serviceName:    serviceName?.trim() || undefined,
      attributeKey:   attributeKey?.trim() || undefined,
      attributeValue: attributeValue?.trim() || undefined,
    };
    let traces = getTraces(this.store.getDb(), tracesOpts);

    if (errorsOnly) { traces = traces.filter(t => t.hasError); }

    if (!traces.length) {
      const qualifiers: string[] = [];
      if (serviceName)    { qualifiers.push(`service "${serviceName}"`); }
      if (sinceNano)      { qualifiers.push(`after ${options.input.since}`); }
      if (untilNano)      { qualifiers.push(`before ${options.input.until}`); }
      if (attributeKey)   { qualifiers.push(`${attributeKey}=${attributeValue ?? '*'}`); }
      else if (attributeValue) { qualifiers.push(`attribute contains "${attributeValue}"`); }
      if (errorsOnly)     { qualifiers.push(`errors only`); }
      const qualifier = qualifiers.length ? ` for ${qualifiers.join(', ')}` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No traces found${qualifier}.`),
      ]);
    }

    const header = [
      `# Traces (${traces.length} shown, most recent first)`,
      serviceName ? `Service: ${serviceName}` : '',
      options.input.since ? `Since: ${options.input.since}` : '',
      options.input.until ? `Until: ${options.input.until}` : '',
      attributeKey ? `Attribute: ${attributeKey}=${attributeValue ?? '*'}` : (attributeValue ? `Attribute contains: ${attributeValue}` : ''),
    ].filter(Boolean).join(' · ') + '\n';

    const lines: string[] = [header];

    for (const t of traces) {
      const status  = t.hasError ? '❌' : '✅';
      const time    = nanoToDate(t.startTimeUnixNano);
      lines.push(`${status} **${t.rootSpanName}** [${t.serviceName}]`);
      lines.push(`   traceId: \`${t.traceId}\``);
      lines.push(`   time: ${time} | duration: ${t.durationMs}ms | spans: ${t.spanCount}`);
      lines.push('');
    }

    if (attributeValue) {
      const matchDesc = attributeKey
        ? `"${attributeKey}" = "${attributeValue}"`
        : `"${attributeValue}" (substring match across all span attributes)`;
      lines.push(`> Traces above were matched because at least one span contains ${matchDesc}.`);
      lines.push(`> The match may appear in any span — not necessarily the root. Call getTrace on a traceId to see exactly which span(s) matched.`);
      lines.push('');
    }

    lines.push(
      `Present each trace individually with its traceId. ` +
      `Do not group or summarize — list them so the user can identify specific runs. ` +
      `Call getTrace on any traceId to drill into its full span tree.`
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetTraceInput {
  traceId: string;
}

class GetTraceTool implements vscode.LanguageModelTool<GetTraceInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetTraceInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { traceId } = options.input;
    if (!traceId?.trim()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('Error: traceId is required.'),
      ]);
    }

    const spans = getSpansByTraceId(this.store.getDb(), traceId.trim());

    if (!spans.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No spans found for traceId: ${traceId}`),
      ]);
    }

    const root = spans.find(s => !s.parentSpanId) ?? spans[0]!;
    const hasErrors = spans.some(s => s.statusCode === 2);
    const errorCount = spans.filter(s => s.statusCode === 2).length;

    // Aggregate token usage across all LLM spans in this trace
    const tokensByModel = aggregateTokens(spans);
    const totalTokens  = tokensByModel.reduce((s, t) => s + t.totalTokens, 0);
    const totalInput   = tokensByModel.reduce((s, t) => s + t.promptTokens, 0);
    const totalOutput  = tokensByModel.reduce((s, t) => s + t.completionTokens, 0);
    const totalLLMCalls = tokensByModel.reduce((s, t) => s + t.callCount, 0);
    const models = tokensByModel.map(t => t.model).join(', ');

    const lines: string[] = [
      `# Trace: \`${traceId}\``,
      '',
      '## Summary',
      '| Field | Value |',
      '|---|---|',
      `| traceId | \`${traceId}\` |`,
      `| service | ${root.serviceName} |`,
      `| root span | ${root.name} |`,
      `| started | ${nanoToDate(root.startTimeUnixNano)} |`,
      `| duration | ${root.durationMs}ms |`,
      `| spans | ${spans.length} |`,
      `| errors | ${errorCount} |`,
      `| status | ${hasErrors ? '❌ Has errors' : '✅ No errors'} |`,
      ...(tokensByModel.length ? [
        `| total tokens | ${totalTokens.toLocaleString()} |`,
        `| input tokens | ${totalInput.toLocaleString()} |`,
        `| output tokens | ${totalOutput.toLocaleString()} |`,
        `| llm calls | ${totalLLMCalls} |`,
        `| models | ${models} |`,
      ] : []),
      '',
    ];

    if (tokensByModel.length > 1) {
      lines.push('### Token Breakdown by Model');
      lines.push('| Model | Total | Input | Output | Calls |');
      lines.push('|---|---|---|---|---|');
      for (const t of tokensByModel) {
        lines.push(`| ${t.model} | ${t.totalTokens.toLocaleString()} | ${t.promptTokens.toLocaleString()} | ${t.completionTokens.toLocaleString()} | ${t.callCount} |`);
      }
      lines.push('');
    }

    lines.push('## Span Detail');
    lines.push('');

    for (const s of spans) {
      const isError = s.statusCode === 2;
      const prefix  = isError ? '❌' : '  ';
      const status  = SPAN_STATUS[s.statusCode] ?? String(s.statusCode);
      const kind    = SPAN_KIND[s.kind] ?? String(s.kind);
      const indent  = s.parentSpanId ? '  ' : '';

      lines.push(`${indent}${prefix} [${status}] ${s.name}  (${kind}, ${s.durationMs}ms)`);
      lines.push(`${indent}   spanId: ${s.spanId}${s.parentSpanId ? ` | parent: ${s.parentSpanId}` : ' | ROOT'}`);
      lines.push(`${indent}   started: ${nanoToDate(s.startTimeUnixNano)}`);

      if (isError && s.statusMessage) {
        lines.push(`${indent}   status message: ${s.statusMessage}`);
      }

      for (const key of NOTABLE_ATTRS) {
        const val = s.attributes[key];
        if (val != null) {
          const str = String(val);
          lines.push(`${indent}   ${key}: ${str.length > 300 ? str.slice(0, 300) + '…' : str}`);
        }
      }
      lines.push('');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}


export function registerTools(
  context: vscode.ExtensionContext,
  store: TelemetryStore,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('otel-insights_findRecentErrors',        new FindRecentErrorsTool(store)),
    vscode.lm.registerTool('otel-insights_getAgentMetrics',         new GetAgentMetricsTool(store)),
    vscode.lm.registerTool('otel-insights_getSlowestSpans',         new GetSlowestSpansTool(store)),
    vscode.lm.registerTool('otel-insights_searchLogs',              new SearchLogsTool(store)),
    vscode.lm.registerTool('otel-insights_summarizeRecentActivity', new SummarizeRecentActivityTool(store)),
    vscode.lm.registerTool('otel-insights_getServiceSummary',       new GetServiceSummaryTool(store)),
    vscode.lm.registerTool('otel-insights_listTraces',              new ListTracesTool(store)),
    vscode.lm.registerTool('otel-insights_getTrace',                new GetTraceTool(store)),
  );
}
