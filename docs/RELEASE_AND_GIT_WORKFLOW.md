# Git, PR, Protected `main` & Beta Release Workflow — Hunger Motion

## 1. Branching & PR Rules
- **`main`**: Always deployable to Cloudflare Staging (`hunger-studio-staging`). Never commit directly after initial bootstrap; all changes land via Pull Requests from `feat/*`, `fix/*`, `chore/*`, or `release/*`.
- **Commit convention**: Conventional Commits (`feat:`, `fix:`, `perf:`, `docs:`, `ci:`, `chore:`).
- **PR template & code owners**: Enforced via `.github/PULL_REQUEST_TEMPLATE.md` and `.github/CODEOWNERS`.
- **Local Git hooks** (activated automatically via `git config core.hooksPath .githooks`):
  - `.githooks/pre-commit`: blocks committing `ai_config.json`, `cloud_config.json`, `.env`, keys, or plaintext API tokens.
  - `.githooks/pre-push`: guards against accidental direct pushes to `main` (explicit override `ALLOW_MAIN_PUSH=1` for initial remote bootstrap only).

## 2. Enabling Protected `main` on GitHub (after adding remote)
Once you attach your GitHub repository:

```bash
git remote add origin https://github.com/<ORG>/<REPO>.git
ALLOW_MAIN_PUSH=1 git push -u origin main --tags
```

Apply the branch protection ruleset on `main` using GitHub CLI or API:

```bash
gh api --method PUT repos/<ORG>/<REPO>/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Python, Node, P1 Hardening & CDN Build Gate",
      "Rust WASM Kernels",
      "Headless Chromium Browser & Production Gate"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

## 3. Staging & Production Deployment (Cloudflare Workers + R2 + Supabase)
- **Upload / sync commercial-safe models & MediaPipe WASM to R2 CDN**:
  ```bash
  npm run r2:upload
  ```
- **Deploy Staging (`hunger-studio-staging`)**:
  ```bash
  npm run deploy:staging
  ```
- **Deploy Production (`hunger-studio`)**:
  ```bash
  npm run deploy:prod
  ```
- **Optional Sentry forwarding**:
  Configure `SENTRY_DSN` via Cloudflare Worker secrets (`npx cf deploy -m staging --secrets-file <secrets.json>`); `/api/telemetry/event` automatically forwards fatal & runtime errors in Sentry Envelope v7 format without shipping any third-party SDK to the browser.

## 4. Release Tagging
```bash
git tag -a v0.9.0-beta.1 -m "Hunger Motion Public Beta 1"
git push origin v0.9.0-beta.1
```
Pushing a `v*` tag triggers `.github/workflows/release.yml`.
