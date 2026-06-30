import * as http from 'http';
import { TelemetryStore } from './store';
import { parseOtlpTraces, parseOtlpMetrics, parseOtlpLogs } from './parser';

export class OtlpReceiver {
  private server: http.Server;

  constructor(
    private readonly store: TelemetryStore,
    public readonly port: number = 4318,
  ) {
    this.server = this.buildServer();
  }

  private buildServer(): http.Server {
    return http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (req.url === '/v1/traces') {
            this.store.insertSpans(parseOtlpTraces(body));
          } else if (req.url === '/v1/metrics') {
            this.store.insertMetrics(parseOtlpMetrics(body));
          } else if (req.url === '/v1/logs') {
            this.store.insertLogs(parseOtlpLogs(body));
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        } catch {
          res.writeHead(400).end();
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
    });
  }
}
