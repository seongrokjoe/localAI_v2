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
    this.status.text = this.mode === "plan" ? "$(list-tree) Code AI: Plan" : "$(tools) Code AI: Implement";
    this.status.tooltip =
      this.mode === "plan"
        ? "Company Code AI is in PlanMode. File edits are disabled."
        : "Company Code AI is in ImplementMode. File edits require approval.";
  }
}
