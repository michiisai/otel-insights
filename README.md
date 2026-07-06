# OTel Insights

This extension brings **OpenTelemetry** traces, logs, and metrics directly into the editor, helping developers investigate failures, analyze performance, and understand agent or application behavior in real time.

Explore trace trees, inspect tool calls, identify slow operations, correlate logs with spans, and answer questions like:

- Why did this run fail?
- Why was this task slow?
- What happened during this session?
- Which operations and services consumed the most time or tokens?

## Architecture

```
otel-insights/
├── packages/
│   ├── types          — shared TypeScript interfaces (Span, Trace, LogRecord, …)
│   ├── receiver       — OTLP/HTTP receiver + sql.js (WASM) SQLite store
│   ├── engine         — query layer (traces, metrics, logs analysis)
│   └── adapter-vscode — VS Code extension: activates receiver, hosts webview UI
```

Each package is independently compiled. `adapter-vscode` is bundled by esbuild with `sql.js` kept external so the WASM loader can find its `.wasm` file at runtime.

## Features

| Tab | What you get |
|-----|-------------|
| **Traces** | Expandable trace list → span tree with duration, kind badge, and error highlighting |
| **Performance** | Slowest operations · Token usage (`gen_ai.*` attributes) · Tool call stats |
| **Logs** | Severity-coloured log stream with free-text + severity filter |

A status-bar item (`● :4318`) shows the receiver is live. Click it to open the panel.

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Build all packages
npm run build

# 3. Open the repo in VS Code and press F5 to launch the Extension Development Host
```

Then point your app's OTLP exporter at `http://127.0.0.1:4318` (the default OTLP/HTTP endpoint).

### Example: OpenTelemetry SDK (Node.js)

```js
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

const exporter = new OTLPTraceExporter({
  url: 'http://127.0.0.1:4318/v1/traces',
});
```

For agent-specific attributes the Performance tab understands:

| Attribute | Meaning |
|-----------|---------|
| `gen_ai.request.model` | Model name (token usage grouping) |
| `gen_ai.usage.input_tokens` | Prompt tokens |
| `gen_ai.usage.output_tokens` | Completion tokens |
| `gen_ai.tool.name` | Tool name (tool call analysis) |

## Commands

| Command | Description |
|---------|-------------|
| `OTel Insights: Open Panel` | Opens the telemetry panel |
| `OTel Insights: Clear All Data` | Deletes all stored telemetry from the DB |

## Configuration

```jsonc
// settings.json
{
  "otelInsights.port": 4318   // change if 4318 is taken
}
```

## Persistence

Telemetry is stored in a SQLite database (`sql.js` WASM — no native compilation required) at:

```
<VS Code globalStorage>/telemetry.db
```

Data persists across VS Code restarts. Use **Clear All Data** to wipe it.

## Roadmap

- [ ] MCP server to expose telemetry to AI agents
- [ ] Timeline / waterfall chart for traces
- [ ] Alerting rules on error rate / latency
- [ ] Multi-service filtering
- [ ] Export to JSON / CSV
