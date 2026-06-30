import * as vscode from 'vscode';
import { TelemetryStore } from '@otel-insights/receiver';
import { getTraces, getSpansByTraceId, getMetricsData, getLogs } from '@otel-insights/engine';
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
      (msg: WebviewToExtension) => this.handleMessage(msg),
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

  private post(msg: ExtensionToWebview): void {
    this.panel.webview.postMessage(msg);
  }

  private handleMessage(msg: WebviewToExtension): void {
    const db = this.store.getDb();
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'status', connected: true, port: this.port });
        break;
      case 'getTraces':
        this.post({ type: 'traces', data: getTraces(db) });
        break;
      case 'getSpans':
        this.post({ type: 'spans', traceId: msg.traceId, data: getSpansByTraceId(db, msg.traceId) });
        break;
      case 'getMetrics':
        this.post({ type: 'metrics', data: getMetricsData(db) });
        break;
      case 'getLogs':
        this.post({ type: 'logs', data: getLogs(db, { filter: msg.filter, minSeverity: msg.minSeverity }) });
        break;
      case 'clearData':
        this.store.clear();
        this.post({ type: 'status', connected: true, port: this.port });
        break;
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
                 script-src 'nonce-${nonce}';">
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
      <button id="refresh-btn" class="icon-btn" title="Refresh data">↻</button>
      <button id="clear-btn"   class="icon-btn icon-btn--danger" title="Clear all stored telemetry">✕ Clear</button>
    </div>
  </header>

  <!-- Traces tab -->
  <div id="traces-panel" class="panel active" role="tabpanel">
    <div id="traces-list" class="list-container">
      <div class="empty-state">Loading traces…</div>
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
        <h3 class="card-title">🐢 Slowest Operations</h3>
        <div id="slowest-ops"></div>
      </section>

      <section class="card">
        <h3 class="card-title">🪙 Token Usage</h3>
        <div id="token-usage"></div>
      </section>

      <section class="card card--wide">
        <h3 class="card-title">🔧 Tool Calls</h3>
        <div id="tool-calls"></div>
      </section>

    </div>
  </div>

  <!-- Logs tab -->
  <div id="logs-panel" class="panel" role="tabpanel">
    <div class="logs-toolbar">
      <input  id="log-filter"   type="text"    placeholder="Filter by message, service…" />
      <select id="log-severity">
        <option value="0">All severities</option>
        <option value="5">Debug+</option>
        <option value="9">Info+</option>
        <option value="13">Warn+</option>
        <option value="17">Error+</option>
      </select>
      <button id="apply-filter-btn">Filter</button>
    </div>
    <div id="logs-list" class="list-container">
      <div class="empty-state">Loading logs…</div>
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

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
