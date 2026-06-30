import * as vscode from 'vscode';
import * as path from 'path';
import { TelemetryStore, OtlpReceiver } from '@otel-insights/receiver';
import { OtelInsightsPanel } from './panel';

let receiver: OtlpReceiver | undefined;
let store: TelemetryStore | undefined;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dbPath = path.join(context.globalStorageUri.fsPath, 'telemetry.db');
  store = new TelemetryStore(dbPath);
  await store.initialize();

  const port = vscode.workspace
    .getConfiguration('otelInsights')
    .get<number>('port', 4318);

  receiver = new OtlpReceiver(store, port);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'otel-insights.openPanel';
  context.subscriptions.push(statusBarItem);

  try {
    await receiver.start();
    statusBarItem.text    = `$(broadcast) OTel :${port}`;
    statusBarItem.tooltip = `OTel Insights — OTLP/HTTP receiver on 127.0.0.1:${port}\nClick to open panel`;
  } catch (err) {
    statusBarItem.text    = `$(error) OTel`;
    statusBarItem.tooltip = `OTel Insights — receiver failed to start: ${err}`;
    vscode.window.showWarningMessage(
      `OTel Insights: Could not start OTLP receiver on port ${port}. ${err}`,
    );
  }
  statusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand('otel-insights.openPanel', () => {
      OtelInsightsPanel.createOrShow(context.extensionUri, store!, port);
    }),
    vscode.commands.registerCommand('otel-insights.clearData', () => {
      store!.clear();
      vscode.window.showInformationMessage('OTel Insights: All telemetry data cleared.');
      OtelInsightsPanel.currentPanel?.refresh();
    }),
  );
}

export async function deactivate(): Promise<void> {
  await receiver?.stop().catch(() => undefined);
  store?.close();
}
