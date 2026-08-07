import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { CodeAgent } from "./agent";
import { estimateTokens } from "./context";
import {
  buildProposalDraft,
  ConflictChoice,
  hashProposalText,
  parseProposalConflicts,
  resolveProposalConflict,
  unresolvedProposalConflictCount,
} from "./proposalText";
import { ContextItem, EditRegion, PatchApplyOutcome, ProposalSessionState, RuntimeConfig } from "./types";
import { WorkspaceTools } from "./tools";

interface ProposalFile {
  path: string;
  originalUri: vscode.Uri;
  draftUri: vscode.Uri;
  baseUri: vscode.Uri;
  snapshotUri: vscode.Uri;
  baseText: string;
  baseHash: string;
  languageId: string;
  eol: string;
  regions: EditRegion[];
}

interface ProposalSession {
  id: string;
  prompt: string;
  assistantResponse: string;
  status: ProposalSessionState["status"];
  message: string;
  files: ProposalFile[];
  rootUri: vscode.Uri;
}

interface FilePickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

interface RegionPickItem extends vscode.QuickPickItem {
  selectionKind: "range" | "whole" | "manual";
  range?: vscode.Range;
}

interface StoredSession {
  id: string;
  prompt: string;
  assistantResponse: string;
  status: ProposalSessionState["status"];
  message: string;
  rootUri: string;
  files: Array<{
    path: string;
    originalUri: string;
    draftUri: string;
    baseUri: string;
    snapshotUri: string;
    baseHash: string;
    languageId: string;
    eol: string;
    regions: EditRegion[];
  }>;
}

