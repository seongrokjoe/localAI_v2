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
  "companyCodeAI.model": "internal-model"
}
```

If the server requires a bearer token, run `Company Code AI: Set Auth Token` from the command palette.

## Security Defaults

- The server URL is validated before every request.
- Auth tokens are stored in VS Code SecretStorage.
- The extension does not execute arbitrary shell commands.
- Prompt and source text are not written to extension logs.
- Safe workspace tools are limited to file listing, file reading, text search, Git diff reading, patch proposal, and user-approved patch application.
