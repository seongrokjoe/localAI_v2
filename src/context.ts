import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { ContextItem } from "./types";
export { estimateTokens, truncateToTokens } from "./tokenBudget";

export class ContextManager {
  private readonly items = new Map<string, ContextItem>();
  private readonly changedEmitter = new vscode.EventEmitter<ContextItem[]>();
  readonly onDidChange = this.changedEmitter.event;

  addSelection(document: vscode.TextDocument, range: vscode.Range, text: string): ContextItem {
    const label = `${contextPath(document.uri)}:${range.start.line + 1}`;
    return this.add({
      type: "selection",
      label,
      content: text,
      uri: document.uri.toString(),
      languageId: document.languageId,
      range: {
        startLine: range.start.line,
        startCharacter: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character,
      },
    });
  }

  addFile(document: vscode.TextDocument): ContextItem {
    return this.add({
      type: "file",
      label: contextPath(document.uri),
      content: document.getText(),
      uri: document.uri.toString(),
      languageId: document.languageId,
    });
  }

  addNote(label: string, content: string): ContextItem {
    return this.add({
      type: "note",
      label,
      content,
    });
  }

  list(): ContextItem[] {
    return Array.from(this.items.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  clear(): void {
    this.items.clear();
    this.changedEmitter.fire(this.list());
  }

  remove(id: string): void {
    this.items.delete(id);
    this.changedEmitter.fire(this.list());
  }

  dispose(): void {
    this.changedEmitter.dispose();
  }

  private add(input: Omit<ContextItem, "id" | "createdAt">): ContextItem {
    const id = crypto.randomUUID();
    const item: ContextItem = {
      id,
      createdAt: Date.now(),
      ...input,
    };
    this.items.set(id, item);
    this.changedEmitter.fire(this.list());
    return item;
  }
}

function contextPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}
