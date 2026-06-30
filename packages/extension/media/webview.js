// @ts-check
// Runs inside the VS Code webview (browser context, no Node.js).
(function () {
  'use strict';

  // ── VS Code API ──────────────────────────────────────────────────────────────
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────────
  let activeTab = 'traces';
  /** @type {Set<string>} */
  const expandedTraces = new Set();
  /** @type {Set<string>} expanded span detail drawers */
  const expandedSpans = new Set();

  // ── Elements ─────────────────────────────────────────────────────────────────
  const $ = (/** @type {string} */ id) => document.getElementById(id);

  const statusBadge = $('status-badge');
  const refreshBtn  = $('refresh-btn');
  const clearBtn    = $('clear-btn');
  const tracesList  = $('traces-list');
  const logsList    = $('logs-list');
  const logFilter   = /** @type {HTMLInputElement}  */ ($('log-filter'));
  const logSeverity = /** @type {HTMLSelectElement} */ ($('log-severity'));
  const applyFilter = $('apply-filter-btn');

  // ── Tab switching ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const name  = /** @type {HTMLElement} */ (tab).dataset.tab ?? '';
      const panel = $(`${name}-panel`);
      if (panel) { panel.classList.add('active'); }
      activeTab = name;
      loadCurrentTab();
    });
  });

  function loadCurrentTab() {
    if (activeTab === 'traces')           { vscode.postMessage({ type: 'getTraces' }); }
    else if (activeTab === 'performance') { vscode.postMessage({ type: 'getMetrics' }); }
    else if (activeTab === 'logs')        { fetchLogs(); }
  }

  function fetchLogs() {
    vscode.postMessage({
      type:        'getLogs',
      filter:      logFilter.value,
      minSeverity: Number(logSeverity.value),
    });
  }

  refreshBtn?.addEventListener('click', loadCurrentTab);

  clearBtn?.addEventListener('click', () => {
    if (confirm('Clear all stored telemetry data? This cannot be undone.')) {
      vscode.postMessage({ type: 'clearData' });
      setTimeout(loadCurrentTab, 150);
    }
  });

  applyFilter?.addEventListener('click', fetchLogs);
  logSeverity?.addEventListener('change', fetchLogs);
  logFilter?.addEventListener('keydown', e => { if (e.key === 'Enter') { fetchLogs(); } });

  // ── Span detail: single delegated listener (attached once) ───────────────────
  tracesList?.addEventListener('click', e => {
    const spanRow = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target)?.closest('.span-row')
    );
    if (!spanRow) { return; }

    const spanId = spanRow.dataset.spanId;
    if (!spanId) { return; }

    const detail = document.getElementById(`sd-${spanId}`);
    if (!detail) { return; }

    const icon = spanRow.querySelector('.span-expand-icon');
    if (expandedSpans.has(spanId)) {
      expandedSpans.delete(spanId);
      detail.style.display = 'none';
      if (icon) { icon.textContent = '▸'; }
    } else {
      expandedSpans.add(spanId);
      detail.style.display = 'block';
      if (icon) { icon.textContent = '▾'; }
    }
  });

  // ── Message handler ───────────────────────────────────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'status':  renderStatus(msg);                    break;
      case 'traces':  renderTraces(msg.data);               break;
      case 'spans':   renderSpans(msg.traceId, msg.data);   break;
      case 'metrics': renderMetrics(msg.data);              break;
      case 'logs':    renderLogs(msg.data);                 break;
    }
  });

  // ── Status ────────────────────────────────────────────────────────────────────
  function renderStatus(/** @type {{connected:boolean,port:number}} */ s) {
    if (!statusBadge) { return; }
    statusBadge.textContent = s.connected ? `● :${s.port}` : '● offline';
    statusBadge.className   = `badge ${s.connected ? 'badge--ok' : 'badge--err'}`;
  }

  // ── Traces ────────────────────────────────────────────────────────────────────
  function renderTraces(/** @type {any[]} */ traces) {
    if (!tracesList) { return; }
    if (!traces.length) {
      tracesList.innerHTML = '<div class="empty-state">No traces yet.<br><small>Point your app\'s OTLP exporter at <code>http://127.0.0.1:4318</code></small></div>';
      return;
    }

    tracesList.innerHTML = traces.map(t => `
      <div class="trace-row ${t.hasError ? 'row--error' : ''}" data-id="${esc(t.traceId)}">
        <span class="expand-icon" aria-hidden="true">${expandedTraces.has(t.traceId) ? '▾' : '▸'}</span>
        <span class="cell cell--name" title="${esc(t.traceId)}">${esc(t.rootSpanName)}</span>
        <span class="cell cell--service">${esc(t.serviceName)}</span>
        <span class="cell cell--dur">${fmtMs(t.durationMs)}</span>
        <span class="cell cell--spans">${t.spanCount} span${t.spanCount !== 1 ? 's' : ''}</span>
        ${t.hasError ? '<span class="pill pill--err">ERR</span>' : ''}
      </div>
      <div class="spans-container" id="sc-${esc(t.traceId)}"
           style="display:${expandedTraces.has(t.traceId) ? 'block' : 'none'}">
        <div class="loading-row">loading spans…</div>
      </div>
    `).join('');

    tracesList.querySelectorAll('.trace-row').forEach(row => {
      row.addEventListener('click', () => {
        const id        = /** @type {HTMLElement} */ (row).dataset.id ?? '';
        const container = $(`sc-${id}`);
        const icon      = row.querySelector('.expand-icon');
        if (!container) { return; }

        if (expandedTraces.has(id)) {
          expandedTraces.delete(id);
          container.style.display = 'none';
          if (icon) { icon.textContent = '▸'; }
        } else {
          expandedTraces.add(id);
          container.style.display = 'block';
          if (icon) { icon.textContent = '▾'; }
          vscode.postMessage({ type: 'getSpans', traceId: id });
        }
      });
    });
  }

  // ── Span tree ─────────────────────────────────────────────────────────────────
  function renderSpans(/** @type {string} */ traceId, /** @type {any[]} */ spans) {
    const container = $(`sc-${traceId}`);
    if (!container) { return; }
    if (!spans.length) {
      container.innerHTML = '<div class="empty-state small">No spans found.</div>';
      return;
    }

    // Build tree
    /** @type {Record<string,any>} */
    const byId = {};
    spans.forEach(s => { byId[s.spanId] = { ...s, children: [] }; });
    /** @type {any[]} */
    const roots = [];
    spans.forEach(s => {
      if (s.parentSpanId && byId[s.parentSpanId]) {
        byId[s.parentSpanId].children.push(byId[s.spanId]);
      } else {
        roots.push(byId[s.spanId]);
      }
    });

    /** @param {any} node @param {number} depth @returns {string} */
    function nodeHtml(node, depth) {
      const isErr     = node.statusCode === 2;
      const indent    = depth * 18 + 8;
      const isOpen    = expandedSpans.has(node.spanId);
      const attrCount = Object.keys(node.attributes ?? {}).length;

      return `
        <div class="span-row ${isErr ? 'row--error' : ''}"
             style="padding-left:${indent}px"
             data-span-id="${esc(node.spanId)}">
          <span class="span-expand-icon" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          <span class="span-kind kind-${node.kind}">${SPAN_KIND[node.kind] ?? '?'}</span>
          <span class="cell cell--name">${esc(node.name)}</span>
          <span class="cell cell--service">${esc(node.serviceName)}</span>
          <span class="cell cell--dur">${fmtMs(node.durationMs)}</span>
          ${attrCount > 0 ? `<span class="attr-badge" title="${attrCount} attribute${attrCount !== 1 ? 's' : ''}">${attrCount}</span>` : ''}
          ${isErr ? '<span class="pill pill--err">ERR</span>' : ''}
        </div>
        <div class="span-detail" id="sd-${esc(node.spanId)}"
             style="display:${isOpen ? 'block' : 'none'}; padding-left:${indent + 36}px">
          ${spanDetailHtml(node)}
        </div>
        ${node.children.map(c => nodeHtml(c, depth + 1)).join('')}
      `;
    }

    container.innerHTML = roots.map(r => nodeHtml(r, 0)).join('');
  }

  /** @param {any} node @returns {string} */
  function spanDetailHtml(node) {
    const STATUS_LABELS = ['UNSET', 'OK', 'ERROR'];
    const KIND_LABELS   = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
    const statusText    = STATUS_LABELS[node.statusCode] ?? String(node.statusCode);
    const kindText      = KIND_LABELS[node.kind]         ?? String(node.kind);
    const attrEntries   = Object.entries(node.attributes ?? {});

    const metaHtml = [
      ['Span ID',   `<span class="mono">${esc(node.spanId)}</span>`],
      ['Duration',  `<span class="mono">${fmtMs(node.durationMs)}</span>`],
      ['Kind',      kindText],
      ['Status',    `<span class="${node.statusCode === 2 ? 'text-err' : ''}">${statusText}${node.statusMessage ? ': ' + esc(node.statusMessage) : ''}</span>`],
      ['Start',     `<span class="mono">${fmtNano(node.startTimeUnixNano)}</span>`],
    ].map(([k, v]) => `<div class="meta-key">${k}</div><div class="meta-val">${v}</div>`).join('');

    const attrsHtml = attrEntries.length > 0
      ? `<div class="attrs-section">
           <div class="attrs-title">Attributes</div>
           <table class="attrs-table">
             ${attrEntries.map(([k, v]) => `
               <tr>
                 <td class="attr-key">${esc(k)}</td>
                 <td class="attr-val">${esc(fmtAttr(v))}</td>
               </tr>`).join('')}
           </table>
         </div>`
      : '<div class="attrs-empty">No attributes</div>';

    return `<div class="span-detail-inner"><div class="span-meta-grid">${metaHtml}</div>${attrsHtml}</div>`;
  }

  /** @param {unknown} v @returns {string} */
  function fmtAttr(v) {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'object')         { return JSON.stringify(v); }
    return String(v);
  }

  // ── Performance ───────────────────────────────────────────────────────────────
  function renderMetrics(/** @type {any} */ data) {
    renderSlowest(data.slowestOperations);
    renderTokens(data.tokenUsage);
    renderTools(data.toolCalls);
    renderSummary(data.summary);
  }

  function renderSlowest(/** @type {any[]} */ ops) {
    const el = $('slowest-ops');
    if (!el) { return; }
    if (!ops.length) {
      el.innerHTML = '<div class="empty-state small">No span data yet.</div>';
      return;
    }
    el.innerHTML = table(
      ['Operation', 'Avg', 'Max', 'Count', 'Errors'],
      ops.map(op => [
        `<span class="name-cell" title="${esc(op.name)}">${esc(op.name)}</span>`,
        fmtMs(op.avgDurationMs),
        fmtMs(op.maxDurationMs),
        String(op.count),
        op.errorCount > 0 ? `<span class="pill pill--err">${op.errorCount}</span>` : '0',
      ]),
      ops.map(op => op.errorCount > 0 ? 'row--error' : ''),
    );
  }

  function renderTokens(/** @type {any[]} */ tokens) {
    const el = $('token-usage');
    if (!el) { return; }
    if (!tokens.length) {
      el.innerHTML = '<div class="empty-state small">No token data yet.<br><small>Requires <code>gen_ai.*</code> attributes on spans.</small></div>';
      return;
    }
    el.innerHTML = table(
      ['Model', 'Total', 'Prompt', 'Completion', 'Calls'],
      tokens.map(t => [
        `<span class="name-cell" title="${esc(t.model)}">${esc(t.model)}</span>`,
        fmtNum(t.totalTokens),
        fmtNum(t.promptTokens),
        fmtNum(t.completionTokens),
        String(t.callCount),
      ]),
    );
  }

  function renderTools(/** @type {any[]} */ tools) {
    const el = $('tool-calls');
    if (!el) { return; }
    if (!tools.length) {
      el.innerHTML = '<div class="empty-state small">No tool call data yet.<br><small>Requires <code>gen_ai.tool.name</code> or <code>tool.name</code> attributes on spans.</small></div>';
      return;
    }
    el.innerHTML = table(
      ['Tool', 'Calls', 'Avg', 'Total Time', 'Errors'],
      tools.map(t => [
        `<span class="name-cell" title="${esc(t.toolName)}">${esc(t.toolName)}</span>`,
        String(t.count),
        fmtMs(t.avgDurationMs),
        fmtMs(t.totalDurationMs),
        t.errorCount > 0 ? `<span class="pill pill--err">${t.errorCount}</span>` : '0',
      ]),
      tools.map(t => t.errorCount > 0 ? 'row--error' : ''),
    );
  }

  function renderSummary(/** @type {any} */ s) {
    const el = $('summary');
    if (!el) { return; }
    el.innerHTML = `
      <div class="summary-row">
        <div class="summary-item"><span class="summary-val">${s.totalTraces}</span><span class="summary-lbl">Traces</span></div>
        <div class="summary-item"><span class="summary-val">${s.totalSpans}</span><span class="summary-lbl">Spans</span></div>
        <div class="summary-item"><span class="summary-val">${s.totalLogs}</span><span class="summary-lbl">Logs</span></div>
        <div class="summary-item"><span class="summary-val">${s.totalMetricPoints}</span><span class="summary-lbl">Metric pts</span></div>
      </div>
    `;
  }

  // ── Logs ──────────────────────────────────────────────────────────────────────
  function renderLogs(/** @type {any[]} */ logs) {
    if (!logsList) { return; }
    if (!logs.length) {
      logsList.innerHTML = '<div class="empty-state">No logs match the current filter.</div>';
      return;
    }
    logsList.innerHTML = logs.map(log => {
      const levelText  = (log.severityText || severityLabel(log.severityNumber)).toUpperCase();
      const levelClass = severityClass(log.severityNumber);
      const ts         = fmtNano(log.timestampUnixNano);
      return `
        <div class="log-row log-row--${levelClass}">
          <span class="log-ts">${ts}</span>
          <span class="log-level log-level--${levelClass}">${levelText}</span>
          <span class="log-svc">${esc(log.serviceName)}</span>
          <span class="log-body">${esc(log.body)}</span>
        </div>
      `;
    }).join('');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  /** @param {string} s */
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** @param {number} ms */
  function fmtMs(ms) {
    if (ms >= 60_000) { return `${(ms / 60_000).toFixed(1)}m`; }
    if (ms >= 1_000)  { return `${(ms / 1_000).toFixed(2)}s`; }
    if (ms >= 1)      { return `${ms.toFixed(1)}ms`; }
    return `${(ms * 1000).toFixed(0)}µs`;
  }

  /** @param {number} n */
  function fmtNum(n) {
    if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
    if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}K`; }
    return String(n);
  }

  /** @param {string} nanos */
  function fmtNano(nanos) {
    try {
      const ms = Number(BigInt(nanos) / 1_000_000n);
      return new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
    } catch { return nanos; }
  }

  const SPAN_KIND = ['?', 'INT', 'SRV', 'CLI', 'PROD', 'CONS'];

  /** @param {number} n */
  function severityLabel(n) {
    if (n >= 21) { return 'FATAL'; }
    if (n >= 17) { return 'ERROR'; }
    if (n >= 13) { return 'WARN'; }
    if (n >= 9)  { return 'INFO'; }
    if (n >= 5)  { return 'DEBUG'; }
    return 'TRACE';
  }

  /** @param {number} n */
  function severityClass(n) {
    if (n >= 17) { return 'error'; }
    if (n >= 13) { return 'warn'; }
    if (n >= 9)  { return 'info'; }
    return 'debug';
  }

  /**
   * @param {string[]}   headers
   * @param {string[][]} rows
   * @param {string[]}   [rowClasses]
   */
  function table(headers, rows, rowClasses = []) {
    const ths = headers.map(h => `<th>${h}</th>`).join('');
    const trs = rows.map((cells, i) => {
      const cls = rowClasses[i] ? ` class="${rowClasses[i]}"` : '';
      return `<tr${cls}>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'getTraces' });
}());
