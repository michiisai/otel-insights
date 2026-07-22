import * as vscode from 'vscode';
import type { TabId } from '@otel-insights/types';

interface NavEntry {
  id: TabId;
  label: string;
  /** VS Code ThemeIcon id (https://code.visualstudio.com/api/references/icons-in-labels). */
  icon: string;
}

/** Activity-bar sidebar navigation, top-to-bottom. Selecting an entry reveals
 *  the editor panel and switches it to the matching top-level view. */
const NAV_ENTRIES: NavEntry[] = [
  { id: 'home',     label: 'Home',     icon: 'home' },
  { id: 'sessions', label: 'Sessions', icon: 'comment-discussion' },
  { id: 'traces',   label: 'Traces',   icon: 'list-tree' },
  { id: 'metrics',  label: 'Metrics',  icon: 'graph' },
  { id: 'logs',     label: 'Logs',     icon: 'output' },
];

export class OtelNavProvider implements vscode.TreeDataProvider<NavEntry> {
  getTreeItem(entry: NavEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
    item.id       = entry.id;
    item.iconPath = new vscode.ThemeIcon(entry.icon);
    item.tooltip  = `Open ${entry.label}`;
    item.command  = {
      command:   'otel-insights.showTab',
      title:     `Open ${entry.label}`,
      arguments: [entry.id],
    };
    return item;
  }

  getChildren(): NavEntry[] {
    return NAV_ENTRIES;
  }
}
