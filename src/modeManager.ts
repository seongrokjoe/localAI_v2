import * as vscode from "vscode";
import { AgentMode } from "./types";

const modeKey = "companyCodeAI.mode";

export class ModeManager implements vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<AgentMode>();
  private readonly status: vscode.StatusBarItem;
  private mode: AgentMode;

  readonly onDidChange = this.changedEmitter.event;

  constructor(private readonly storage: vscode.Memento) {
    this.mode = storage.get<AgentMode>(modeKey, "plan");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = "companyCodeAI.toggleMode";
    this.updateStatus();
    this.status.show();
  }

  get current(): AgentMode {
    return this.mode;
  }

  async set(mode: AgentMode): Promise<void> {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    await this.storage.update(modeKey, mode);
    this.updateStatus();
    this.changedEmitter.fire(mode);
  }

  async toggle(): Promise<void> {
    await this.set(this.mode === "plan" ? "implement" : "plan");
  }

  dispose(): void {
    this.changedEmitter.dispose();
    this.status.dispose();
  }

  private updateStatus(): void {
    this.status.text = this.mode === "plan" ? "$(list-tree) Code AI: 계획" : "$(tools) Code AI: 구현";
    this.status.tooltip =
      this.mode === "plan"
        ? "Company Code AI는 PlanMode입니다. 파일 수정은 비활성화됩니다."
        : "Company Code AI는 ImplementMode입니다. 파일 수정에는 승인이 필요합니다.";
  }
}
