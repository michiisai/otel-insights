# OTel Insights

This extension brings **OpenTelemetry** traces, logs, and metrics directly into the editor, helping developers investigate failures, analyze performance, and understand agent behavior in real time.

Explore trace trees, inspect tool calls, identify slow operations, correlate logs with spans, and answer questions like:

- Why did this run fail?
- Why was this task slow?
- What happened during this session?
- Which operations and services consumed the most time or tokens?

## Architecture

```
otel-insights/
├── packages/
│   ├── types      — shared TypeScript interfaces (Span, Trace, LogRecord, …)
│   ├── receiver   — OTLP/HTTP receiver + sql.js (WASM) SQLite store
│   ├── engine     — query layer (traces, metrics, logs analysis)
│   └── extension  — VS Code extension: activates receiver, hosts webview UI,
│                    and exposes Copilot Chat tools + chat skill
```

Each package is independently compiled. `extension` is bundled by esbuild with `sql.js` kept external so the WASM loader can find its `.wasm` file at runtime.

## Features

| Tab | What you get |
|-----|-------------|
| **Traces** | Expandable trace list → span tree with duration, kind badge, error highlighting, and a timeline / waterfall view |
| **Performance** | Latency (p95) · Token usage (`gen_ai.*` + `llm.*`/bare-key fallbacks) · Prompt-cache hit rate & cache read/write tokens · Tool call stats |
| **Logs** | Severity-coloured log stream with free-text + severity filter |

A status-bar item (`● :4318`) shows the receiver is live. Click it to open the panel.

## Copilot Chat integration

The extension surfaces its telemetry to AI agents through **VS Code language-model tools** and a bundled **chat skill** ([`skills/SKILL.md`](packages/extension/skills/SKILL.md)), so you can investigate telemetry conversationally in Copilot Chat instead of clicking through the UI.

| Tool (`#`-reference) | What it does |
|----------------------|--------------|
| `#otelTraces` (List Traces) | Recent traces with service/time/error/attribute filters |
| `#otelSpans` (Get Trace Details) | Full span tree for a given traceId |
| `#otelService` (Service / Agent Summary) | Per-service profile: error rate, p50/p95, slow ops, tokens, tool calls — great for comparing two agents |
| `#otelSummary` (Summarize Recent Activity) | High-level health overview (counts, error rate, p95, tokens) |
| `#otelErrors` (Find Recent Errors) | Most recent error traces with exception details |
| `#otelSlow` (Get Slowest Spans) | Slowest operations by average duration |
| `#otelLogs` (Search Logs) | Keyword/severity search across logs |
| `#otelAgentMetrics` (Get Agent Metrics) | Token usage + tool call stats in one call |

Trace/span tools emit clickable deeplinks that open the panel directly at the referenced trace.

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Build all packages
npm run build

# 3. Open the repo in VS Code and press F5 to launch the Extension Development Host
```

### Connecting a telemetry source

The receiver and your telemetry source **must use the same port**. The receiver listens on `otelInsights.port` (default `4318`), and your OTLP/HTTP exporter must send to that exact port.

1. **Pick the port.** Confirm `4318` is free, or set an open port in `settings.json`:
   ```jsonc
   { "otelInsights.port": 4318 }
   ```
2. **Point your exporter at it** — send OTLP/HTTP to `http://127.0.0.1:<port>`, using the same `<port>` as above.

   To capture **VS Code / Copilot's own** agent telemetry, add this to `settings.json` (keep `otlpEndpoint`'s port equal to `otelInsights.port`), then reload VS Code and run an agent/chat request:
   ```jsonc
   {
     "chat.agentHost.enabled": true,
     "chat.agentHost.otel.enabled": true,
     "chat.agentHost.otel.captureContent": true,
     "chat.agentHost.otel.otlpEndpoint": "http://localhost:4318"
   }
   ```

   To capture **Claude Code** telemetry, add an `env` block to your Claude Code settings file (`~/.claude/settings.json`), then start a **new** Claude Code session (settings load at startup) and run a prompt:
   ```jsonc
   {
     "env": {
       "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
       // Export all three signals over OTLP/HTTP JSON to the receiver's port
       "OTEL_TRACES_EXPORTER": "otlp",
       "OTEL_METRICS_EXPORTER": "otlp",
       "OTEL_LOGS_EXPORTER": "otlp",
       "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
       "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
       // Flush metrics every 10s so short sessions still export (default is 60s)
       "OTEL_METRIC_EXPORT_INTERVAL": "10000",
       // Emit cumulative metrics (Claude Code defaults to delta) to match Copilot
       "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "cumulative",
       // Optional: include prompt / tool / response content in logs & spans
       "OTEL_LOG_USER_PROMPTS": "1",
       "OTEL_LOG_TOOL_DETAILS": "1",
       "OTEL_LOG_TOOL_CONTENT": "1"
     }
   }
   ```
   > **Notes:** Use `http/json` — the receiver speaks OTLP/HTTP JSON, not gRPC or protobuf. The Metrics engine reads each metric's temporality, so `delta` data is also computed correctly; `cumulative` is only recommended so Claude Code lines up with Copilot's metrics. Claude Code data appears under the `claude-code` service in each tab.

### Recognized attributes

For agent-specific attributes the Performance tab understands:

| Attribute | Meaning |
|-----------|---------|
| `gen_ai.request.model` (or `llm.model`) | Model name (token usage grouping) |
| `gen_ai.usage.input_tokens` (or `llm.usage.prompt_tokens`, `input_tokens`) | Prompt tokens |
| `gen_ai.usage.output_tokens` (or `llm.usage.completion_tokens`, `output_tokens`) | Completion tokens |
| `gen_ai.usage.cache_read_input_tokens` (or `cache_read_tokens`) | Cache-hit tokens (served from cache) |
| `gen_ai.usage.cache_creation_input_tokens` (or `cache_creation_tokens`) | Cache-write tokens (cost of populating the cache) |
| `gen_ai.tool.name` (or `tool.name`, `tool_name`) | Tool name (tool call analysis) |

Each row lists the OpenTelemetry GenAI semantic-convention key first, followed by
the `llm.*` and bare-key fallbacks that harnesses such as Claude Code emit — all
map onto the same metric.

## Commands

| Command | Description |
|---------|-------------|
| `OTel Insights: Open Panel` | Opens the telemetry panel |
| `OTel Insights: Clear All Data` | Deletes all stored telemetry from the DB |
| `OTel Insights: Navigate to Trace` | Opens the panel at a specific trace (used by chat deeplinks) |

## Persistence

Telemetry is stored in a SQLite database (`sql.js` WASM — no native compilation required) at:

```
<VS Code globalStorage>/telemetry.db
```

Data persists across VS Code restarts. Use **Clear All Data** to wipe it.

