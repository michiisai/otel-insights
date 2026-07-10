import type { SpanRow, MetricRow, LogRow } from './store';

// ---- Attribute helpers ----

type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpValue[] };
  kvlistValue?: { values: Array<{ key: string; value: OtlpValue }> };
};

function flattenAttr(v: OtlpValue): unknown {
  if (v.stringValue !== undefined) { return v.stringValue; }
  if (v.intValue     !== undefined) { return Number(v.intValue); }
  if (v.doubleValue  !== undefined) { return v.doubleValue; }
  if (v.boolValue    !== undefined) { return v.boolValue; }
  if (v.arrayValue)  { return v.arrayValue.values.map(flattenAttr); }
  if (v.kvlistValue) {
    const obj: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values) { obj[kv.key] = flattenAttr(kv.value); }
    return obj;
  }
  return null;
}

function parseAttrs(attrs?: Array<{ key: string; value: OtlpValue }>): Record<string, unknown> {
  if (!attrs?.length) { return {}; }
  const out: Record<string, unknown> = {};
  for (const a of attrs) { out[a.key] = flattenAttr(a.value); }
  return out;
}

function serviceName(resourceAttrs?: Array<{ key: string; value: OtlpValue }>): string {
  return (resourceAttrs?.find(a => a.key === 'service.name')?.value?.stringValue) ?? '';
}

function nanosDiff(startNs: string, endNs: string): number {
  try {
    return Number(BigInt(endNs) - BigInt(startNs)) / 1_000_000;
  } catch {
    return 0;
  }
}

// ---- OTLP parsers ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseOtlpTraces(body: any): SpanRow[] {
  const rows: SpanRow[] = [];
  for (const rs of (body?.resourceSpans ?? [])) {
    const svc = serviceName(rs.resource?.attributes);
    for (const ss of (rs?.scopeSpans ?? [])) {
      for (const span of (ss?.spans ?? [])) {
        const startNs = String(span.startTimeUnixNano ?? '0');
        const endNs   = String(span.endTimeUnixNano   ?? '0');
        rows.push({
          traceId:            span.traceId  ?? '',
          spanId:             span.spanId   ?? '',
          parentSpanId:       span.parentSpanId || null,
          name:               span.name ?? '',
          kind:               span.kind ?? 0,
          startTimeUnixNano:  startNs,
          endTimeUnixNano:    endNs,
          durationMs:         nanosDiff(startNs, endNs),
          statusCode:         span.status?.code    ?? 0,
          statusMessage:      span.status?.message ?? null,
          attributes:         JSON.stringify(parseAttrs(span.attributes)),
          serviceName:        svc,
        });
      }
    }
  }
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseOtlpMetrics(body: any): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const rm of (body?.resourceMetrics ?? [])) {
    const svc = serviceName(rm.resource?.attributes);
    for (const sm of (rm?.scopeMetrics ?? [])) {
      for (const metric of (sm?.metrics ?? [])) {
        const dataPoints = [
          ...(metric.gauge?.dataPoints       ?? []),
          ...(metric.sum?.dataPoints         ?? []),
          ...(metric.histogram?.dataPoints   ?? []),
        ];
        for (const dp of dataPoints) {
          const value = dp.asDouble ?? dp.asInt ?? dp.sum ?? null;
          rows.push({
            name:               metric.name ?? '',
            value:              value !== null ? Number(value) : null,
            timestampUnixNano:  String(dp.timeUnixNano ?? '0'),
            attributes:         JSON.stringify(parseAttrs(dp.attributes)),
            unit:               metric.unit ?? null,
            serviceName:        svc,
          });
        }
      }
    }
  }
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseOtlpLogs(body: any): LogRow[] {
  const rows: LogRow[] = [];
  for (const rl of (body?.resourceLogs ?? [])) {
    const svc = serviceName(rl.resource?.attributes);
    for (const sl of (rl?.scopeLogs ?? [])) {
      for (const lr of (sl?.logRecords ?? [])) {
        const bodyStr =
          typeof lr.body?.stringValue === 'string'
            ? lr.body.stringValue
            : JSON.stringify(lr.body ?? '');
        rows.push({
          timestampUnixNano: String(lr.timeUnixNano ?? lr.observedTimeUnixNano ?? '0'),
          severityNumber:    lr.severityNumber ?? 0,
          severityText:      lr.severityText   ?? '',
          body:              bodyStr,
          attributes:        JSON.stringify(parseAttrs(lr.attributes)),
          traceId:           lr.traceId  || null,
          spanId:            lr.spanId   || null,
          serviceName:       svc,
        });
      }
    }
  }
  return rows;
}
