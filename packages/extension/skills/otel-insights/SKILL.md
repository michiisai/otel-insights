---
name: otel-insights
description: 'Query live OpenTelemetry telemetry collected by the OTel Insights VS Code extension. Use when: debugging errors, investigating slow operations, slow requests, high latency, performance problems, slow agent, slow tool calls, "why did it take so long", "why is it slow", "what is slow", timeouts, latency spikes, bottlenecks, reviewing LLM token usage, analyzing tool call stats, searching logs, or comparing two agents/services. Requires the OTel Insights extension to be active and receiving OTLP data on port 4318.'
---

# OTel Insights — Telemetry Analysis

Query traces, spans, metrics, and logs captured by the OTel Insights extension directly from the agent.

## Trigger Rules

ALWAYS call `otel-insights_getSlowestSpans` when the user asks about or mentions anything slow — including but not limited to:
- slow requests, slow responses, slow tool calls, slow agent, slow app
- high latency, latency spikes, timeouts, delays, lag, taking too long
- performance problems, performance regression, bottleneck, throughput
- "why is X slow", "what's taking so long", "speed up", "optimize"

ALWAYS call `otel-insights_getServiceSummary` (once per service) when the user asks to compare two agents or services — e.g. "why is Codex faster than Copilot", "compare agent A vs agent B", "which service is slower". First call it without a `serviceName` to discover available service names, then call it for each service you want to compare.

ALWAYS call `otel-insights_summarizeRecentActivity` first when the user asks about general app health, status, or "what's going on" without a specific focus.

ALWAYS call `otel-insights_findRecentErrors` when the user asks about errors, failures, exceptions, crashes, or "what broke".

ALWAYS call `otel-insights_searchLogs` when the user asks about logs or wants to find a specific message.

ALWAYS call `otel-insights_getTokenUsage` when the user asks about token consumption, LLM cost, or model usage.

ALWAYS call `otel-insights_listTraces` when the user wants to browse, list, or find traces — e.g. "show me recent traces", "what ran in the last hour", "list traces for service X", "find a trace".

ALWAYS call `otel-insights_getTrace` when the user wants to inspect a specific trace by ID, understand what happened in a run, or drill into spans — for any trace (not just errors).

## Prerequisites

- The **OTel Insights** VS Code extension must be installed and active (status bar shows `● OTel :4318`).
- Your application must be exporting OTLP/HTTP telemetry to `http://127.0.0.1:4318`.

## Available Tools

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `otel-insights_summarizeRecentActivity` | High-level health overview — counts, error rate, p95 latency, token usage, tool calls | `since` |
| `otel-insights_listTraces` | Browse recent traces — traceId, root span name, service, time, duration, error flag | `serviceName`, `since`, `limit` (default 20), `errorsOnly` |
| `otel-insights_getTrace` | Full span tree for any traceId — status, kind, duration, attributes for every span | `traceId` (required) |
| `otel-insights_getServiceSummary` | Full performance profile for one service/agent — error rate, p50/p95 latency, slowest ops, tokens, tool calls, all scoped to that service | `serviceName`, `since` |
| `otel-insights_findRecentErrors` | List the most recent error traces with root cause span details | `limit` (default 5), `since` |
| `otel-insights_getErrorTrace` | Full span tree for one trace — surfaced via the error workflow (use getTrace for non-error traces) | `traceId` (required) |
| `otel-insights_getSlowestSpans` | Slowest operations ranked by average duration (across all services) | `limit` (default 10), `since` |
| `otel-insights_getTokenUsage` | LLM token consumption per model — prompt vs. completion tokens, call count | `since` |
| `otel-insights_getToolCallStats` | Per-tool call counts, error rates, and average durations | `since` |
| `otel-insights_searchLogs` | Full-text log search with optional severity filter | `query` (required), `minSeverity` (0–24), `limit` (default 50), `since` |

## Time Filtering (`since` parameter)

Every tool except `getErrorTrace` accepts an optional `since` parameter to scope results to a time window. This is useful when the telemetry database contains many historical runs and you only care about recent activity.

| Format | Example | Meaning |
|--------|---------|---------|
| Relative seconds | `"30s"` | Last 30 seconds |
| Relative minutes | `"5m"` | Last 5 minutes |
| Relative hours | `"1h"`, `"6h"` | Last 1 or 6 hours |
| Relative days | `"1d"`, `"7d"` | Last 1 or 7 days |
| Absolute ISO 8601 | `"2024-01-15T10:00:00Z"` | Everything after this timestamp |

When omitted, tools return data across all stored telemetry.

## Severity Levels for `searchLogs`

| `minSeverity` | Level |
|--------------|-------|
| 0 | All (UNSPECIFIED+) |
| 9 | INFO+ |
| 13 | WARN+ |
| 17 | ERROR+ |
| 21 | FATAL only |

## Recommended Workflows

### "Why is Codex faster than Copilot on this task?" (or any agent comparison)
1. Call `otel-insights_getServiceSummary` with no `serviceName` to list available services.
2. Call `otel-insights_getServiceSummary` for each agent (e.g. `"codex"` and `"copilot"`) — these can be parallel calls.
3. Compare p50/p95 latency, token counts (input/output ratio), and tool call counts/durations across both results.
4. Explain the difference: e.g. fewer tool calls, lower token usage, faster individual operations.

### "Show me recent traces" / "What happened during this run?"
1. Call `otel-insights_listTraces` — optionally pass `serviceName` or `since` to narrow down.
2. For any trace of interest, call `otel-insights_getTrace` with its `traceId` for the full span tree.
3. If the trace has errors, the span tree will highlight them with ❌ and surface exception details.


1. Call `otel-insights_summarizeRecentActivity` for a health snapshot.
2. Call `otel-insights_findRecentErrors` to list error traces.
3. For any trace of interest, call `otel-insights_getErrorTrace` with its `traceId` to see the full span tree and exception details.

### "What's slow?"
1. Call `otel-insights_getSlowestSpans` to rank operations by average latency across all services.
2. If you suspect one service is the culprit, call `otel-insights_getServiceSummary` for that service.
3. Follow up with `otel-insights_getErrorTrace` if a slow operation also has errors.

### "How many tokens is my agent consuming?"
1. Call `otel-insights_getTokenUsage` — results are grouped by model across all services.
2. To see token usage per agent/service, call `otel-insights_getServiceSummary` for each service.
3. Call `otel-insights_getToolCallStats` to see which tools are called most and which are failing.

### "Search for a specific log message"
1. Call `otel-insights_searchLogs` with a `query` string (substring match on log body).
2. If a log has a `traceId`, call `otel-insights_getErrorTrace` to get the full context.

## Notes

- All timestamps are in nanoseconds (Unix epoch) and are converted to ISO strings in tool output.
- Stack traces in `exception.stacktrace` are truncated to 300 characters in `getErrorTrace` output.
- Token usage requires spans with `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` attributes.
- Tool call stats require spans with `gen_ai.tool.name` or `tool.name` attributes.
- Service/agent names come from the `service_name` field set in your OTLP resource attributes (`service.name`).
