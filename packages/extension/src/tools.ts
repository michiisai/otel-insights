import * as vscode from 'vscode';
import type { TelemetryStore } from '@otel-insights/receiver';
import {
  getRecentErrorTraces,
  getSpansByTraceId,
  getMetricsData,
  getLogs,
  getServiceNames,
  getServiceSummary,
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


interface FindRecentErrorsInput {
  limit?: number;
}

class FindRecentErrorsTool implements vscode.LanguageModelTool<FindRecentErrorsInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindRecentErrorsInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const limit = options.input.limit ?? 5;
    const errors = getRecentErrorTraces(this.store.getDb(), limit);

    if (!errors.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No error traces found in the telemetry store.'),
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

    lines.push('To inspect the full span tree for a trace, call getErrorTrace with its traceId.');

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

class GetErrorTraceTool implements vscode.LanguageModelTool<GetErrorTraceInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetErrorTraceInput>,
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

    const lines: string[] = [`# Trace: ${traceId}\n${spans.length} span(s)\n`];

    for (const s of spans) {
      const isError = s.statusCode === 2;
      const prefix = isError ? '❌' : '  ';
      const status = SPAN_STATUS[s.statusCode] ?? String(s.statusCode);
      const kind   = SPAN_KIND[s.kind] ?? String(s.kind);

      lines.push(`${prefix} [${status}] ${s.name}  (${kind}, ${s.durationMs}ms)`);
      lines.push(`   spanId: ${s.spanId}${s.parentSpanId ? ` | parent: ${s.parentSpanId}` : ' | ROOT'}`);
      lines.push(`   started: ${nanoToDate(s.startTimeUnixNano)}`);

      if (isError && s.statusMessage) {
        lines.push(`   status message: ${s.statusMessage}`);
      }

      for (const key of NOTABLE_ATTRS) {
        const val = s.attributes[key];
        if (val != null) {
          const str = String(val);
          // Truncate long values such as stack traces
          lines.push(`   ${key}: ${str.length > 300 ? str.slice(0, 300) + '…' : str}`);
        }
      }
      lines.push('');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

class GetTokenUsageTool implements vscode.LanguageModelTool<object> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { tokenUsage } = getMetricsData(this.store.getDb());

    if (!tokenUsage.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No token usage data found. Make sure your LLM spans include ' +
          'gen_ai.usage.input_tokens / gen_ai.usage.output_tokens attributes.',
        ),
      ]);
    }

    const grandTotal = tokenUsage.reduce((s, r) => s + r.totalTokens, 0);
    const lines: string[] = [
      `# Token Usage\nTotal across all models: ${grandTotal.toLocaleString()} tokens\n`,
    ];

    for (const r of tokenUsage) {
      const ratio = r.promptTokens > 0
        ? (r.completionTokens / r.promptTokens).toFixed(2)
        : 'N/A';
      lines.push(`## ${r.model}`);
      lines.push(`- Calls: ${r.callCount}`);
      lines.push(`- Total tokens: ${r.totalTokens.toLocaleString()}`);
      lines.push(`- Prompt (input): ${r.promptTokens.toLocaleString()}`);
      lines.push(`- Completion (output): ${r.completionTokens.toLocaleString()}`);
      lines.push(`- Output/input ratio: ${ratio}`);
      lines.push('');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

class GetToolCallStatsTool implements vscode.LanguageModelTool<object> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { toolCalls } = getMetricsData(this.store.getDb());

    if (!toolCalls.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No tool call data found. Make sure your agent spans include ' +
          'gen_ai.tool.name or tool.name attributes.',
        ),
      ]);
    }

    const totalCalls  = toolCalls.reduce((s, r) => s + r.count, 0);
    const totalErrors = toolCalls.reduce((s, r) => s + r.errorCount, 0);
    const overallErrorPct = ((totalErrors / totalCalls) * 100).toFixed(1);

    const lines: string[] = [
      `# Tool Call Stats\n` +
      `Total calls: ${totalCalls} | Errors: ${totalErrors} (${overallErrorPct}% error rate)\n`,
    ];

    for (const r of toolCalls) {
      const errorPct = r.count > 0 ? ((r.errorCount / r.count) * 100).toFixed(1) : '0.0';
      const flag = r.errorCount > 0 ? '⚠️' : '✅';
      lines.push(`${flag} **${r.toolName}**`);
      lines.push(`- Calls: ${r.count} | Errors: ${r.errorCount} (${errorPct}%)`);
      lines.push(`- Avg duration: ${r.avgDurationMs}ms | Total time: ${r.totalDurationMs}ms`);
      lines.push('');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetSlowestSpansInput {
  limit?: number;
}

class GetSlowestSpansTool implements vscode.LanguageModelTool<GetSlowestSpansInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetSlowestSpansInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const limit = options.input.limit ?? 10;
    const { slowestOperations } = getMetricsData(this.store.getDb());
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
}

