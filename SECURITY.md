# Security

## Reporting

Open a private security advisory on this repository (Security → Report a vulnerability). Please do not file public issues for vulnerabilities.

## Design notes

- **Tokens.** `GITHUB_TOKEN` is read from the environment, sent only to `https://api.github.com`, and never logged or written to disk. Use a fine-grained, read-only token. Pagination URLs from GitHub's `Link` header are followed only when they share the API origin, so an upstream-controlled URL cannot redirect the token elsewhere.
- **Bind address.** The server listens on `127.0.0.1` by default. If you expose it, set `API_TOKEN`; every `/api` request then needs `Authorization: Bearer <API_TOKEN>` (compared in constant time).
- **Path parameters** are validated as a plain GitHub `owner/name` before they are interpolated into GitHub API paths, so `..` or an encoded slash cannot reach a different GitHub endpoint.
- **Webhooks** are verified with HMAC-SHA256 over the raw body using WebCrypto `verify`. Delivery ids are de-duplicated. Without `WEBHOOK_SECRET` the endpoint answers 503.
- **Request limits.** JSON bodies are capped at 16 KiB and webhook payloads at 1 MB. The node adapter stops reading at 1.1 MB. A token bucket limits each client address.
- **Dashboard.** It runs under a strict CSP: no inline script or style, no third-party origins. All GitHub-supplied text is HTML-escaped by a tagged template, and links render only when they point to `https://github.com`.
- **Static files.** The server resolves paths inside the web root and serves an allow-list of extensions.
- **Demo data.** `demo/snapshot.json` is recorded by `scripts/record-snapshot.ts`. That script aborts on any private repository and keeps an allow-list of fields, so commit author names and e-mail addresses, issue bodies and avatars are dropped. It also drops issues and PRs authored by third parties. It fails if any e-mail-shaped string remains, and it replays the snapshot offline before writing it.
- **Supply chain.** There are zero runtime dependencies. The two build tools (`typescript`, `esbuild`) are pinned to exact versions. Workflow actions are pinned to commit SHAs, and CI installs with `npm ci --ignore-scripts`.