export class ProposalManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private active?: ProposalSession;
  private readonly stateEmitter = new vscode.EventEmitter<ProposalSessionState | undefined>();
  private readonly contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly codeLensEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidChange = this.contentEmitter.event;
  readonly onDidChangeCodeLenses = this.codeLensEmitter.event;

  constructor(
    private readonly storageRoot: vscode.Uri,
    private readonly agent: CodeAgent,
    private readonly tools: WorkspaceTools,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isActiveDraft(event.document.uri)) {
          if (this.active && this.active.status === "reviewed") {
            this.active.status = "draft";
            this.active.message = "완성본 검토 이후 작업본이 변경되었습니다. diff를 다시 검토하세요.";
          }
          void this.emitState();
          this.codeLensEmitter.fire();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isActiveDraft(document.uri)) {
          void this.emitState();
        }
      }),
    );
  }

  async initialize(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.proposalsRoot());
    try {
      const bytes = await vscode.workspace.fs.readFile(this.activeStateUri());
      const stored = JSON.parse(new TextDecoder().decode(bytes)) as StoredSession;
      const files: ProposalFile[] = [];
      for (const file of stored.files) {
        const baseUri = vscode.Uri.parse(file.baseUri);
        const baseText = new TextDecoder().decode(await vscode.workspace.fs.readFile(baseUri));
        files.push({
          ...file,
          originalUri: vscode.Uri.parse(file.originalUri),
          draftUri: vscode.Uri.parse(file.draftUri),
          baseUri,
          snapshotUri: vscode.Uri.parse(file.snapshotUri),
          baseText,
        });
      }
      this.active = {
        id: stored.id,
        prompt: stored.prompt,
        assistantResponse: stored.assistantResponse,
        status: stored.status,
        message: stored.message,
        rootUri: vscode.Uri.parse(stored.rootUri),
        files,
      };
      await this.emitState();
    } catch {
      this.active = undefined;
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const file = this.active?.files.find((candidate) => candidate.snapshotUri.toString() === uri.toString());
    return file?.baseText ?? "AI 작업본의 원본 스냅샷을 찾지 못했습니다.";
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const file = this.active?.files.find((candidate) => candidate.draftUri.toString() === document.uri.toString());
    if (!file || !this.active) {
      return [];
    }
    return parseProposalConflicts(document.getText()).flatMap((conflict) => {
      const range = new vscode.Range(conflict.startLine, 0, conflict.startLine, 0);
      const args = [this.active?.id, file.draftUri.toString(), conflict.id];
      return [
        new vscode.CodeLens(range, { title: "원본 사용", command: "companyCodeAI.proposalUseOriginal", arguments: args }),
        new vscode.CodeLens(range, { title: "AI 제안 사용", command: "companyCodeAI.proposalUseAI", arguments: args }),
        new vscode.CodeLens(range, { title: "둘 다 사용", command: "companyCodeAI.proposalUseBoth", arguments: args }),
        new vscode.CodeLens(range, { title: "두 내용 비교", command: "companyCodeAI.proposalCompareConflict", arguments: args }),
      ];
    });
  }

  async currentState(): Promise<ProposalSessionState | undefined> {
    return this.active ? await this.getState() : undefined;
  }

  async create(
    prompt: string,
    assistantResponse: string,
    contextItems: ContextItem[],
    config: RuntimeConfig,
    onStatus?: (text: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ProposalSessionState> {
    if (this.active) {
      const choice = await vscode.window.showWarningMessage(
        "진행 중인 AI 작업본을 버리고 새 작업본을 만들까요?",
        { modal: true },
        "새 작업본 만들기",
      );
      if (choice !== "새 작업본 만들기") {
        return await this.getState();
      }
      await this.discard(false);
    }

    const uris = await this.pickTargetFiles(contextItems);
    if (uris.length === 0) {
      throw new Error("AI 작업본을 만들 대상 파일을 선택하지 않았습니다.");
    }

    const id = crypto.randomUUID();
    const rootUri = vscode.Uri.joinPath(this.proposalsRoot(), id);
    await vscode.workspace.fs.createDirectory(rootUri);
    const files: ProposalFile[] = [];
    for (let fileIndex = 0; fileIndex < uris.length; fileIndex++) {
      const uri = uris[fileIndex];
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        throw new Error(`워크스페이스 밖의 파일은 AI 작업본 대상으로 사용할 수 없습니다: ${uri.fsPath}`);
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.isDirty) {
        throw new Error(`${vscode.workspace.asRelativePath(uri)} 파일에 저장되지 않은 변경이 있습니다. 먼저 저장하세요.`);
      }
      const pathLabel = vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
      const ranges = await this.pickRegions(document, contextItems, config.maxOutputTokens);
      if (ranges.length === 0) {
        throw new Error(`${pathLabel}에서 수정 범위를 선택하지 않았습니다.`);
      }
      const baseText = document.getText();
      const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      const regions: EditRegion[] = [];
      for (let regionIndex = 0; regionIndex < ranges.length; regionIndex++) {
        const range = ranges[regionIndex];
        const originalText = document.getText(range);
        const regionId = crypto.randomUUID();
        await onStatus?.(`AI 작업본 생성 중 (${fileIndex + 1}/${uris.length}, ${regionIndex + 1}/${ranges.length})`);
        const generated = await this.agent.generateRegionReplacement(
          prompt,
          assistantResponse,
          pathLabel,
          document.languageId,
          regionId,
          originalText,
          config,
          onStatus,
          signal,
        );
        this.output.appendLine(`[작업본] ${pathLabel} ${range.start.line + 1}-${range.end.line + 1}, 응답 방식: ${generated.source}`);
        regions.push({
          id: regionId,
          path: pathLabel,
          startOffset: document.offsetAt(range.start),
          endOffset: document.offsetAt(range.end),
          originalText,
          replacementText: generated.text,
          originalHash: hashProposalText(originalText),
          label: `${pathLabel}:${range.start.line + 1}-${range.end.line + 1}`,
        });
      }

      const basename = path.basename(uri.fsPath);
      const draftUri = vscode.Uri.joinPath(rootUri, `${fileIndex + 1}-${basename}`);
      const baseUri = vscode.Uri.joinPath(rootUri, `${fileIndex + 1}-${basename}.base`);
      const snapshotUri = vscode.Uri.parse(`company-code-ai-original:/${id}/${fileIndex + 1}/${encodeURIComponent(basename)}`);
      const draft = buildProposalDraft(baseText, regions, eol);
      await vscode.workspace.fs.writeFile(baseUri, new TextEncoder().encode(baseText));
      await vscode.workspace.fs.writeFile(draftUri, new TextEncoder().encode(draft));
      files.push({
        path: pathLabel,
        originalUri: uri,
        draftUri,
        baseUri,
        snapshotUri,
        baseText,
        baseHash: hashProposalText(baseText),
        languageId: document.languageId,
        eol,
        regions,
      });
    }

    this.active = {
      id,
      prompt,
      assistantResponse,
      status: "draft",
      message: "AI 작업본에서 conflict를 해결한 뒤 완성본을 검토하세요.",
      files,
      rootUri,
    };
    await this.saveActive();
    await this.openDraft();
    return await this.getState();
  }

  async resolveConflict(sessionId: string, draftUriText: string, conflictId: string, choice: ConflictChoice): Promise<void> {
    const session = this.requireSession(sessionId);
    const file = session.files.find((candidate) => candidate.draftUri.toString() === draftUriText);
    if (!file) {
      throw new Error("선택한 conflict의 AI 작업본을 찾지 못했습니다.");
    }
    const document = await vscode.workspace.openTextDocument(file.draftUri);
    const next = resolveProposalConflict(document.getText(), conflictId, choice, file.eol);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(file.draftUri, fullDocumentRange(document), next);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("AI 작업본 conflict를 해결하지 못했습니다.");
    }
    await document.save();
    this.codeLensEmitter.fire();
    await this.emitState();
  }

  async compareConflict(sessionId: string, draftUriText: string, conflictId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const file = session.files.find((candidate) => candidate.draftUri.toString() === draftUriText);
    if (!file) {
      throw new Error("비교할 AI 작업본을 찾지 못했습니다.");
    }
    const document = await vscode.workspace.openTextDocument(file.draftUri);
    const conflict = parseProposalConflicts(document.getText()).find((candidate) => candidate.id === conflictId);
    if (!conflict) {
      throw new Error("비교할 conflict가 이미 해결됐거나 존재하지 않습니다.");
    }
    const originalUri = vscode.Uri.joinPath(session.rootUri, `${conflict.id}.original${path.extname(file.draftUri.fsPath)}`);
    const proposalUri = vscode.Uri.joinPath(session.rootUri, `${conflict.id}.ai${path.extname(file.draftUri.fsPath)}`);
    await vscode.workspace.fs.writeFile(originalUri, new TextEncoder().encode(conflict.originalText));
    await vscode.workspace.fs.writeFile(proposalUri, new TextEncoder().encode(conflict.replacementText));
    await vscode.commands.executeCommand("vscode.diff", originalUri, proposalUri, `원본 ↔ AI 제안: ${file.path}`, { preview: false });
  }

  async openDraft(): Promise<void> {
    const session = this.requireActive();
    const file = await this.pickSessionFile(session, "열 AI 작업본 선택");
    if (!file) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(file.draftUri);
    await Promise.resolve(vscode.languages.setTextDocumentLanguage(document, file.languageId)).catch(() => undefined);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async openFinalDiff(): Promise<void> {
    const session = this.requireActive();
    await this.ensureDraftsSaved(session);
    const state = await this.getState();
    if (state.files.some((file) => file.unresolvedConflicts > 0)) {
      throw new Error("해결되지 않은 conflict가 남아 있습니다. 모든 conflict를 해결한 뒤 검토하세요.");
    }
    session.status = "reviewed";
    session.message = "완성본 검토가 준비되었습니다. diff를 확인한 뒤 원본에 저장하세요.";
    const file = await this.pickSessionFile(session, "검토할 완성본 선택");
    if (!file) {
      return;
    }
    this.contentEmitter.fire(file.snapshotUri);
    await vscode.commands.executeCommand("vscode.diff", file.snapshotUri, file.draftUri, `원본 ↔ AI 완성본: ${file.path}`, { preview: false });
    await this.saveActive();
    await this.emitState();
  }

  async apply(): Promise<PatchApplyOutcome> {
    const session = this.requireActive();
    await this.ensureDraftsSaved(session);
    const state = await this.getState();
    if (state.files.some((file) => file.unresolvedConflicts > 0)) {
      throw new Error("해결되지 않은 conflict가 남아 있어 원본에 저장할 수 없습니다.");
    }
    if (session.status !== "reviewed") {
      throw new Error("완성본 diff를 먼저 검토한 뒤 원본에 저장하세요.");
    }
    const approved = await vscode.window.showWarningMessage(
      `완성된 AI 작업본 ${session.files.length}개를 실제 원본 파일에 저장할까요?`,
      { modal: true },
      "원본에 저장",
    );
    if (approved !== "원본에 저장") {
      return { status: "notApplied", message: "사용자가 원본 저장을 취소했습니다.", targets: [] };
    }
    const completed: Array<{ path: string; expectedText: string; finalText: string }> = [];
    for (const file of session.files) {
      const current = await this.tools.readFileExact(file.path);
      if (hashProposalText(current) !== file.baseHash || current !== file.baseText) {
        session.status = "failed";
        session.message = `${file.path} 원본이 작업본 생성 이후 변경되었습니다.`;
        await this.saveActive();
        await this.emitState();
        throw new Error(`${file.path} 원본이 작업본 생성 이후 변경되었습니다. 새 작업본을 만드세요.`);
      }
      const draftDocument = await vscode.workspace.openTextDocument(file.draftUri);
      completed.push({ path: file.path, expectedText: file.baseText, finalText: adaptEol(draftDocument.getText(), file.eol) });
    }
    const outcome = await this.tools.applyCompletedFiles(completed, "implement");
    if (outcome.status === "applied") {
      session.status = "applied";
      session.message = outcome.message;
      await this.clearActiveState();
      this.active = undefined;
      this.stateEmitter.fire(undefined);
    } else {
      session.status = "failed";
      session.message = outcome.message;
      await this.saveActive();
      await this.emitState();
    }
    return outcome;
  }

  async discard(confirm = true): Promise<void> {
    if (!this.active) {
      return;
    }
    if (confirm) {
      const choice = await vscode.window.showWarningMessage("AI 작업본을 버릴까요? 원본 파일은 변경되지 않습니다.", { modal: true }, "버리기");
      if (choice !== "버리기") {
        return;
      }
    }
    const root = this.active.rootUri;
    this.active = undefined;
    await this.clearActiveState();
    await Promise.resolve(vscode.workspace.fs.delete(root, { recursive: true, useTrash: false })).catch(() => undefined);
    this.stateEmitter.fire(undefined);
    this.codeLensEmitter.fire();
  }

  dispose(): void {
    this.stateEmitter.dispose();
    this.contentEmitter.dispose();
    this.codeLensEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async pickTargetFiles(contextItems: ContextItem[]): Promise<vscode.Uri[]> {
    const candidates = new Map<string, vscode.Uri>();
    for (const item of contextItems) {
      if (item.uri && (item.type === "file" || item.type === "selection")) {
        const uri = vscode.Uri.parse(item.uri);
        candidates.set(uri.toString(), uri);
      }
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file" && !this.isActiveDraft(editor.document.uri)) {
      candidates.set(editor.document.uri.toString(), editor.document.uri);
    }
    if (candidates.size === 0) {
      const selected = await vscode.window.showOpenDialog({
        title: "AI 작업본을 만들 파일 선택",
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
      });
      return selected ?? [];
    }
    if (candidates.size === 1) {
      return [...candidates.values()];
    }
    const items: FilePickItem[] = [...candidates.values()].map((uri) => ({
      label: vscode.workspace.asRelativePath(uri),
      description: uri.fsPath,
      uri,
    }));
    const selected = await vscode.window.showQuickPick(items, { title: "AI 작업본 대상 파일 선택", canPickMany: true });
    return selected?.map((item) => item.uri) ?? [];
  }

  private async pickRegions(document: vscode.TextDocument, contextItems: ContextItem[], maxOutputTokens: number): Promise<vscode.Range[]> {
    const items: RegionPickItem[] = [];
    const matchingSelections = contextItems.filter(
      (item) => item.type === "selection" && item.uri === document.uri.toString() && item.range,
    );
    for (const item of matchingSelections) {
      const range = item.range;
      if (range) {
        const exactRange = new vscode.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter);
        if (document.getText(exactRange) !== item.content) {
          continue;
        }
        items.push({
          label: `$(selection) 컨텍스트 선택 영역: ${item.label}`,
          description: "요청 전에 추가한 선택 영역",
          selectionKind: "range",
          range: expandToFullLines(document, exactRange),
        });
      }
    }
    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === document.uri.toString());
    if (editor) {
      for (const selection of editor.selections.filter((candidate) => !candidate.isEmpty)) {
        items.push({
          label: `$(selection) 현재 편집기 선택 영역: ${selection.start.line + 1}-${selection.end.line + 1}`,
          selectionKind: "range",
          range: expandToFullLines(document, selection),
        });
      }
    }
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      "vscode.executeDocumentSymbolProvider",
      document.uri,
    );
    for (const symbol of flattenSymbols(symbols ?? [])) {
      items.push({
        label: `$(symbol-method) ${symbol.name}`,
        description: `${symbol.range.start.line + 1}-${symbol.range.end.line + 1}줄`,
        detail: symbol.container,
        selectionKind: "range",
        range: expandToFullLines(document, symbol.range),
      });
    }
    if (estimateTokens(document.getText()) <= Math.min(Math.floor(maxOutputTokens * 0.7), 40000)) {
      items.push({ label: "$(file) 파일 전체", description: "파일 전체를 AI 제안과 병합합니다.", selectionKind: "whole" });
    }
    items.push({ label: "$(edit) 편집기에서 직접 선택...", description: "파일을 연 뒤 원하는 코드 범위를 직접 선택합니다.", selectionKind: "manual" });

    const selected = await vscode.window.showQuickPick(items, { title: `${vscode.workspace.asRelativePath(document.uri)} 수정 범위 선택`, canPickMany: true });
    if (!selected || selected.length === 0) {
      return [];
    }
    if (selected.some((item) => item.selectionKind === "whole")) {
      return [new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length))];
    }
    const ranges = selected.filter((item) => item.selectionKind === "range" && item.range).map((item) => item.range as vscode.Range);
    if (selected.some((item) => item.selectionKind === "manual")) {
      const manual = await this.pickManualRanges(document);
      ranges.push(...manual);
    }
    const unique = uniqueRanges(ranges).sort((left, right) => left.start.compareTo(right.start));
    for (let index = 1; index < unique.length; index++) {
      if (unique[index - 1].end.isAfter(unique[index].start)) {
        throw new Error("선택한 수정 범위가 서로 겹칩니다. 겹치지 않는 범위를 선택하세요.");
      }
    }
    const maxRegionTokens = Math.min(Math.floor(maxOutputTokens * 0.7), 40000);
    const oversized = unique.find((range) => estimateTokens(document.getText(range)) > maxRegionTokens);
    if (oversized) {
      throw new Error(`선택한 범위가 ${maxRegionTokens.toLocaleString()} 출력 토큰 예산을 초과합니다. 더 작은 함수나 코드 영역을 선택하세요.`);
    }
    return unique;
  }

  private async pickManualRanges(document: vscode.TextDocument): Promise<vscode.Range[]> {
    const shown = await vscode.window.showTextDocument(document, { preview: false });
    const choice = await vscode.window.showInformationMessage(
      "편집기에서 AI가 교체할 코드 범위를 선택한 뒤 '선택 완료'를 누르세요. 여러 선택 영역도 사용할 수 있습니다.",
      "선택 완료",
      "취소",
    );
    if (choice !== "선택 완료") {
      return [];
    }
    const ranges = shown.selections.filter((selection) => !selection.isEmpty).map((selection) => expandToFullLines(document, selection));
    if (ranges.length === 0) {
      throw new Error("편집기에서 선택한 코드 범위가 없습니다.");
    }
    return ranges;
  }

  private async getState(): Promise<ProposalSessionState> {
    const session = this.requireActive();
    const files = [];
    let total = 0;
    for (const file of session.files) {
      const document = await vscode.workspace.openTextDocument(file.draftUri);
      const unresolvedConflicts = unresolvedProposalConflictCount(document.getText());
      total += unresolvedConflicts;
      files.push({
        path: file.path,
        absolutePath: file.originalUri.fsPath,
        draftPath: file.draftUri.fsPath,
        baseHash: file.baseHash,
        unresolvedConflicts,
      });
    }
    if (session.status !== "failed") {
      if (total > 0) {
        session.status = "draft";
      } else if (session.status !== "reviewed") {
        session.status = "ready";
      }
      session.message =
        total === 0
          ? session.status === "reviewed"
            ? "완성본 diff가 열렸습니다. 확인을 마쳤으면 원본에 저장하세요."
            : "모든 conflict가 해결되었습니다. 완성본 diff를 검토한 뒤 원본에 저장하세요."
          : `AI 작업본에 해결되지 않은 conflict가 ${total}개 남아 있습니다.`;
    }
    return { id: session.id, status: session.status, files, message: session.message };
  }

  private async emitState(): Promise<void> {
    if (!this.active) {
      this.stateEmitter.fire(undefined);
      return;
    }
    this.stateEmitter.fire(await this.getState());
  }

  private async ensureDraftsSaved(session: ProposalSession): Promise<void> {
    for (const file of session.files) {
      const document = await vscode.workspace.openTextDocument(file.draftUri);
      if (document.isDirty && !(await document.save())) {
        throw new Error(`${file.path} AI 작업본을 저장하지 못했습니다.`);
      }
    }
  }

  private async pickSessionFile(session: ProposalSession, title: string): Promise<ProposalFile | undefined> {
    if (session.files.length === 1) {
      return session.files[0];
    }
    const items = session.files.map((file) => ({ label: file.path, file }));
    return (await vscode.window.showQuickPick(items, { title }))?.file;
  }

  private requireActive(): ProposalSession {
    if (!this.active) {
      throw new Error("진행 중인 AI 작업본이 없습니다.");
    }
    return this.active;
  }

  private requireSession(id: string): ProposalSession {
    const session = this.requireActive();
    if (session.id !== id) {
      throw new Error("AI 작업본 세션이 변경되었습니다.");
    }
    return session;
  }

  private isActiveDraft(uri: vscode.Uri): boolean {
    return Boolean(this.active?.files.some((file) => file.draftUri.toString() === uri.toString()));
  }

  private proposalsRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageRoot, "proposals");
  }

  private activeStateUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.proposalsRoot(), "active.json");
  }

  private async saveActive(): Promise<void> {
    if (!this.active) {
      return;
    }
    const stored: StoredSession = {
      id: this.active.id,
      prompt: this.active.prompt,
      assistantResponse: this.active.assistantResponse,
      status: this.active.status,
      message: this.active.message,
      rootUri: this.active.rootUri.toString(),
      files: this.active.files.map((file) => ({
        path: file.path,
        originalUri: file.originalUri.toString(),
        draftUri: file.draftUri.toString(),
        baseUri: file.baseUri.toString(),
        snapshotUri: file.snapshotUri.toString(),
        baseHash: file.baseHash,
        languageId: file.languageId,
        eol: file.eol,
        regions: file.regions,
      })),
    };
    await vscode.workspace.fs.createDirectory(this.proposalsRoot());
    await vscode.workspace.fs.writeFile(this.activeStateUri(), new TextEncoder().encode(JSON.stringify(stored, null, 2)));
  }

  private async clearActiveState(): Promise<void> {
    await Promise.resolve(vscode.workspace.fs.delete(this.activeStateUri(), { useTrash: false })).catch(() => undefined);
  }
}

