import * as vscode from 'vscode';
import { TelemetryStore } from '@otel-insights/receiver';
import { getTraces, getSpansByTraceId, getServices, getMetricsData, getLogs, getLogServiceNames } from '@otel-insights/engine';
import type { WebviewToExtension, ExtensionToWebview } from '@otel-insights/types';

export class OtelInsightsPanel {
  static readonly viewType   = 'otelInsights';
  static currentPanel?: OtelInsightsPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: TelemetryStore,
    private readonly port: number,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      OtelInsightsPanel.viewType,
      'OTel Insights',
      vscode.ViewColumn.One,
      {
        enableScripts:          true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables,
    );

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToExtension) => { this.handleMessage(msg).catch(console.error); },
      null,
      this.disposables,
    );
  }

  static createOrShow(extensionUri: vscode.Uri, store: TelemetryStore, port: number): void {
    if (OtelInsightsPanel.currentPanel) {
      OtelInsightsPanel.currentPanel.panel.reveal();
      return;
    }
    OtelInsightsPanel.currentPanel = new OtelInsightsPanel(extensionUri, store, port);
  }

  refresh(): void {
    this.post({ type: 'status', connected: true, port: this.port });
  }

  navigateToTrace(traceId: string, spanId?: string): void {
    this.panel.reveal();
    this.post({ type: 'navigateToTrace', traceId, spanId });
  }

  private post(msg: ExtensionToWebview): void {
    this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
    const db = this.store.getDb();
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'status', connected: true, port: this.port });
        break;
      case 'getTraces':
        this.post({ type: 'traces', data: getTraces(db, {
          nameSearch: msg.search,
          serviceName: msg.service,
          errorsOnly: msg.errorsOnly,
          sortOrder: msg.sortOrder,
        }) });
        break;
      case 'getServices':
        this.post({ type: 'services', data: getServices(db) });
        break;
      case 'getLogServices':
        this.post({ type: 'logServices', data: getLogServiceNames(db) });
        break;
      case 'getSpans':
        this.post({ type: 'spans', traceId: msg.traceId, data: getSpansByTraceId(db, msg.traceId) });
        break;
      case 'getMetrics':
        this.post({ type: 'metrics', data: getMetricsData(db) });
        break;
      case 'getLogs':
        this.post({ type: 'logs', data: getLogs(db, {
          filter:      msg.filter,
          excludes:    msg.excludes,
          minSeverity: msg.minSeverity,
          sinceNano:   msg.sinceNano,
          untilNano:   msg.untilNano,
          serviceName: msg.serviceName,
          sortOrder:   msg.sortOrder,
        }) });
        break;
      case 'clearData': {
        const answer = await vscode.window.showWarningMessage(
          'Clear all stored telemetry data? This cannot be undone.',
          { modal: true },
          'Clear',
        );
        if (answer === 'Clear') {
          this.store.clear();
          this.post({ type: 'cleared' });
        }
        break;
      }
      case 'addItemsToChat': {
        const formatted = formatItemsForChat(msg.traces, msg.spans);
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: formatted || ' ',
            isPartialQuery: true,
          });
        } catch {
          if (formatted) {
            await vscode.env.clipboard.writeText(formatted);
            vscode.window.showInformationMessage('Copied to clipboard — paste into chat');
          }
        }
        break;
      }
    }
  }

  private buildHtml(): string {
    const wv        = this.panel.webview;
    const scriptUri = wv.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'));
    const styleUri  = wv.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const nonce     = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${wv.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 img-src data:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>OTel Insights</title>
</head>
<body>
<div id="app">

  <header class="toolbar">
    <nav class="tabs" role="tablist">
      <button class="tab active" data-tab="traces"      role="tab" aria-selected="true">Traces</button>
      <button class="tab"        data-tab="performance" role="tab">Performance</button>
      <button class="tab"        data-tab="logs"        role="tab">Logs</button>
    </nav>
    <div class="toolbar-right">
      <span id="status-badge" class="badge">connecting…</span>
      <span class="toolbar-btn-group">
        <button id="refresh-btn" class="icon-btn" title="Refresh data"><span style="display:inline-block;vertical-align:middle;line-height:1">↻</span> Refresh</button>
        <button id="clear-btn"   class="icon-btn icon-btn--danger" title="Clear all stored telemetry">✕ Clear</button>
      </span>
    </div>
  </header>

  <!-- Traces tab -->
  <div id="traces-panel" class="panel active" role="tabpanel">
    <div class="traces-split">

      <!-- Left: trace list + waterfall -->
      <div class="traces-left">
        <div class="traces-sticky">
          <div class="traces-filters">
            <input  id="trace-search"   type="text" placeholder="Search traces…" />
            <button id="trace-errors-btn" class="filter-toggle" title="Errors only">⚠ Errors</button>
          </div>
          <div id="chat-selection-panel" class="chat-selection-panel chat-selection-panel--empty">
            <div class="chat-selection-header">
              <span id="chat-selection-count">Chat Context (0)</span>
              <button id="chat-selection-clear" class="chat-selection-clear-btn" title="Remove all selected traces/spans from chat context">Clear</button>
            </div>
            <div id="chat-selection-list" class="chat-selection-list">
              <span class="chat-selection-empty">No traces or spans in chat context.</span>
            </div>
          </div>
          <div class="traces-header" aria-hidden="true">
            <span class="expand-icon"></span>
            <span class="cell cell--name">Trace</span>
            <span class="cell cell--service">
              <button id="service-filter-btn" class="header-filter-btn" title="Filter by service">Service <span id="service-filter-icon" class="header-filter-icon">▾</span></button>
              <div id="service-filter-dropdown" class="header-filter-dropdown" style="display:none"></div>
            </span>
            <span class="cell cell--ts">
              <button id="time-sort-btn" class="header-filter-btn" title="Sort by time">Time <span id="time-sort-icon" class="header-filter-icon">↓</span></button>
            </span>
            <span class="cell cell--dur">Duration</span>
            <span class="cell cell--spans">Spans</span>
            <button class="add-to-chat-btn" style="visibility:hidden" aria-hidden="true" tabindex="-1">+ chat</button>
          </div>
        </div>
        <div id="traces-list" class="list-container">
          <div class="empty-state">Loading traces…</div>
        </div>
      </div>

      <!-- Resize divider -->
      <div class="traces-divider" id="traces-divider" title="Drag to resize"></div>

      <!-- Right: span detail panel -->
      <div class="traces-right" id="span-detail-panel">
        <div class="span-detail-placeholder">
          ← Expand a trace and click a span to view its details
        </div>
      </div>

    </div>
  </div>

  <!-- Performance tab -->
  <div id="performance-panel" class="panel" role="tabpanel">
    <div class="metrics-grid">

      <section class="card">
        <h3 class="card-title">📊 Summary</h3>
        <div id="summary"></div>
      </section>

      <section class="card">
        <h3 class="card-title">🪙 Token Usage</h3>
        <div id="token-usage"></div>
      </section>

      <section class="card">
        <h3 class="card-title">🐢 Slowest Operations</h3>
        <div id="slowest-ops"></div>
      </section>

      <section class="card">
        <h3 class="card-title">🔧 Tool Calls</h3>
        <div id="tool-calls"></div>
      </section>

    </div>
  </div>

  <!-- Logs tab -->
  <div id="logs-panel" class="panel" role="tabpanel">
    <div class="logs-toolbar">
      <div class="log-filter-wrap">
        <input id="log-filter" type="text" placeholder="Filter (e.g. text, !exclude, before:YYYY-MM-DDTHH:MM:SS)" />
        <span class="log-filter-icon" title="Advanced filter active" id="log-filter-icon">⊘</span>
      </div>
    </div>
    <div class="logs-split">
      <!-- Left: log list -->
      <div class="logs-left">
        <div class="logs-header">
          <span class="log-ts">
            <button id="log-time-sort-btn" class="header-filter-btn" title="Sort by time">Created <span id="log-time-sort-icon" class="header-filter-icon">↓</span></button>
          </span>
          <span class="log-level" style="position:relative;overflow:visible">
            <button id="log-level-filter-btn" class="header-filter-btn" title="Filter by level">Level <span id="log-level-filter-icon" class="header-filter-icon">▾</span></button>
            <div id="log-level-filter-dropdown" class="header-filter-dropdown" style="display:none">
              <button class="service-filter-option active" data-severity="0">All</button>
              <button class="service-filter-option" data-severity="1">Trace</button>
              <button class="service-filter-option" data-severity="5">Debug</button>
              <button class="service-filter-option" data-severity="9">Info</button>
              <button class="service-filter-option" data-severity="13">Warn</button>
              <button class="service-filter-option" data-severity="17">Error</button>
              <button class="service-filter-option" data-severity="21">Fatal</button>
            </div>
          </span>
          <span class="log-svc" style="position:relative;overflow:visible">
            <button id="log-service-filter-btn" class="header-filter-btn" title="Filter by service">Service <span id="log-service-filter-icon" class="header-filter-icon">▾</span></button>
            <div id="log-service-filter-dropdown" class="header-filter-dropdown" style="display:none"></div>
          </span>
          <span class="log-body-hdr">Details</span>
        </div>
        <div id="logs-list" class="list-container">
          <div class="empty-state">Loading logs…</div>
        </div>
      </div>

      <!-- Resize divider -->
      <div class="logs-divider" id="logs-divider" title="Drag to resize"></div>

      <!-- Right: log detail panel -->
      <div class="logs-right" id="log-detail-panel">
        <div class="span-detail-placeholder">
          ← Click a log entry to view its details
        </div>
      </div>
    </div>
  </div>

</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    OtelInsightsPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
  }
}

function formatTraceForChat(data: Record<string, unknown>): string {
  return `#otelSpans Look at trace \`${data.traceId}\``;
}

function formatItemsForChat(traces: Record<string, unknown>[], spans: Record<string, unknown>[]): string {
  const parts: string[] = [];
  if (traces.length) {
    const ids = traces.map(d => `\`${d.traceId}\``).join(', ');
    parts.push(`traces ${ids}`);
  }
  if (spans.length) {
    const ids = spans.map(d => `\`${d.spanId}\` in trace \`${d.traceId}\``).join(', ');
    parts.push(`spans ${ids}`);
  }
  if (!parts.length) { return ''; }
  return `#otelSpans Look at ${parts.join(' and ')}`;
}

function formatSpanForChat(data: Record<string, unknown>): string {
  return `#otelSpans Look at span \`${data.spanId}\` in trace \`${data.traceId}\``;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
