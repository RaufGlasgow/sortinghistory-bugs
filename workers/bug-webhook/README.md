# Bug Webhook - Cloudflare Worker

Receives bug reports from the Sorting History iOS app and creates GitHub Issues.

## Features

- Input validation (description 10-5000 chars)
- HTML/XSS sanitization
- Device info formatting
- Screenshot support (base64)
- GitHub Issue creation with labels
- Retry logic (3x exponential backoff)
- Always returns success to app (graceful degradation)

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.dev.vars` with your GitHub token:
   ```bash
   echo "GITHUB_TOKEN=$(gh auth token)" > .dev.vars
   ```

3. Start local server:
   ```bash
   npm run dev
   ```

4. Test:
   ```bash
   curl -X POST http://localhost:8787 \
     -H "Content-Type: application/json" \
     -d '{
       "description": "Test bug report",
       "category": "Testing",
       "deviceInfo": {
         "model": "iPhone 16 Pro",
         "osVersion": "18.3.1",
         "appVersion": "1.1.0"
       }
     }'
   ```

## Deployment

1. Login to Cloudflare:
   ```bash
   npx wrangler login
   ```

2. Set the GitHub token secret:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

4. (Optional) Configure custom domain in `wrangler.toml`

## API

### POST /

Submit a bug report.

**Request Body:**
```json
{
  "description": "string (required, 10-5000 chars)",
  "category": "string (optional)",
  "screenshot": "string (optional, base64)",
  "email": "string (optional)",
  "deviceInfo": {
    "model": "string",
    "osVersion": "string",
    "appVersion": "string",
    "buildNumber": "string",
    "currentScreen": "string",
    "locale": "string",
    "networkStatus": "string",
    "availableMemoryMB": "number"
  }
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "confirmation_id": "BUG-XXXXXX-YYYY",
  "issue_number": 123,
  "issue_url": "https://github.com/...",
  "message": "Bug report submitted successfully"
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Validation failed",
  "details": [
    {"field": "description", "message": "Description must be at least 10 characters"}
  ]
}
```

## Label Mutation Routes (BUG-PIPE-007)

Three GET-only routes that mutate GitHub issue labels. Intended to be linked from
digest emails so Ra'uf can approve/flag/ignore bugs with a single click.

All three routes require `?issue=N&token=AUTH_TOKEN` query parameters.

| Route | Label added | Extra action | Success message |
|-------|-------------|--------------|-----------------|
| `GET /label/fix` | `approved-for-fix` | — | "Bug #N approved for fix. Run /bug-pipeline in Claude Code to process the queue." |
| `GET /label/needs-info` | `needs-info` | — | "Bug #N flagged for more info." |
| `GET /label/ignore` | `wontfix` | Closes issue as `not_planned` | "Bug #N closed as wontfix." |

**Validation:**
- `token` must match `AUTH_TOKEN` env var — mismatch returns 401 HTML
- `issue` must be a plain positive integer (`/^\d+$/`, `Number.isSafeInteger`, `> 0`) — invalid returns 400 HTML
- Non-GET methods return 405 HTML

**Security headers on every response:** `Referrer-Policy: no-referrer`, `Cache-Control: no-store`

**PAT / AUTH_TOKEN:** never echoed in response body or log lines.

**Smoke test:**
```bash
SMOKE_ISSUE=<issue-number> AUTH_TOKEN=<token> bash workers/bug-webhook/scripts/smoke.sh
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | Fine-grained PAT with `issues:write` | Yes (secret) |
| `GITHUB_REPO` | Repository in `owner/repo` format | Yes (wrangler.toml) |
| `AUTH_TOKEN` | Token for pipeline email action links | Yes (secret) |
