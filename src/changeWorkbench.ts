import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AiChangeBlock,
  ChangeWorkbenchBlockState,
  ChangeWorkbenchFileState,
  ChangeWorkbenchState,
  ContextItem,
  PatchApplyOutcome,
  WorkbenchMappingStatus,
} from "./types";
import { WorkspaceTools } from "./tools";

interface WorkbenchBlock extends AiChangeBlock {
  fileId?: string;
  mappingStatus: WorkbenchMappingStatus;
  startOffset?: number;
  endOffset?: number;
  currentText?: string;
  selected: boolean;
  manuallyEdited: boolean;
}

interface WorkbenchFile {
  id: string;
  path: string;
  originalUri: vscode.Uri;
  draftUri: vscode.Uri;
  baseUri: vscode.Uri;
  baseText: string;
  baseHash: string;
  languageId: string;
  eol: string;
  saved: boolean;
}

interface WorkbenchSession {
  schemaVersion: 2;
  id: string;
  prompt: string;
  assistantResponse: string;
  message: string;
  rootUri: vscode.Uri;
  activeFileId?: string;
  files: WorkbenchFile[];
  blocks: WorkbenchBlock[];
}

interface StoredWorkbench {
  schemaVersion: 2;
  id: string;
  prompt: string;
  assistantResponse: string;
  message: string;
  rootUri: string;
  activeFileId?: string;
  files: Array<Omit<WorkbenchFile, "originalUri" | "draftUri" | "baseUri" | "baseText"> & {
    originalUri: string;
    draftUri: string;
    baseUri: string;
  }>;
  blocks: WorkbenchBlock[];
}

interface PanelMessage {
  type: string;
  blockId?: string;
  fileId?: string;
  checked?: boolean;
}

