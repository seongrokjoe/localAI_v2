# Company Code AI

VS Code extension for connecting a local workspace to an internal Chat Completions-compatible LLM server.

## Development

```bash
npm install
npm run compile
npm run check:endpoints
```

Run the extension from VS Code with the Extension Development Host.

## Security Defaults

- The server URL is validated before every request.
- Auth tokens are stored in VS Code SecretStorage.
- The extension does not execute arbitrary shell commands.
- Prompt and source text are not written to extension logs.
- Safe workspace tools are limited to file listing, file reading, text search, Git diff reading, patch proposal, and user-approved patch application.
