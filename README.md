# Company Code AI

VS Code extension for connecting a local workspace to an internal Chat Completions-compatible LLM server.

## Development

```bash
npm install
npm run compile
npm run check:endpoints
```

Run the extension from VS Code with the Extension Development Host.

## Package for a PC without Node.js

Build the VSIX on the development PC:

```bash
npm install
npm run package:vsix
```

Install `release/company-code-ai.vsix` on the target PC from VS Code:

1. Open Extensions.
2. Select `...`.
3. Select `Install from VSIX...`.
4. Choose `company-code-ai.vsix`.

The target PC does not need Node.js or npm for normal extension use.

After installation, configure:

```json
{
  "companyCodeAI.serverUrl": "http://internal-llm-server:8000/v1",
  "companyCodeAI.model": "internal-model",
  "companyCodeAI.maxContextTokens": 200000,
  "companyCodeAI.maxOutputTokens": 60000
}
```

If the server requires a bearer token, run `Company Code AI: Set Auth Token` from the command palette.

## Codex-style workflow

Open the Git repository or solution root in VS Code, then narrow context with `Company Code AI: Set Active Scope` when the repository contains many projects.

Modes:

- `PlanMode`: review, explain, and plan only. File edits are disabled.
- `ImplementMode`: implementation is allowed, but file edits still require an explicit VS Code approval prompt.

Default shortcuts:

- `Ctrl+Alt+P`: switch to PlanMode
- `Ctrl+Alt+I`: switch to ImplementMode
- `Ctrl+Alt+L`: clear context

PlanMode responses include actions for implementing, refining, discarding, remembering, or clearing context. The extension stores session memory and AI-applied change snapshots under `.company-code-ai/` in the workspace.

Use `Company Code AI: Review Last AI Change` to review the last AI-applied before/after snapshot without requiring remote Git access.

## Project Init Summary

For a large solution, run `Company Code AI: Init Project Summary` from the command palette, click `Init` in the sidebar, or type `/init` in the chat input.

The init workflow:

- scans local `.sln` and project files without remote Git access
- summarizes each project in separate internal LLM calls
- reduces those project summaries into a repository-level `SUMMARY.md`
- previews the generated markdown before writing it
- stores intermediate cache files under `.company-code-ai/init/`

Use `/init refresh` or `Company Code AI: Refresh Project Summary` after large structure changes. Use `/summary` or `Company Code AI: Open Project Summary` to reopen the generated file. Normal chat requests automatically include `SUMMARY.md` as reference context when it exists.

## Security Defaults

- The server URL is validated before every request.
- Auth tokens are stored in VS Code SecretStorage.
- The extension does not execute arbitrary shell commands.
- Prompt and source text are not written to extension logs.
- Init cache and change snapshots are stored only inside the opened workspace under `.company-code-ai/`.
- Safe workspace tools are limited to file listing, file reading, text search, Git diff reading, patch proposal, and user-approved patch application.