export class ChangeWorkbenchManager implements vscode.Disposable {
  private active?: WorkbenchSession;
  private panel?: vscode.WebviewPanel;
  private draftColumn?: vscode.ViewColumn;
  private readonly stateEmitter = new vscode.EventEmitter<ChangeWorkbenchState | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly suppressedDrafts = new Set<string>();

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageRoot: vscode.Uri,
    private readonly tools: WorkspaceTools,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.handleDraftChange(event)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.findFileByDraft(document.uri)) void this.emitState();
      }),
    );
  }

  async initialize(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.workbenchesRoot());
    try {
      const bytes = await vscode.workspace.fs.readFile(this.activeStateUri());
      const stored = JSON.parse(new TextDecoder().decode(bytes)) as Partial<StoredWorkbench>;
      if (stored.schemaVersion !== 2 || !stored.id || !stored.rootUri || !stored.files || !stored.blocks) {
        await this.clearActiveState();
        this.output.appendLine("[변경 작업대] 이전 conflict 기반 작업본은 복원하지 않았습니다. 원본 파일은 변경되지 않았습니다.");
        return;
      }
      const files: WorkbenchFile[] = [];
      for (const file of stored.files) {
        const baseUri = vscode.Uri.parse(file.baseUri);
        const baseText = new TextDecoder().decode(await vscode.workspace.fs.readFile(baseUri));
        files.push({
          ...file,
          originalUri: vscode.Uri.parse(file.originalUri),
          draftUri: vscode.Uri.parse(file.draftUri),
          baseUri,
          baseText,
        });
      }
      this.active = {
        schemaVersion: 2,
        id: stored.id,
        prompt: stored.prompt ?? "",
        assistantResponse: stored.assistantResponse ?? "",
        message: stored.message ?? "변경 작업대를 복원했습니다.",
        rootUri: vscode.Uri.parse(stored.rootUri),
        activeFileId: stored.activeFileId,
        files,
        blocks: stored.blocks,
      };
      await this.emitState();
    } catch {
      this.active = undefined;
    }
  }

  async create(prompt: string, assistantResponse: string, sourceBlocks: AiChangeBlock[], contextItems: ContextItem[]): Promise<ChangeWorkbenchState> {
    if (this.active) {
      const choice = await vscode.window.showWarningMessage(
        "진행 중인 변경 작업대를 버리고 새 작업대를 열까요?",
        { modal: true },
        "새 작업대 열기",
      );
      if (choice !== "새 작업대 열기") return await this.getState();
      await this.discard(false);
    }

    const id = crypto.randomUUID();
    const rootUri = vscode.Uri.joinPath(this.workbenchesRoot(), id);
    await vscode.workspace.fs.createDirectory(rootUri);
    const session: WorkbenchSession = {
      schemaVersion: 2,
      id,
      prompt,
      assistantResponse,
      message: "AI 코드 블록을 확인하고 필요한 변경을 선택하세요.",
      rootUri,
      files: [],
      blocks: sourceBlocks.map((block) => ({
        ...block,
        id: block.id || crypto.randomUUID(),
        mappingStatus: "needs-file",
        selected: false,
        manuallyEdited: false,
      })),
    };
    this.active = session;

    const contextUris = contextItems
      .filter((item) => item.uri && (item.type === "file" || item.type === "selection"))
      .map((item) => vscode.Uri.parse(item.uri as string));
    for (const block of session.blocks) {
      const uri = await this.resolveTarget(block.pathHint) ?? (contextUris.length === 1 ? contextUris[0] : undefined);
      if (!uri) continue;
      const file = await this.ensureFile(session, uri);
      block.fileId = file.id;
      await this.mapFromHints(block, file, contextItems);
    }

    session.activeFileId = session.files[0]?.id;
    await this.saveActive();
    await this.open();
    return await this.getState();
  }

  async createManual(prompt: string, assistantResponse: string, contextItems: ContextItem[]): Promise<ChangeWorkbenchState> {
    return await this.create(prompt, assistantResponse, [{
      id: crypto.randomUUID(),
      description: "수동 변경 블록",
      proposedText: assistantResponse,
      source: "manual",
    }], contextItems);
  }

  async currentState(): Promise<ChangeWorkbenchState | undefined> {
    return this.active ? await this.getState() : undefined;
  }

  async open(): Promise<void> {
    const session = this.requireActive();
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn, false);
    } else {
      const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
      const panel = vscode.window.createWebviewPanel("companyCodeAI.changeWorkbench", "Company Code AI 변경 작업대", column, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      });
      this.panel = panel;
      panel.webview.html = this.panelHtml(panel.webview);
      panel.webview.onDidReceiveMessage((message: PanelMessage) => void this.handlePanelMessage(message), undefined, this.disposables);
      panel.onDidDispose(() => {
        this.panel = undefined;
        this.draftColumn = undefined;
      }, undefined, this.disposables);
    }
    await this.emitState();
    const file = session.files.find((candidate) => candidate.id === session.activeFileId) ?? session.files[0];
    if (file) await this.openDraft(file.id);
  }

  async discard(confirm = true): Promise<void> {
    if (!this.active) return;
    if (confirm) {
      const choice = await vscode.window.showWarningMessage(
        "변경 작업대를 버릴까요? 저장하지 않은 작업 파일은 실제 원본에 반영되지 않습니다.",
        { modal: true },
        "버리기",
      );
      if (choice !== "버리기") return;
    }
    const root = this.active.rootUri;
    this.active = undefined;
    this.panel?.dispose();
    await this.clearActiveState();
    await Promise.resolve(vscode.workspace.fs.delete(root, { recursive: true, useTrash: false })).catch(() => undefined);
    this.stateEmitter.fire(undefined);
  }

  dispose(): void {
    this.panel?.dispose();
    this.stateEmitter.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async handlePanelMessage(message: PanelMessage): Promise<void> {
    try {
      if (message.type === "selectFile" && message.fileId) await this.openDraft(message.fileId);
      else if (message.type === "toggleBlock" && message.blockId) await this.toggleBlock(message.blockId, message.checked === true);
      else if (message.type === "copyBlock" && message.blockId) await this.copyBlock(message.blockId);
      else if (message.type === "chooseTarget" && message.blockId) await this.chooseTarget(message.blockId);
      else if (message.type === "mapSelection" && message.blockId) await this.mapCurrentSelection(message.blockId);
      else if (message.type === "compareFile" && message.fileId) await this.compareFile(message.fileId);
      else if (message.type === "saveFile" && message.fileId) await this.saveFile(message.fileId);
      else if (message.type === "discard") await this.discard();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(text);
      this.post({ type: "error", text });
    } finally {
      if (this.active) await this.emitState();
    }
  }

  private async openDraft(fileId: string): Promise<void> {
    const session = this.requireActive();
    const file = this.requireFile(session, fileId);
    session.activeFileId = file.id;
    const document = await vscode.workspace.openTextDocument(file.draftUri);
    await Promise.resolve(vscode.languages.setTextDocumentLanguage(document, file.languageId)).catch(() => undefined);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: this.draftColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: false,
    });
    this.draftColumn = editor.viewColumn;
    const firstMapped = session.blocks.find((block) =>
      block.fileId === file.id && block.mappingStatus === "mapped" && block.startOffset !== undefined && block.endOffset !== undefined,
    );
    if (firstMapped?.startOffset !== undefined && firstMapped.endOffset !== undefined) {
      const range = new vscode.Range(document.positionAt(firstMapped.startOffset), document.positionAt(firstMapped.endOffset));
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    await this.saveActive();
    await this.emitState();
  }

  private async toggleBlock(blockId: string, checked: boolean): Promise<void> {
    const session = this.requireActive();
    const block = this.requireBlock(session, blockId);
    if (!block.fileId || block.startOffset === undefined || block.endOffset === undefined || block.mappingStatus !== "mapped") {
      throw new Error("먼저 오른쪽 작업 파일에서 이 코드 블록의 대상 범위를 연결하세요.");
    }
    const file = this.requireFile(session, block.fileId);
    if (checked && this.overlapsSelectedBlock(session, block)) {
      throw new Error("이미 선택한 다른 AI 블록과 대상 범위가 겹칩니다. 한 블록만 선택하거나 범위를 다시 연결하세요.");
    }
    if (!checked && block.manuallyEdited) {
      const choice = await vscode.window.showWarningMessage(
        "이 범위에 수동 편집이 있습니다.",
        { modal: true },
        "편집 유지",
        "원문 복원",
      );
      if (choice !== "원문 복원") return;
    }
    const replacement = checked ? block.proposedText : (block.originalText ?? "");
    await this.replaceMappedBlock(file, block, replacement);
    block.selected = checked;
    block.manuallyEdited = false;
    file.saved = false;
    session.message = checked ? "AI 제안을 오른쪽 작업 파일에 반영했습니다." : "오른쪽 작업 파일을 원문으로 복원했습니다.";
    await this.saveActive();
    await this.revealBlock(file, block);
  }

  private async copyBlock(blockId: string): Promise<void> {
    const block = this.requireBlock(this.requireActive(), blockId);
    await vscode.env.clipboard.writeText(block.proposedText);
    this.post({ type: "status", text: "AI 코드 블록을 클립보드에 복사했습니다." });
  }

  private async chooseTarget(blockId: string): Promise<void> {
    const session = this.requireActive();
    const block = this.requireBlock(session, blockId);
    const selected = await vscode.window.showOpenDialog({
      title: "AI 코드 블록의 대상 파일 선택",
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "대상 파일",
    });
    const uri = selected?.[0];
    if (!uri) return;
    if (!vscode.workspace.getWorkspaceFolder(uri)) throw new Error("대상 파일은 현재 워크스페이스 안에 있어야 합니다.");
    const file = await this.ensureFile(session, uri);
    block.fileId = file.id;
    block.mappingStatus = "needs-range";
    block.startOffset = undefined;
    block.endOffset = undefined;
    block.currentText = undefined;
    block.selected = false;
    block.manuallyEdited = false;
    session.activeFileId = file.id;
    session.message = "오른쪽 작업 파일에서 교체할 범위를 선택하고 '선택 범위 연결'을 누르세요.";
    await this.saveActive();
    await this.openDraft(file.id);
  }

  private async mapCurrentSelection(blockId: string): Promise<void> {
    const session = this.requireActive();
    const block = this.requireBlock(session, blockId);
    if (!block.fileId) {
      await this.chooseTarget(blockId);
      return;
    }
    const file = this.requireFile(session, block.fileId);
    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === file.draftUri.toString());
    if (!editor || editor.selection.isEmpty) {
      await this.openDraft(file.id);
      throw new Error("오른쪽 작업 파일에서 교체할 코드 범위를 먼저 선택하세요.");
    }
    block.startOffset = editor.document.offsetAt(editor.selection.start);
    block.endOffset = editor.document.offsetAt(editor.selection.end);
    block.originalText = editor.document.getText(editor.selection);
    block.currentText = block.originalText;
    block.mappingStatus = "mapped";
    block.selected = false;
    block.manuallyEdited = false;
    session.message = "선택한 범위를 AI 코드 블록과 연결했습니다.";
    await this.saveActive();
    await this.revealBlock(file, block);
  }

  private async compareFile(fileId: string): Promise<void> {
    const session = this.requireActive();
    const file = this.requireFile(session, fileId);
    const draft = await vscode.workspace.openTextDocument(file.draftUri);
    if (draft.isDirty && !(await draft.save())) throw new Error("오른쪽 작업 파일을 저장하지 못했습니다.");
    await vscode.commands.executeCommand("vscode.diff", file.baseUri, file.draftUri, `원본 ↔ AI 작업본: ${file.path}`, { preview: false });
  }

  private async saveFile(fileId: string): Promise<PatchApplyOutcome> {
    const session = this.requireActive();
    const file = this.requireFile(session, fileId);
    const draft = await vscode.workspace.openTextDocument(file.draftUri);
    if (draft.isDirty && !(await draft.save())) throw new Error("오른쪽 작업 파일을 저장하지 못했습니다.");
    const finalText = adaptEol(draft.getText(), file.eol);
    if (finalText === file.baseText) {
      session.message = `${file.path}: 저장할 변경이 없습니다.`;
      this.post({ type: "status", text: session.message });
      return { status: "notApplied", message: session.message, targets: [] };
    }
    this.post({ type: "operation", text: `${file.path} 저장 중` });
    const outcome = await this.tools.applyCompletedFiles([{ path: file.path, expectedText: file.baseText, finalText }], "implement");
    if (outcome.status === "applied") {
      file.baseText = finalText;
      file.baseHash = hashText(finalText);
      file.saved = true;
      await vscode.workspace.fs.writeFile(file.baseUri, new TextEncoder().encode(finalText));
      session.message = `${file.path}: 실제 파일 저장과 검증을 완료했습니다.`;
      this.post({ type: "saveResult", ok: true, text: session.message });
      await this.saveActive();
    } else {
      file.saved = false;
      session.message = `${file.path}: ${outcome.message}`;
      this.post({ type: "saveResult", ok: false, text: session.message });
    }
    return outcome;
  }

  private async replaceMappedBlock(file: WorkbenchFile, block: WorkbenchBlock, replacementText: string): Promise<void> {
    if (block.startOffset === undefined || block.endOffset === undefined) throw new Error("코드 블록의 연결 범위가 없습니다.");
    const document = await vscode.workspace.openTextDocument(file.draftUri);
    if (block.endOffset > document.getText().length) {
      block.mappingStatus = "stale";
      throw new Error("작업 파일 편집으로 코드 블록 범위가 유효하지 않습니다. 범위를 다시 연결하세요.");
    }
    const replacement = adaptEol(replacementText, file.eol);
    const oldStart = block.startOffset;
    const oldEnd = block.endOffset;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(file.draftUri, new vscode.Range(document.positionAt(oldStart), document.positionAt(oldEnd)), replacement);
    this.suppressedDrafts.add(file.draftUri.toString());
    try {
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("오른쪽 작업 파일 편집을 VS Code가 거부했습니다.");
      this.adjustMappings(file, oldStart, oldEnd, replacement, block.id, false);
      block.currentText = replacement;
    } finally {
      this.suppressedDrafts.delete(file.draftUri.toString());
    }
  }

  private handleDraftChange(event: vscode.TextDocumentChangeEvent): void {
    const file = this.findFileByDraft(event.document.uri);
    if (!file || !this.active || this.suppressedDrafts.has(event.document.uri.toString())) return;
    const changes = [...event.contentChanges].sort((left, right) => right.rangeOffset - left.rangeOffset);
    for (const change of changes) {
      this.adjustMappings(file, change.rangeOffset, change.rangeOffset + change.rangeLength, change.text, undefined, true);
    }
    file.saved = false;
    this.active.message = `${file.path}: 오른쪽 작업 파일이 편집되었습니다.`;
    void this.saveActive();
    void this.emitState();
  }

  private adjustMappings(file: WorkbenchFile, changeStart: number, changeEnd: number, text: string, targetBlockId: string | undefined, manual: boolean): void {
    if (!this.active) return;
    const delta = text.length - (changeEnd - changeStart);
    for (const block of this.active.blocks.filter((candidate) => candidate.fileId === file.id)) {
      if (block.startOffset === undefined || block.endOffset === undefined) continue;
      if (block.id === targetBlockId) {
        block.startOffset = changeStart;
        block.endOffset = changeStart + text.length;
        block.currentText = text;
        block.mappingStatus = "mapped";
        continue;
      }
      if (changeEnd <= block.startOffset) {
        block.startOffset += delta;
        block.endOffset += delta;
      } else if (changeStart >= block.endOffset) {
        continue;
      } else {
        block.endOffset = Math.max(block.startOffset, block.endOffset + delta);
        block.currentText = undefined;
        block.manuallyEdited = manual;
        if (changeStart < block.startOffset || changeEnd > block.endOffset - delta) block.mappingStatus = "stale";
      }
    }
  }

  private async mapFromHints(block: WorkbenchBlock, file: WorkbenchFile, contextItems: ContextItem[]): Promise<void> {
    const document = await vscode.workspace.openTextDocument(file.originalUri);
    const text = document.getText();
    let start: number | undefined;
    let end: number | undefined;
    if (block.originalText !== undefined) {
      const expected = adaptEol(block.originalText, file.eol);
      const first = text.indexOf(expected);
      if (first >= 0 && text.indexOf(expected, first + Math.max(1, expected.length)) < 0) {
        start = first;
        end = first + expected.length;
      }
    }
    if (start === undefined && block.startLine !== undefined && block.endLine !== undefined && block.endLine <= document.lineCount) {
      const range = new vscode.Range(
        new vscode.Position(block.startLine - 1, 0),
        document.lineAt(block.endLine - 1).rangeIncludingLineBreak.end,
      );
      start = document.offsetAt(range.start);
      end = document.offsetAt(range.end);
    }
    if (start === undefined) {
      const selection = contextItems.find((item) => item.type === "selection" && item.uri === file.originalUri.toString() && item.range);
      if (selection?.range) {
        const range = new vscode.Range(
          selection.range.startLine,
          selection.range.startCharacter,
          selection.range.endLine,
          selection.range.endCharacter,
        );
        start = document.offsetAt(range.start);
        end = document.offsetAt(range.end);
      }
    }
    if (start === undefined || end === undefined) {
      block.mappingStatus = "needs-range";
      return;
    }
    block.startOffset = start;
    block.endOffset = end;
    block.originalText = text.slice(start, end);
    block.currentText = block.originalText;
    block.mappingStatus = "mapped";
  }

  private async ensureFile(session: WorkbenchSession, uri: vscode.Uri): Promise<WorkbenchFile> {
    const existing = session.files.find((file) => file.originalUri.toString() === uri.toString());
    if (existing) return existing;
    if (!vscode.workspace.getWorkspaceFolder(uri)) throw new Error("변경 작업대는 현재 워크스페이스 안의 파일만 사용할 수 있습니다.");
    const document = await vscode.workspace.openTextDocument(uri);
    const baseText = document.getText();
    const index = session.files.length + 1;
    const basename = path.basename(uri.fsPath);
    const extension = path.extname(basename);
    const stem = extension ? basename.slice(0, -extension.length) : basename;
    const draftUri = vscode.Uri.joinPath(session.rootUri, `${index}-${basename}`);
    const baseUri = vscode.Uri.joinPath(session.rootUri, `${index}-${stem}.base${extension}`);
    await vscode.workspace.fs.writeFile(draftUri, new TextEncoder().encode(baseText));
    await vscode.workspace.fs.writeFile(baseUri, new TextEncoder().encode(baseText));
    const file: WorkbenchFile = {
      id: crypto.randomUUID(),
      path: vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1),
      originalUri: uri,
      draftUri,
      baseUri,
      baseText,
      baseHash: hashText(baseText),
      languageId: document.languageId,
      eol: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
      saved: false,
    };
    session.files.push(file);
    return file;
  }

  private async resolveTarget(pathHint: string | undefined): Promise<vscode.Uri | undefined> {
    if (!pathHint) return undefined;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const normalized = pathHint.replace(/\\/g, "/").replace(/^\.\//, "");
    if (path.isAbsolute(pathHint)) {
      const absolute = vscode.Uri.file(pathHint);
      return vscode.workspace.getWorkspaceFolder(absolute) && await exists(absolute) ? absolute : undefined;
    }
    for (const folder of folders) {
      const relative = normalized.startsWith(`${folder.name}/`) ? normalized.slice(folder.name.length + 1) : normalized;
      const candidate = vscode.Uri.joinPath(folder.uri, ...relative.split("/"));
      if (await exists(candidate)) return candidate;
    }
    const basename = path.posix.basename(normalized);
    const matches = await vscode.workspace.findFiles(`**/${basename}`, "**/{.git,node_modules,bin,obj,dist,build}/**", 20);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async revealBlock(file: WorkbenchFile, block: WorkbenchBlock): Promise<void> {
    if (block.startOffset === undefined || block.endOffset === undefined) return;
    const document = await vscode.workspace.openTextDocument(file.draftUri);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: this.draftColumn ?? vscode.ViewColumn.Beside, preview: false });
    this.draftColumn = editor.viewColumn;
    const range = new vscode.Range(document.positionAt(block.startOffset), document.positionAt(block.endOffset));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private overlapsSelectedBlock(session: WorkbenchSession, block: WorkbenchBlock): boolean {
    if (!block.fileId || block.startOffset === undefined || block.endOffset === undefined) return false;
    return session.blocks.some((candidate) =>
      candidate.id !== block.id && candidate.fileId === block.fileId && candidate.selected &&
      candidate.startOffset !== undefined && candidate.endOffset !== undefined &&
      candidate.startOffset < (block.endOffset as number) && (block.startOffset as number) < candidate.endOffset,
    );
  }

  private async getState(): Promise<ChangeWorkbenchState> {
    const session = this.requireActive();
    const files: ChangeWorkbenchFileState[] = [];
    for (const file of session.files) {
      const document = await vscode.workspace.openTextDocument(file.draftUri);
      files.push({
        id: file.id,
        path: file.path,
        draftPath: file.draftUri.fsPath,
        changed: document.getText() !== file.baseText,
        saved: file.saved,
        blockIds: session.blocks.filter((block) => block.fileId === file.id).map((block) => block.id),
      });
    }
    const blocks: ChangeWorkbenchBlockState[] = session.blocks.map((block) => ({
      id: block.id,
      pathHint: block.pathHint,
      languageId: block.languageId,
      description: block.description,
      originalText: block.originalText,
      proposedText: block.proposedText,
      startLine: block.startLine,
      endLine: block.endLine,
      source: block.source,
      fileId: block.fileId,
      mappingStatus: block.mappingStatus,
      mappingLabel: mappingLabel(block, session.files),
      selected: block.selected,
      manuallyEdited: block.manuallyEdited,
    }));
    return { id: session.id, activeFileId: session.activeFileId, message: session.message, files, blocks };
  }

  private async emitState(): Promise<void> {
    if (!this.active) {
      this.stateEmitter.fire(undefined);
      return;
    }
    const state = await this.getState();
    this.stateEmitter.fire(state);
    this.post({ type: "state", state });
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private findFileByDraft(uri: vscode.Uri): WorkbenchFile | undefined {
    return this.active?.files.find((file) => file.draftUri.toString() === uri.toString());
  }

  private requireActive(): WorkbenchSession {
    if (!this.active) throw new Error("진행 중인 변경 작업대가 없습니다.");
    return this.active;
  }

  private requireFile(session: WorkbenchSession, id: string): WorkbenchFile {
    const file = session.files.find((candidate) => candidate.id === id);
    if (!file) throw new Error("변경 작업대의 대상 파일을 찾지 못했습니다.");
    return file;
  }

  private requireBlock(session: WorkbenchSession, id: string): WorkbenchBlock {
    const block = session.blocks.find((candidate) => candidate.id === id);
    if (!block) throw new Error("AI 코드 블록을 찾지 못했습니다.");
    return block;
  }

  private workbenchesRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageRoot, "workbenches");
  }

  private activeStateUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workbenchesRoot(), "active.json");
  }

  private async saveActive(): Promise<void> {
    if (!this.active) return;
    const stored: StoredWorkbench = {
      schemaVersion: 2,
      id: this.active.id,
      prompt: this.active.prompt,
      assistantResponse: this.active.assistantResponse,
      message: this.active.message,
      rootUri: this.active.rootUri.toString(),
      activeFileId: this.active.activeFileId,
      files: this.active.files.map(({ baseText: _baseText, originalUri, draftUri, baseUri, ...file }) => ({
        ...file,
        originalUri: originalUri.toString(),
        draftUri: draftUri.toString(),
        baseUri: baseUri.toString(),
      })),
      blocks: this.active.blocks,
    };
    await vscode.workspace.fs.createDirectory(this.workbenchesRoot());
    await vscode.workspace.fs.writeFile(this.activeStateUri(), new TextEncoder().encode(JSON.stringify(stored, null, 2)));
  }

  private async clearActiveState(): Promise<void> {
    await Promise.resolve(vscode.workspace.fs.delete(this.activeStateUri(), { useTrash: false })).catch(() => undefined);
  }

  private panelHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "changeWorkbench.js"));
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .top { position: sticky; top: 0; z-index: 2; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .row, .tabs, .actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .row { justify-content: space-between; }
    .tabs { margin-top: 8px; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 5px 9px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.active { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
    button:disabled { opacity: .45; cursor: default; }
    #status { opacity: .8; font-size: 12px; }
    main { padding: 10px; }
    .block { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 10px; overflow: hidden; }
    .block-head { display: flex; gap: 8px; align-items: flex-start; padding: 8px; background: var(--vscode-sideBarSectionHeader-background); }
    .block-title { flex: 1; min-width: 0; }
    .description { font-weight: 600; overflow-wrap: anywhere; }
    .meta { margin-top: 3px; opacity: .75; font-size: 12px; overflow-wrap: anywhere; }
    pre { margin: 0; padding: 10px; max-height: 360px; overflow: auto; white-space: pre; tab-size: 4; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .actions { padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
    .empty { padding: 24px 8px; opacity: .8; }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="top">
    <div class="row"><strong>AI 변경 블록</strong><span id="status"></span></div>
    <div class="tabs" id="tabs"></div>
    <div class="actions">
      <button id="compare">변경 비교</button>
      <button class="primary" id="save">이 파일 저장</button>
      <button id="discard">작업대 버리기</button>
    </div>
  </div>
  <main id="blocks"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function mappingLabel(block: WorkbenchBlock, files: WorkbenchFile[]): string {
  const file = files.find((candidate) => candidate.id === block.fileId);
  if (block.mappingStatus === "needs-file") return "대상 파일 필요";
  if (block.mappingStatus === "needs-range") return `${file?.path ?? block.pathHint ?? "대상"}: 범위 선택 필요`;
  if (block.mappingStatus === "stale") return `${file?.path ?? "대상"}: 범위 재연결 필요`;
  return `${file?.path ?? block.pathHint ?? "대상"}: 연결됨${block.manuallyEdited ? " · 수동 편집" : ""}`;
}

function hashText(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function adaptEol(content: string, eol: string): string {
  return content.replace(/\r\n|\r|\n/g, eol);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.File;
  } catch {
    return false;
  }
}

function createNonce(): string {
  return crypto.randomBytes(24).toString("base64url");
}
