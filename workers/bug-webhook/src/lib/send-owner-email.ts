// PIPE-NOTIFY-REFACTOR: shared Resend send helper.
//
// Pure refactor of 4 previously-duplicated send sites in workers/bug-webhook/src/index.ts
// (thank-you email, digest failure alert, FR-160 thank-you, PIPE-NOTIFY owner email).
//
// Behavior contract:
//   - Missing RESEND_API_KEY        -> log + return { ok: false, error: 'no-api-key' } (no throw).
//   - Missing payload.to            -> fall back to env.OWNER_EMAIL.
//   - Missing both                  -> return { ok: false, error: 'no-recipient' }.
//   - 4xx/5xx response              -> return { ok: false, error: '<status>: <truncated-body>' }.
//   - Network/throw inside fetch    -> caught, returns { ok: false, error: '<message>' } (no throw).
//   - Success                       -> { ok: true }.
//
// Default `from` matches the most common existing call site (3 of 4 used this address).
// Callers can override via payload.from to preserve any pre-existing per-site value.

// FROM must be on send.sortinghistory.com (Resend-verified subdomain).
// Root sortinghistory.com SPF only authorizes Cloudflare Email Routing,
// not Resend/SES — sends from <X>@sortinghistory.com SPF-fail and land
// in spam. send.sortinghistory.com SPF includes amazonses.com (Resend's
// underlying provider) and FBL MX is feedback-smtp.us-east-1.amazonses.com.
const DEFAULT_FROM = 'Sorting History <hello@send.sortinghistory.com>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const ERROR_BODY_MAX = 500;

export interface SendOwnerEmailEnv {
  RESEND_API_KEY?: string;
  OWNER_EMAIL?: string;
}

export interface SendOwnerEmailPayload {
  to?: string;
  subject: string;
  html: string;
  from?: string;
  // Optional plain-text fallback. Some mail clients (e.g. text-only modes,
  // accessibility tooling) render this in preference to HTML. Setting both
  // is recommended for player-facing transactional mail.
  text?: string;
}

export interface SendOwnerEmailResult {
  ok: boolean;
  error?: string;
}

export async function sendOwnerEmail(
  env: SendOwnerEmailEnv,
  payload: SendOwnerEmailPayload
): Promise<SendOwnerEmailResult> {
  if (!env.RESEND_API_KEY) {
    console.error('sendOwnerEmail: RESEND_API_KEY not configured');
    return { ok: false, error: 'no-api-key' };
  }

  const recipient = payload.to || env.OWNER_EMAIL;
  if (!recipient) {
    console.error('sendOwnerEmail: no recipient (payload.to and env.OWNER_EMAIL both missing)');
    return { ok: false, error: 'no-recipient' };
  }

  const from = payload.from || DEFAULT_FROM;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: payload.subject,
        html: payload.html,
        ...(payload.text ? { text: payload.text } : {}),
      }),
    });

    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        bodyText = '';
      }
      const truncated = bodyText.length > ERROR_BODY_MAX ? bodyText.slice(0, ERROR_BODY_MAX) : bodyText;
      return { ok: false, error: `${res.status}: ${truncated}` };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