function flattenSymbols(symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): Array<{ name: string; container: string; range: vscode.Range }> {
  const flattened: Array<{ name: string; container: string; range: vscode.Range }> = [];
  const visit = (symbol: vscode.DocumentSymbol, container: string): void => {
    flattened.push({ name: symbol.name, container, range: symbol.range });
    for (const child of symbol.children) {
      visit(child, container ? `${container} / ${symbol.name}` : symbol.name);
    }
  };
  for (const symbol of symbols) {
    if ("location" in symbol) {
      flattened.push({ name: symbol.name, container: symbol.containerName, range: symbol.location.range });
    } else {
      visit(symbol, "");
    }
  }
  return flattened.slice(0, 1000);
}

function expandToFullLines(document: vscode.TextDocument, range: vscode.Range): vscode.Range {
  const start = new vscode.Position(range.start.line, 0);
  const endLine = Math.min(range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line, document.lineCount - 1);
  const end = document.lineAt(endLine).rangeIncludingLineBreak.end;
  return new vscode.Range(start, end);
}

function uniqueRanges(ranges: vscode.Range[]): vscode.Range[] {
  const values = new Map<string, vscode.Range>();
  for (const range of ranges) {
    values.set(`${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`, range);
  }
  return [...values.values()];
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
}

function adaptEol(content: string, eol: string): string {
  return content.replace(/\r\n|\r|\n/g, eol);
}