class SearchLogsTool implements vscode.LanguageModelTool<SearchLogsInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchLogsInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { query = '', minSeverity = 0, limit = 50 } = options.input;
    const logs = getLogs(this.store.getDb(), { filter: query, minSeverity, limit });

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
class SummarizeRecentActivityTool implements vscode.LanguageModelTool<object> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const db = this.store.getDb();
    const { summary, slowestOperations, tokenUsage, toolCalls } = getMetricsData(db);

    if (summary.totalSpans === 0 && summary.totalLogs === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No telemetry data yet. Point your OTLP exporter at the receiver to start collecting data.',
        ),
      ]);
    }

    const errorStats = db.prepare(`
      SELECT
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)             AS error_spans,
        COUNT(DISTINCT CASE WHEN status_code = 2 THEN trace_id END)  AS error_traces
      FROM spans
    `).get();

    const errorSpans  = Number(errorStats?.['error_spans']  ?? 0);
    const errorTraces = Number(errorStats?.['error_traces'] ?? 0);
    const errorRate   = summary.totalSpans > 0
      ? ((errorSpans / summary.totalSpans) * 100).toFixed(1)
      : '0.0';

    // p95 latency from root spans, computed in JS to avoid SQLite dynamic OFFSET
    const durationRows = db.prepare(`
      SELECT duration_ms FROM spans
      WHERE parent_span_id IS NULL OR parent_span_id = ''
      ORDER BY duration_ms ASC
    `).all();
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
      'For deeper analysis use: findRecentErrors, getErrorTrace, getSlowestSpans, ' +
      'searchLogs, getTokenUsage, getToolCallStats.',
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }
}

interface GetServiceSummaryInput {
  serviceName?: string;
}

class GetServiceSummaryTool implements vscode.LanguageModelTool<GetServiceSummaryInput> {
  constructor(private readonly store: TelemetryStore) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetServiceSummaryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const db = this.store.getDb();
    const { serviceName } = options.input;

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

    const summary = getServiceSummary(db, serviceName.trim());
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

export function registerTools(
  context: vscode.ExtensionContext,
  store: TelemetryStore,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('otel-insights_findRecentErrors',     new FindRecentErrorsTool(store)),
    vscode.lm.registerTool('otel-insights_getErrorTrace',        new GetErrorTraceTool(store)),
    vscode.lm.registerTool('otel-insights_getTokenUsage',        new GetTokenUsageTool(store)),
    vscode.lm.registerTool('otel-insights_getToolCallStats',     new GetToolCallStatsTool(store)),
    vscode.lm.registerTool('otel-insights_getSlowestSpans',      new GetSlowestSpansTool(store)),
    vscode.lm.registerTool('otel-insights_searchLogs',           new SearchLogsTool(store)),
    vscode.lm.registerTool('otel-insights_summarizeRecentActivity', new SummarizeRecentActivityTool(store)),
    vscode.lm.registerTool('otel-insights_getServiceSummary',    new GetServiceSummaryTool(store)),
  );
}
