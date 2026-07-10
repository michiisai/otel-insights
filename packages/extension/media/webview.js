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

  // ── Elements ─────────────────────────────────────────────────────────────────
  const $ = (/** @type {string} */ id) => document.getElementById(id);

  const statusBadge  = $('status-badge');
  const refreshBtn   = $('refresh-btn');
  const clearBtn     = $('clear-btn');
  const tracesList   = $('traces-list');
  const logsList     = $('logs-list');
  const logFilter    = /** @type {HTMLInputElement}  */ ($('log-filter'));
  const logSeverity  = /** @type {HTMLSelectElement} */ ($('log-severity'));
  const traceSearch  = /** @type {HTMLInputElement}  */ ($('trace-search'));
  const traceService = /** @type {HTMLSelectElement} */ ($('trace-service'));
  const traceErrBtn  = $('trace-errors-btn');

  let errorsOnly = false;

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
    if (activeTab === 'traces')           { fetchTraces(); }
    else if (activeTab === 'performance') { vscode.postMessage({ type: 'getMetrics' }); }
    else if (activeTab === 'logs')        { fetchLogs(); }
  }

  function fetchTraces() {
    vscode.postMessage({
      type:       'getTraces',
      search:     traceSearch?.value  || undefined,
      service:    traceService?.value || undefined,
      errorsOnly: errorsOnly || undefined,
    });
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
    vscode.postMessage({ type: 'clearData' });
  });

  logSeverity?.addEventListener('change', fetchLogs);
  logFilter?.addEventListener('input', fetchLogs);
  logFilter?.addEventListener('keydown', e => { if (e.key === 'Enter') { fetchLogs(); } });

  traceSearch?.addEventListener('input', fetchTraces);
  traceSearch?.addEventListener('keydown', e => { if (e.key === 'Enter') { fetchTraces(); } });
  traceService?.addEventListener('change', fetchTraces);
  traceErrBtn?.addEventListener('click', () => {
    errorsOnly = !errorsOnly;
    traceErrBtn.classList.toggle('active', errorsOnly);
    fetchTraces();
  });

  // ── Traces panel resize ───────────────────────────────────────────────────────
  (function initResizer() {
    const divider    = $('traces-divider');
    const rightPanel = $('span-detail-panel');
    const split      = divider?.parentElement;
    if (!divider || !rightPanel || !split) { return; }

    // Cast to non-null after guard so TypeScript doesn't complain inside closures
    const divEl   = /** @type {HTMLElement} */ (divider);
    const rightEl = /** @type {HTMLElement} */ (rightPanel);
    const splitEl = /** @type {HTMLElement} */ (split);

    let startX = 0;
    let startW = 0;

    divEl.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = rightEl.getBoundingClientRect().width;
      divEl.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      function onMove(/** @type {MouseEvent} */ ev) {
        const delta  = startX - ev.clientX;
        const splitW = splitEl.getBoundingClientRect().width;
        const newW   = Math.min(Math.max(startW + delta, splitW * 0.2), splitW * 0.5);
        rightEl.style.width = `${newW}px`;
      }

      function onUp() {
        divEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }());

  // ── Message handler ───────────────────────────────────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'status':   renderStatus(msg);                    break;
      case 'traces':   renderTraces(msg.data);               break;
      case 'services': renderServices(msg.data);             break;
      case 'spans':    renderSpans(msg.traceId, msg.data);   break;
      case 'metrics': renderMetrics(msg.data);              break;
      case 'logs':    renderLogs(msg.data);                 break;
      case 'cleared': vscode.postMessage({ type: 'getServices' }); loadCurrentTab(); break;
    }
  });

  // ── Status ────────────────────────────────────────────────────────────────────
  function renderStatus(/** @type {{connected:boolean,port:number}} */ s) {
    if (!statusBadge) { return; }
    statusBadge.textContent = s.connected ? `● :${s.port}` : '● offline';
    statusBadge.className   = `badge ${s.connected ? 'badge--ok' : 'badge--err'}`;
  }

  // ── Services dropdown ────────────────────────────────────────────────────────
  function renderServices(/** @type {string[]} */ services) {
    if (!traceService) { return; }
    const current = traceService.value;
    traceService.innerHTML = '<option value="">All services</option>' +
      services.map(s => `<option value="${esc(s)}"${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');
  }

  // ── Traces ────────────────────────────────────────────────────────────────────
  function renderTraces(/** @type {any[]} */ traces) {
    if (!tracesList) { return; }
    if (!traces.length) {
      tracesList.innerHTML = '<div class="empty-state">No traces yet.<br><small>Point your app\'s OTLP exporter at <code>http://127.0.0.1:4318</code></small></div>';
      return;
    }

    tracesList.innerHTML = traces.map(t => {
      const isOpen = expandedTraces.has(t.traceId);
      return `
        <div class="trace-row ${t.hasError ? 'row--error' : ''} ${isOpen ? '' : 'collapsed'}" data-id="${esc(t.traceId)}">
          <span class="expand-icon" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          <span class="cell cell--name">
            <span class="trace-name">${esc(t.rootSpanName)}</span>
            <span class="trace-id">${esc(t.traceId)}</span>
          </span>
          <span class="cell cell--service">${esc(t.serviceName)}</span>
          <span class="cell cell--ts">${fmtNano(t.startTimeUnixNano)}</span>
          <span class="cell cell--dur">${fmtMs(t.durationMs)}</span>
          <span class="cell cell--spans">${t.spanCount} span${t.spanCount !== 1 ? 's' : ''}</span>
          <span class="pill pill--err${t.hasError ? '' : ' pill--hidden'}" aria-hidden="${t.hasError ? 'false' : 'true'}">ERR</span>
        </div>
        <div class="waterfall-container" id="sc-${esc(t.traceId)}"
             style="display:${isOpen ? 'block' : 'none'}">
          <div class="loading-row">loading spans…</div>
        </div>
      `;
    }).join('');

    tracesList.querySelectorAll('.trace-row').forEach(row => {
      row.addEventListener('click', () => {
        const id        = /** @type {HTMLElement} */ (row).dataset.id ?? '';
        const container = $(`sc-${id}`);
        const icon      = row.querySelector('.expand-icon');
        if (!container) { return; }

        if (expandedTraces.has(id)) {
          expandedTraces.delete(id);
          container.style.display = 'none';
          row.classList.add('collapsed');
          if (icon) { icon.textContent = '▸'; }
        } else {
          expandedTraces.add(id);
          container.style.display = 'block';
          row.classList.remove('collapsed');
          if (icon) { icon.textContent = '▾'; }
          vscode.postMessage({ type: 'getSpans', traceId: id });
        }
      });
    });
  }

  // ── Span waterfall ────────────────────────────────────────────────────────────
  function renderSpans(/** @type {string} */ traceId, /** @type {any[]} */ spans) {
    const container = $(`sc-${traceId}`);
    if (!container) { return; }
    if (!spans.length) {
      container.innerHTML = '<div class="empty-state small">No spans found.</div>';
      return;
    }

    // Build parent-child tree
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

    // Compute timeline range with BigInt for nanosecond precision
    let traceStartNano = BigInt(spans[0].startTimeUnixNano);
    let traceEndNano   = traceStartNano;
    spans.forEach(s => {
      const start = BigInt(s.startTimeUnixNano);
      const end   = start + BigInt(Math.round(s.durationMs * 1_000_000));
      if (start < traceStartNano) { traceStartNano = start; }
      if (end   > traceEndNano)   { traceEndNano   = end; }
    });
    const traceTotalNano = traceEndNano - traceStartNano;

    /** @param {any} node @param {number} depth @returns {string} */
    function nodeHtml(node, depth) {
      const isErr     = node.statusCode === 2;
      const indent    = depth * 14;
      const startNano = BigInt(node.startTimeUnixNano);
      const durNano   = BigInt(Math.round(node.durationMs * 1_000_000));
      const offsetPct = traceTotalNano > 0n
        ? Number((startNano - traceStartNano) * 10000n / traceTotalNano) / 100
        : 0;
      const widthPct = traceTotalNano > 0n
        ? Math.max(0.3, Number(durNano * 10000n / traceTotalNano) / 100)
        : 100;
      const barColor = isErr ? 'var(--err)' : spanKindColor(node.kind);

      return `
        <div class="waterfall-row ${isErr ? 'row--error' : ''}"
             data-span-id="${esc(node.spanId)}"
             data-trace-id="${esc(traceId)}">
          <div class="waterfall-info" style="padding-left:${indent + 4}px">
            <span class="span-kind kind-${node.kind}">${SPAN_KIND[node.kind] ?? '?'}</span>
            <span class="waterfall-name" title="${esc(node.name)}">${esc(node.name)}</span>
          </div>
          <div class="waterfall-bar-area">
            <div class="waterfall-bar"
                 style="left:${offsetPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${barColor}">
            </div>
          </div>
          <span class="waterfall-dur">${fmtMs(node.durationMs)}</span>
          <span class="pill pill--err${isErr ? '' : ' pill--hidden'}" aria-hidden="${isErr ? 'false' : 'true'}">ERR</span>
        </div>
        ${node.children.map((/** @type {any} */ c) => nodeHtml(c, depth + 1)).join('')}
      `;
    }

    container.innerHTML = roots.map(r => nodeHtml(r, 0)).join('');

    // Clicking a span row shows its detail in the right panel
    container.querySelectorAll('.waterfall-row').forEach(row => {
      row.addEventListener('click', () => {
        const spanId = /** @type {HTMLElement} */ (row).dataset.spanId ?? '';
        const node   = byId[spanId];
        if (!node) { return; }
        document.querySelectorAll('.waterfall-row.selected').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        showSpanDetail(node);
      });
    });
  }

  /** @param {number} kind @returns {string} */
  function spanKindColor(kind) {
    switch (kind) {
      case 1:  return '#b39ddb'; // INTERNAL  — soft purple
      case 2:  return '#4fc3f7'; // SERVER    — sky blue
      case 3:  return '#4ec9b0'; // CLIENT    — teal
      case 4:  return '#ffa726'; // PRODUCER  — amber
      case 5:  return '#81c784'; // CONSUMER  — green
      default: return '#888888'; // UNSPECIFIED — gray
    }
  }

  /** @param {any} node */
  function showSpanDetail(node) {
    const panel = $('span-detail-panel');
    if (!panel) { return; }
    panel.innerHTML = `
      <div class="span-detail-panel-header">Span Details</div>
      ${spanDetailHtml(node)}
    `;
  }

  // Toggle long attribute values in the right panel (delegated)
  $('span-detail-panel')?.addEventListener('click', e => {
    const row = /** @type {HTMLElement} */ (e.target)?.closest('.attr-row-long');
    if (!row) { return; }
    const textEl    = row.querySelector('.attr-val-text');
    const chevron   = row.querySelector('.attr-chevron');
    if (!textEl) { return; }
    const collapsed = textEl.classList.toggle('collapsed');
    if (chevron) { chevron.textContent = collapsed ? '▶' : '▾'; }
  });

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

    const LONG_THRESHOLD = 120;

    const attrsHtml = attrEntries.length > 0
      ? `<div class="attrs-section">
           <div class="attrs-title">Attributes (${attrEntries.length})</div>
           <table class="attrs-table">
             ${attrEntries.map(([k, v]) => {
               const text = fmtAttr(v);
               const isLong = text.length > LONG_THRESHOLD;
               const keyCell = isLong
                 ? `<td class="attr-key"><span class="attr-chevron">▶</span>${esc(k)}</td>`
                 : `<td class="attr-key">${esc(k)}</td>`;
               const valCell = isLong
                 ? `<td class="attr-val"><span class="attr-val-text collapsed">${esc(text)}</span></td>`
                 : `<td class="attr-val"><span class="attr-val-text">${esc(text)}</span></td>`;
               return `<tr class="${isLong ? 'attr-row-long' : ''}">${keyCell}${valCell}</tr>`;
             }).join('')}
           </table>
         </div>`
      : '<div class="attrs-empty">No attributes</div>';

    return `
      <div class="right-panel-span-name">${esc(node.name)}</div>
      <div class="span-meta-grid">${metaHtml}</div>
      ${attrsHtml}
    `;
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

    const fmtNum = (/** @type {number} */ n) => n.toLocaleString();

    const fmtMs = (/** @type {number} */ ms) =>
      ms <= 0   ? '–'
      : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.round(ms)}ms`;

    const errClass  = s.errorTraces > 0 ? ' text-err' : '';
    const errorRate = s.totalTraces > 0
      ? `${Math.round(s.errorTraces / s.totalTraces * 100)}%`
      : '–';

    // Per OTel GenAI semconv, input_tokens already includes cache_read tokens.
    // Total = input + output only; cached is a subset of input, not additive.
    const totalTokens   = s.inputTokens + s.outputTokens;
    const cacheHitPct   = s.inputTokens > 0
      ? `${Math.round(s.cachedTokens / s.inputTokens * 100)}%`
      : '–';

    el.innerHTML = `
      <div class="summary-section">
        <div class="summary-section-lbl">Activity</div>
        <div class="summary-row">
          <div class="summary-item"><span class="summary-val">${s.llmCalls}</span><span class="summary-lbl">LLM Calls</span></div>
          <div class="summary-item"><span class="summary-val">${s.toolCallsTotal}</span><span class="summary-lbl">Tool Calls</span></div>
          <div class="summary-item"><span class="summary-val${errClass}">${errorRate}</span><span class="summary-lbl">Error Rate</span></div>
          <div class="summary-item"><span class="summary-val">${fmtMs(s.p95Ms)}</span><span class="summary-lbl">P95 Latency</span></div>
        </div>
      </div>
      <div class="summary-section">
        <div class="summary-section-lbl">Tokens</div>
        <div class="summary-row summary-row--wide">
          <div class="summary-item"><span class="summary-val">${fmtNum(s.inputTokens)}</span><span class="summary-lbl">Input</span></div>
          <div class="summary-item"><span class="summary-val">${fmtNum(s.outputTokens)}</span><span class="summary-lbl">Output</span></div>
          <div class="summary-item"><span class="summary-val">${fmtNum(totalTokens)}</span><span class="summary-lbl">Total</span></div>
          <div class="summary-item"><span class="summary-val">${fmtNum(s.cachedTokens)}</span><span class="summary-lbl">Cache Hits</span></div>
          <div class="summary-item"><span class="summary-val">${cacheHitPct}</span><span class="summary-lbl">Cache Hit %</span></div>
        </div>
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
    return `<div class="table-scroll"><table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'getServices' });
  vscode.postMessage({ type: 'getTraces' });
}());
