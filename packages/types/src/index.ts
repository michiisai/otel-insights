/** A single span stored in and retrieved from the DB. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  /** OTLP SpanKind: 0=UNSPECIFIED 1=INTERNAL 2=SERVER 3=CLIENT 4=PRODUCER 5=CONSUMER */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  /** OTLP StatusCode: 0=UNSET 1=OK 2=ERROR */
  statusCode: number;
  statusMessage?: string | null;
  attributes: Record<string, unknown>;
  serviceName: string;
}

/** Trace summary row — aggregated across all spans sharing a traceId. */
export interface Trace {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  startTimeUnixNano: string;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
}

/** Aggregated metrics for the Performance panel. */
export interface MetricsData {
  slowestOperations: Array<{
    name: string;
    avgDurationMs: number;
    maxDurationMs: number;
    count: number;
    errorCount: number;
  }>;
  tokenUsage: Array<{
    model: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    callCount: number;
  }>;
  toolCalls: Array<{
    toolName: string;
    count: number;
    avgDurationMs: number;
    totalDurationMs: number;
    errorCount: number;
  }>;
  summary: {
    totalSpans: number;
    totalTraces: number;
    totalLogs: number;
    totalMetricPoints: number;
    llmCalls: number;
    toolCallsTotal: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    errorTraces: number;
    p95Ms: number;
  };
}

/** A single log record. */
export interface LogRecord {
  id: number;
  timestampUnixNano: string;
  /** OTLP SeverityNumber: 1-4=TRACE, 5-8=DEBUG, 9-12=INFO, 13-16=WARN, 17-20=ERROR, 21-24=FATAL */
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, unknown>;
  traceId?: string | null;
  spanId?: string | null;
  serviceName: string;
}

/**
 * Minimal DB interface the engine depends on.
 * Implemented by DatabaseAdapter (wraps sql.js) in the receiver package.
 */
export interface QueryableDB {
  prepare(sql: string): {
    all(...args: unknown[]): Record<string, unknown>[];
    get(...args: unknown[]): Record<string, unknown> | undefined;
    run(...args: unknown[]): void;
  };
  exec(sql: string): void;
}

/** Messages sent from the webview to the extension host. */
export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'getTraces'; search?: string; service?: string; errorsOnly?: boolean; sortOrder?: 'asc' | 'desc' }
  | { type: 'getServices' }
  | { type: 'getSpans'; traceId: string }
  | { type: 'getMetrics' }
  | { type: 'getLogs'; filter?: string; excludes?: string[]; sinceNano?: string; untilNano?: string; minSeverity?: number }
  | { type: 'clearData' }
  | { type: 'addItemsToChat'; traces: Record<string, unknown>[]; spans: Record<string, unknown>[] };

/** Messages sent from the extension host to the webview. */
export type ExtensionToWebview =
  | { type: 'traces'; data: Trace[] }
  | { type: 'services'; data: string[] }
  | { type: 'spans'; traceId: string; data: Span[] }
  | { type: 'metrics'; data: MetricsData }
  | { type: 'logs'; data: LogRecord[] }
  | { type: 'status'; connected: boolean; port: number }
  | { type: 'cleared' }
  | { type: 'error'; message: string }
  | { type: 'navigateToTrace'; traceId: string; spanId?: string };
