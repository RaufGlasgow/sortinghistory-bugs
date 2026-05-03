/**
 * BBE-001 — Bug Bounty Reward Email Automation
 *
 * Extends the existing bug-webhook Cloudflare Worker to automatically send a
 * 2-month Historian reward code to validated bug reporters when their issue
 * is labeled `approved-for-fix` (or the legacy `approved` label on this
 * integration branch).
 *
 * Decisions (closed 2026-04-24):
 *   D1 Inventory store: Cloudflare D1, table `bug_bounty_codes`
 *   D2 Trigger: `approved-for-fix` label (legacy `approved` also supported)
 *   D3 Eligibility: default-on, `no-reward` label opts out
 *   D4 Copy: no stacking claim in v1
 *   D5 Ownership: PM end-to-end
 *
 * Story: docs/stories/BBE-001-bug-bounty-email-automation.story.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cloudflare D1 row for the bug_bounty_codes table. */
export interface BountyCodeRow {
  code: string;
  status: 'available' | 'reserved' | 'used';
  reserved_at: number | null;
  sent_at: number | null;
  recipient_email: string | null;
  bug_report_id: string | null;
  expiration_date: number | null;
  invalidated_at: number | null;
}

/** Minimal shape of a Cloudflare D1 database binding. */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1Result<T>[]>;
  exec?(query: string): Promise<unknown>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success?: boolean;
  meta?: {
    changes?: number;
    last_row_id?: number;
    rows_written?: number;
    rows_read?: number;
  };
}

export interface BBEEnv {
  BBE_DB: D1DatabaseLike;                     // D1 database binding
  BBE_CSV?: string;                           // Raw CSV contents (wrangler secret put)
  BBE_ADMIN_TOKEN?: string;                   // Bearer token for manual override endpoints
  RESEND_API_KEY: string;                     // Existing Resend key (reused)
  GITHUB_TOKEN?: string;                      // For fetching issue body/email
  GITHUB_REPO?: string;                       // "RaufGlasgow/Sorting-History"
  BBE_ALERT_EMAIL?: string;                   // Ra'uf's email for alerts + digest
  BBE_BATCH_ID?: string;                      // e.g. "bug-bounty-batch-496572"
  BBE_BATCH_EXPIRATION?: string;              // ISO date, e.g. "2026-10-24"
  BBE_REDEEM_BASE?: string;                   // Defaults to the Historian offer URL
  BBE_LOW_INVENTORY_THRESHOLD?: string;       // Defaults to "100"
  BBE_EXPIRATION_WARN_DAYS?: string;          // Defaults to "30"
}

export type EmailLocale = 'en' | 'de' | 'pt' | 'nl' | 'es';

export interface AuditRow {
  code: string;
  recipient_email: string;
  bug_report_id: string;
  sent_at: number;
  expiration_date: number;
}

// ---------------------------------------------------------------------------
// Schema + one-shot importer
// ---------------------------------------------------------------------------

/**
 * D1 schema for the BBE inventory table.
 *
 * `code` is the PRIMARY KEY and has an implicit UNIQUE index, which is what
 * guarantees the atomic-claim semantics: the UPDATE that reserves a code
 * can only succeed on a row where status='available', and two concurrent
 * writers can never both see that row in 'available' because D1 serializes
 * writes against the same row.
 */
export const BBE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bug_bounty_codes (
  code              TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'used', 'invalidated')),
  reserved_at       INTEGER,
  sent_at           INTEGER,
  recipient_email   TEXT,
  bug_report_id     TEXT,
  expiration_date   INTEGER,
  invalidated_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bbc_status ON bug_bounty_codes(status);
CREATE INDEX IF NOT EXISTS idx_bbc_bug_report ON bug_bounty_codes(bug_report_id);

CREATE TABLE IF NOT EXISTS bug_bounty_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  event             TEXT NOT NULL,
  code              TEXT,
  recipient_email   TEXT,
  bug_report_id     TEXT,
  detail            TEXT
);

CREATE INDEX IF NOT EXISTS idx_bba_ts ON bug_bounty_audit(ts);
CREATE INDEX IF NOT EXISTS idx_bba_bug_report ON bug_bounty_audit(bug_report_id);

CREATE TABLE IF NOT EXISTS bug_bounty_meta (
  key               TEXT PRIMARY KEY,
  value             TEXT
);
`;

/**
 * Parse the bug-bounty CSV. Expected format (no header):
 *   CODE,REDEEM_URL
 * Example (code shown is synthetic; real codes live only in .private/):
 *   SAMPLEFAKECODE0001,https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=SAMPLEFAKECODE0001
 *
 * Returns a deduplicated, trimmed list of codes.
 */
export function parseCsvCodes(csv: string): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const lines = csv.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip any header row like "code,redeem_url"
    if (/^code\b/i.test(line)) continue;
    const firstComma = line.indexOf(',');
    const code = (firstComma === -1 ? line : line.slice(0, firstComma)).trim();
    if (!code) continue;
    // Codes must be alphanumeric (Apple offer codes are upper-case alnum); reject garbage
    if (!/^[A-Z0-9]{8,32}$/i.test(code)) continue;
    const upper = code.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    out.push(upper);
  }
  return out;
}

/**
 * Initialize the schema and import the CSV if and only if the inventory
 * table is empty. Idempotent: a second run is a no-op.
 *
 * Returns the number of rows imported (0 if table already populated).
 */
export async function initSchemaAndImport(env: BBEEnv): Promise<number> {
  const count = await env.BBE_DB
    .prepare('SELECT COUNT(*) AS n FROM bug_bounty_codes')
    .first<{ n: number }>();
  if (count && count.n > 0) return 0;

  if (!env.BBE_CSV) return 0;
  const codes = parseCsvCodes(env.BBE_CSV);
  if (codes.length === 0) return 0;

  const expirationMs = env.BBE_BATCH_EXPIRATION
    ? Date.parse(env.BBE_BATCH_EXPIRATION)
    : null;
  const exp = Number.isFinite(expirationMs as number) ? (expirationMs as number) : null;

  // D1 prepared-statement batch is the right primitive here. Some runtimes
  // (tests) may not implement `batch`; fall back to sequential inserts.
  const stmts: D1PreparedStatementLike[] = codes.map((code) =>
    env.BBE_DB
      .prepare(`INSERT OR IGNORE INTO bug_bounty_codes
        (code, status, reserved_at, sent_at, recipient_email, bug_report_id, expiration_date, invalidated_at)
        VALUES (?, 'available', NULL, NULL, NULL, NULL, ?, NULL)`)
      .bind(code, exp)
  );

  if (typeof env.BBE_DB.batch === 'function') {
    await env.BBE_DB.batch(stmts);
  } else {
    for (const stmt of stmts) {
      await stmt.run();
    }
  }

  await writeAudit(env, {
    event: 'csv_import',
    detail: `imported ${codes.length} codes from BBE_CSV`,
  });

  return codes.length;
}

async function execMulti(db: D1DatabaseLike, sql: string): Promise<void> {
  // D1 `exec()` accepts a multi-statement string. When unavailable (tests),
  // split on `;` and run each statement via prepare().run().
  if (typeof db.exec === 'function') {
    await db.exec(sql);
    return;
  }
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

// ---------------------------------------------------------------------------
// Atomic claim
// ---------------------------------------------------------------------------

/**
 * Reserve an available code for a given bug_report_id + recipient_email.
 *
 * Two-phase operation:
 *   1) Pick a candidate code (SELECT ... WHERE status='available' LIMIT 1)
 *   2) Atomically transition it to 'reserved' via UPDATE with both the code
 *      primary key AND a status='available' predicate. The UPDATE affects
 *      0 rows if another writer claimed the code between step 1 and step 2.
 *
 * On meta.changes === 0 we retry with a new candidate (capped at 8 tries).
 *
 * Returns the reserved code, or null if no available codes remain.
 */
export async function claimCode(
  env: BBEEnv,
  bugReportId: string,
  recipientEmail: string
): Promise<string | null> {
  // Duplicate-protection (AC12): if a code has already been USED for this
  // bug_report_id, do not reserve a second one.
  const existing = await env.BBE_DB
    .prepare(`SELECT code FROM bug_bounty_codes
              WHERE bug_report_id = ? AND status IN ('reserved', 'used')
              LIMIT 1`)
    .bind(bugReportId)
    .first<{ code: string }>();
  if (existing && existing.code) {
    return null; // Already claimed; caller logs as duplicate and returns.
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = await env.BBE_DB
      .prepare(`SELECT code FROM bug_bounty_codes
                WHERE status = 'available'
                ORDER BY rowid
                LIMIT 1`)
      .first<{ code: string }>();
    if (!candidate || !candidate.code) return null;

    const now = Date.now();
    const res = await env.BBE_DB
      .prepare(`UPDATE bug_bounty_codes
                SET status = 'reserved',
                    reserved_at = ?,
                    recipient_email = ?,
                    bug_report_id = ?
                WHERE code = ?
                  AND status = 'available'
                  AND NOT EXISTS (
                    SELECT 1 FROM bug_bounty_codes
                    WHERE bug_report_id = ? AND status IN ('reserved', 'used')
                  )`)
      .bind(now, recipientEmail, bugReportId, candidate.code, bugReportId)
      .run();

    const changes = res?.meta?.changes ?? 0;
    if (changes >= 1) {
      await writeAudit(env, {
        event: 'code_reserved',
        code: candidate.code,
        recipient_email: recipientEmail,
        bug_report_id: bugReportId,
      });
      return candidate.code;
    }
    // Race lost. If the same bug claimed a different code concurrently, stop
    // so the caller can treat this as a duplicate instead of burning another.
    const duplicate = await env.BBE_DB
      .prepare(`SELECT code FROM bug_bounty_codes
                WHERE bug_report_id = ? AND status IN ('reserved', 'used')
                LIMIT 1`)
      .bind(bugReportId)
      .first<{ code: string }>();
    if (duplicate && duplicate.code) {
      return null;
    }
    // Otherwise another writer claimed this candidate. Try again.
  }
  return null;
}

/** Mark a reserved code as `used` and append an audit row. */
export async function markUsed(env: BBEEnv, code: string): Promise<void> {
  const now = Date.now();
  await env.BBE_DB
    .prepare(`UPDATE bug_bounty_codes
              SET status = 'used', sent_at = ?
              WHERE code = ? AND status = 'reserved'`)
    .bind(now, code)
    .run();
  await writeAudit(env, {
    event: 'code_sent',
    code,
  });
}

/**
 * Release a code back to 'available' if the email delivery failed between
 * reservation and send. Keeps inventory consistent.
 */
export async function releaseCode(env: BBEEnv, code: string, reason: string): Promise<void> {
  await env.BBE_DB
    .prepare(`UPDATE bug_bounty_codes
              SET status = 'available',
                  reserved_at = NULL,
                  recipient_email = NULL,
                  bug_report_id = NULL
              WHERE code = ? AND status = 'reserved'`)
    .bind(code)
    .run();
  await writeAudit(env, {
    event: 'code_released',
    code,
    detail: reason,
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function writeAudit(
  env: BBEEnv,
  row: {
    event: string;
    code?: string;
    recipient_email?: string;
    bug_report_id?: string;
    detail?: string;
  }
): Promise<void> {
  const now = Date.now();
  await env.BBE_DB
    .prepare(`INSERT INTO bug_bounty_audit
              (ts, event, code, recipient_email, bug_report_id, detail)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      now,
      row.event,
      row.code ?? null,
      row.recipient_email ?? null,
      row.bug_report_id ?? null,
      row.detail ?? null
    )
    .run();
}

// ---------------------------------------------------------------------------
// Email template (5 locales, no stacking claim per D4)
// ---------------------------------------------------------------------------

export interface RewardEmailInputs {
  code: string;
  redeemUrl: string;
  issueNumber: number;
  expirationISO: string;        // Human-readable expiration date (YYYY-MM-DD)
  locale: EmailLocale;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function detectLocale(langOrLocale: string | undefined | null): EmailLocale {
  const v = (langOrLocale || '').toLowerCase();
  if (v.startsWith('de')) return 'de';
  if (v.startsWith('pt')) return 'pt';
  if (v.startsWith('nl')) return 'nl';
  if (v.startsWith('es')) return 'es';
  return 'en';
}

/**
 * Render the reward email in one of 5 locales. Copy intentionally makes NO
 * claim about stacking behavior for existing Historian subscribers (D4).
 */
export function renderRewardEmail(inputs: RewardEmailInputs): RenderedEmail {
  const { code, redeemUrl, issueNumber, expirationISO, locale } = inputs;

  // BUG-229 mitigation (2026-04-25): every email MUST include install
  // instructions BEFORE the redemption link. Source of truth (verbatim):
  // SortingHistory-mkt/docs/marketing/OfferCode-Distribution-Walkthrough-20260425.md
  // Section 2.1 "Required text block (English)".
  // BBE-001-v4 v2 (2026-04-26): de/pt/nl/es translations applied per
  // docs/marketing/handoffs/Mara-BBE-001-v4-Install-Instructions-20260426-v2.md.
  // Tier name "Historian" is locale-mapped to match LocalizationHelper.swift:
  //   de -> Historiker (line 3308), pt -> Historiador (line 4642),
  //   nl -> Historicus (line 5977), es -> Historiador (line 2141, reversed 2026-04-26).
  const installHeadingEN = 'Before redeeming this code:';
  const installStepsEN: string[] = [
    'Install Sorting History from the App Store first. Search "Sorting History" in the App Store on your iPhone or iPad, or use this link: https://apps.apple.com/app/id6760428599. Tap Get / Install / Update.',
    'If you currently have Sorting History installed via TestFlight, you must ALSO install the App Store version. They are separate builds and your subscription only activates in the App Store version. The App Store install will replace or coexist with the TestFlight install.',
    'Then redeem the code. Open the App Store app -> tap your profile photo (top right) -> tap Redeem Gift Card or Code -> enter the code below. Alternatively, tap the redemption link included in this message.',
    'Open Sorting History (the App Store version, not TestFlight) and wait up to 60 seconds for your Historian subscription to appear. You can confirm it under Settings -> Subscription inside the app.',
    'If your subscription does not activate within 60 seconds: force-quit Sorting History (swipe up from the home indicator and flick the app card up) and reopen it. Then check Settings -> Subscription again.',
    'If after 5 minutes you still do not see Historian access: email hello@sortinghistory.com with your Apple ID email and the date you redeemed. Do NOT redeem the code a second time - it is a one-time code and will fail.',
  ];

  const installHeadingDE = 'Bevor du diesen Code einlöst:';
  const installStepsDE: string[] = [
    'Installiere Sorting History zuerst aus dem App Store. Suche "Sorting History" im App Store auf deinem iPhone oder iPad, oder nutze diesen Link: https://apps.apple.com/app/id6760428599. Tippe auf Laden / Installieren / Aktualisieren.',
    'Falls du Sorting History aktuell über TestFlight installiert hast, musst du AUSSERDEM die App-Store-Version installieren. Es sind getrennte Builds, und dein Abonnement wird nur in der App-Store-Version aktiviert. Die App-Store-Installation ersetzt die TestFlight-Installation oder existiert parallel dazu.',
    'Löse danach den Code ein. Öffne die App-Store-App -> tippe auf dein Profilbild (oben rechts) -> tippe auf Geschenkkarte oder Code einlösen -> gib den unten stehenden Code ein. Alternativ kannst du den Einlöse-Link in dieser Nachricht antippen.',
    'Öffne Sorting History (die App-Store-Version, nicht TestFlight) und warte bis zu 60 Sekunden, bis dein Historiker-Abonnement erscheint. Du kannst dies in der App unter Einstellungen -> Abonnement bestätigen.',
    'Falls dein Abonnement nicht innerhalb von 60 Sekunden aktiviert wird: Beende Sorting History vollständig (vom Home-Indikator nach oben wischen und die App-Karte nach oben wegschieben) und öffne die App erneut. Prüfe dann erneut Einstellungen -> Abonnement.',
    'Falls du nach 5 Minuten immer noch keinen Historiker-Zugang siehst: Schreibe eine E-Mail an hello@sortinghistory.com mit deiner Apple-ID-E-Mail und dem Datum der Einlösung. Löse den Code NICHT ein zweites Mal ein - es ist ein Einmal-Code und schlägt fehl.',
  ];

  const installHeadingPT = 'Antes de resgatar este código:';
  const installStepsPT: string[] = [
    'Instala primeiro o Sorting History a partir da App Store. Procura "Sorting History" na App Store no teu iPhone ou iPad, ou usa este link: https://apps.apple.com/app/id6760428599. Toca em Obter / Instalar / Atualizar.',
    'Se tens o Sorting History instalado atualmente via TestFlight, tens TAMBÉM de instalar a versão da App Store. São builds separadas e a tua subscrição só é ativada na versão da App Store. A instalação da App Store substitui a instalação do TestFlight ou coexiste com ela.',
    'Depois resgata o código. Abre a app App Store -> toca na tua foto de perfil (canto superior direito) -> toca em Resgatar cartão-presente ou código -> introduz o código em baixo. Em alternativa, toca no link de resgate incluído nesta mensagem.',
    'Abre o Sorting History (a versão da App Store, não a do TestFlight) e aguarda até 60 segundos para que a tua subscrição Historiador apareça. Podes confirmar em Definições -> Subscrição dentro da app.',
    'Se a tua subscrição não for ativada em 60 segundos: força o encerramento do Sorting History (desliza para cima a partir do indicador de início e empurra o cartão da app para cima) e reabre. Depois verifica novamente Definições -> Subscrição.',
    'Se ao fim de 5 minutos ainda não vires acesso Historiador: envia um e-mail para hello@sortinghistory.com com o e-mail da tua Apple ID e a data em que resgataste. NÃO resgates o código uma segunda vez - é um código de utilização única e irá falhar.',
  ];

  const installHeadingNL = 'Voordat je deze code inwisselt:';
  const installStepsNL: string[] = [
    'Installeer Sorting History eerst vanuit de App Store. Zoek "Sorting History" in de App Store op je iPhone of iPad, of gebruik deze link: https://apps.apple.com/app/id6760428599. Tik op Download / Installeer / Werk bij.',
    'Als je Sorting History momenteel via TestFlight hebt geïnstalleerd, moet je OOK de App Store-versie installeren. Het zijn aparte builds en je abonnement wordt alleen geactiveerd in de App Store-versie. De App Store-installatie vervangt de TestFlight-installatie of bestaat ernaast.',
    'Wissel daarna de code in. Open de App Store-app -> tik op je profielfoto (rechtsboven) -> tik op Cadeaubon of code inwisselen -> voer de onderstaande code in. Of tik op de inwissellink in dit bericht.',
    'Open Sorting History (de App Store-versie, niet TestFlight) en wacht tot 60 seconden totdat je Historicus-abonnement verschijnt. Je kunt dit bevestigen onder Instellingen -> Abonnement in de app.',
    'Als je abonnement niet binnen 60 seconden wordt geactiveerd: sluit Sorting History geforceerd af (veeg omhoog vanaf de home-indicator en schuif de app-kaart krachtig naar boven) en open de app opnieuw. Controleer daarna opnieuw Instellingen -> Abonnement.',
    'Zie je na 5 minuten nog steeds geen Historicus-toegang: stuur een e-mail naar hello@sortinghistory.com met je Apple ID-e-mailadres en de datum waarop je de code hebt ingewisseld. Wissel de code NIET een tweede keer in - het is een eenmalige code en zal mislukken.',
  ];

  const installHeadingES = 'Antes de canjear este código:';
  const installStepsES: string[] = [
    'Instala primero Sorting History desde la App Store. Busca "Sorting History" en la App Store de tu iPhone o iPad, o usa este enlace: https://apps.apple.com/app/id6760428599. Toca Obtener / Instalar / Actualizar.',
    'Si actualmente tienes Sorting History instalado mediante TestFlight, TAMBIÉN debes instalar la versión de la App Store. Son builds separados y tu suscripción solo se activa en la versión de la App Store. La instalación de la App Store reemplaza la instalación de TestFlight o coexiste con ella.',
    'Después canjea el código. Abre la app App Store -> toca tu foto de perfil (arriba a la derecha) -> toca Canjear tarjeta de regalo o código -> ingresa el código de abajo. O bien, toca el enlace de canje incluido en este mensaje.',
    'Abre Sorting History (la versión de la App Store, no TestFlight) y espera hasta 60 segundos a que aparezca tu suscripción Historiador. Puedes confirmarlo en Ajustes -> Suscripción dentro de la app.',
    'Si tu suscripción no se activa en 60 segundos: cierra Sorting History por completo (desliza hacia arriba desde el indicador de inicio y arrastra la tarjeta de la app hacia arriba) y vuelve a abrirla. Luego revisa de nuevo Ajustes -> Suscripción.',
    'Si después de 5 minutos todavía no ves acceso Historiador: envía un correo a hello@sortinghistory.com con el correo de tu Apple ID y la fecha en que canjeaste. NO canjees el código una segunda vez - es un código de un solo uso y fallará.',
  ];

  const strings: Record<EmailLocale, {
    subject: string;
    heading: string;
    body: string[];
    installHeading: string;
    installSteps: string[];
    cta: string;
    codeLabel: string;
    footnote: string;
    signoff: string;
  }> = {
    en: {
      subject: `Thanks for the bug report - 2 months of Historian on us`,
      heading: 'Thank you for making Sorting History better',
      body: [
        `We received your bug report and truly appreciate you taking the time. I built Sorting History for my family, and every bug report makes it better for everyone.`,
        `As a thank you, here are 2 months of Historian, our premier subscription, free with no auto-renewal. You will not be charged. Historian unlocks all Epic categories and the exclusive History Pinpoint game mode.`,
      ],
      installHeading: installHeadingEN,
      installSteps: installStepsEN,
      cta: 'Redeem now',
      codeLabel: 'Your code',
      footnote: `One redemption per Apple ID. Code expires ${expirationISO}. Bug #${issueNumber}.`,
      signoff: '- Sorting History',
    },
    // de/pt/nl/es body copy: BBE-001 v3 translations applied 2026-04-25
    // (handoff: docs/marketing/handoffs/Mara-BBE-Reward-Email-v3-Translations-20260425.md).
    // installHeading/installSteps remain EN pending Mara translation handoff.
    de: {
      subject: `Danke für deinen Fehlerbericht - 2 Monate Historian gehen auf uns`,
      heading: 'Danke, dass du Sorting History besser machst',
      body: [
        `Wir haben deinen Fehlerbericht erhalten und sind dir wirklich dankbar, dass du dir die Zeit genommen hast. Ich habe Sorting History für meine Familie entwickelt, und jeder Fehlerbericht macht es für alle besser.`,
        `Als Dankeschön schenken wir dir 2 Monate Historian, unser Premium-Abonnement - kostenlos und ohne automatische Verlängerung. Es wird dir nichts berechnet. Historian schaltet alle epischen Kategorien und den exklusiven Spielmodus History Pinpoint frei.`,
      ],
      installHeading: installHeadingDE,
      installSteps: installStepsDE,
      cta: 'Jetzt einlösen',
      codeLabel: 'Dein Code',
      footnote: `Eine Einlösung pro Apple-ID. Code läuft am ${expirationISO} ab. Bug #${issueNumber}.`,
      signoff: '- Sorting History',
    },
    pt: {
      subject: `Obrigado pelo relato de bug - 2 meses de Historian por conta da casa`,
      heading: 'Obrigado por tornares o Sorting History melhor',
      body: [
        `Recebemos o teu relato de bug e agradecemos sinceramente o tempo que dedicaste. Criei o Sorting History para a minha família, e cada relato de bug torna o jogo melhor para todos.`,
        `Como agradecimento, aqui ficam 2 meses de Historian, a nossa subscrição premium - grátis e sem renovação automática. Não há qualquer cobrança. O Historian desbloqueia todas as categorias épicas e o modo de jogo exclusivo History Pinpoint.`,
      ],
      installHeading: installHeadingPT,
      installSteps: installStepsPT,
      cta: 'Resgatar agora',
      codeLabel: 'O teu código',
      footnote: `Um resgate por ID Apple. O código expira em ${expirationISO}. Bug #${issueNumber}.`,
      signoff: '- Sorting History',
    },
    nl: {
      subject: `Bedankt voor je bugrapport - 2 maanden Historian van ons`,
      heading: 'Bedankt dat je Sorting History beter maakt',
      body: [
        `We hebben je bugrapport ontvangen en we waarderen het echt dat je de tijd hebt genomen. Ik heb Sorting History voor mijn familie gemaakt, en elk bugrapport maakt het voor iedereen beter.`,
        `Als bedankje geven we je 2 maanden Historian, ons premium-abonnement - gratis en zonder automatische verlenging. Je wordt niets in rekening gebracht. Historian ontgrendelt alle epische categorieën en de exclusieve spelmodus History Pinpoint.`,
      ],
      installHeading: installHeadingNL,
      installSteps: installStepsNL,
      cta: 'Nu inwisselen',
      codeLabel: 'Jouw code',
      footnote: `Eén inwisseling per Apple ID. Code verloopt op ${expirationISO}. Bug #${issueNumber}.`,
      signoff: '- Sorting History',
    },
    es: {
      subject: `Gracias por el reporte de bug - 2 meses de Historian de regalo`,
      heading: 'Gracias por hacer mejor Sorting History',
      body: [
        `Recibimos tu reporte de bug y de verdad apreciamos que te hayas tomado el tiempo. Creé Sorting History para mi familia, y cada reporte de bug lo mejora para todos.`,
        `Como agradecimiento, aquí tienes 2 meses de Historian, nuestra suscripción premium - gratis y sin renovación automática. No se te cobrará nada. Historian desbloquea todas las categorías épicas y el modo de juego exclusivo History Pinpoint.`,
      ],
      installHeading: installHeadingES,
      installSteps: installStepsES,
      cta: 'Canjear ahora',
      codeLabel: 'Tu código',
      footnote: `Un canje por ID de Apple. El código vence el ${expirationISO}. Bug #${issueNumber}.`,
      signoff: '- Sorting History',
    },
  };

  const s = strings[locale];

  const installStepsHtml = s.installSteps
    .map((step) => `<li style="margin:0 0 8px;line-height:1.6;">${escapeHtml(step)}</li>`)
    .join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="text-align:center;padding:20px 0;border-bottom:2px solid #1a3a4a;">
    <h1 style="color:#1a3a4a;margin:0;font-size:24px;">Sorting History</h1>
  </div>
  <div style="padding:30px 0;">
    <h2 style="color:#1a3a4a;">${escapeHtml(s.heading)}</h2>
    ${s.body.map((p) => `<p style="line-height:1.6;">${escapeHtml(p)}</p>`).join('')}
    <div style="background:#fff8e1;border-left:4px solid #d97706;padding:16px 20px;margin:24px 0;border-radius:0 8px 8px 0;">
      <p style="margin:0 0 12px;line-height:1.6;"><strong>${escapeHtml(s.installHeading)}</strong></p>
      <ol style="margin:0;padding-left:20px;">${installStepsHtml}</ol>
    </div>
    <div style="background:#f0f7fa;border-left:4px solid #1a3a4a;padding:16px 20px;margin:24px 0;border-radius:0 8px 8px 0;">
      <p style="margin:0 0 8px;line-height:1.6;"><strong>${escapeHtml(s.codeLabel)}:</strong> <code style="font-size:18px;letter-spacing:1px;">${escapeHtml(code)}</code></p>
      <p style="margin:0;"><a href="${escapeAttr(redeemUrl)}" style="display:inline-block;padding:10px 16px;background:#1a3a4a;color:#fff;text-decoration:none;border-radius:6px;">${escapeHtml(s.cta)}</a></p>
    </div>
    <p style="color:#666;font-size:13px;line-height:1.6;">${escapeHtml(s.footnote)}</p>
  </div>
  <div style="border-top:1px solid #e0e0e0;padding-top:16px;text-align:center;color:#999;font-size:13px;">
    <p>${escapeHtml(s.signoff)}</p>
  </div>
</body></html>`;

  const bodyText = s.body.join('\n\n');
  const installText = [
    s.installHeading,
    '',
    ...s.installSteps.map((step, i) => `${i + 1}. ${step}`),
  ].join('\n');
  const text = [
    s.heading,
    '',
    bodyText,
    '',
    installText,
    '',
    `${s.codeLabel}: ${code}`,
    `${s.cta}: ${redeemUrl}`,
    '',
    s.footnote,
    '',
    s.signoff,
  ].join('\n');

  return { subject: s.subject, html, text };
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(v: string): string {
  return escapeHtml(v);
}

// ---------------------------------------------------------------------------
// Reward flow (label event -> claim -> send -> mark used)
// ---------------------------------------------------------------------------

export interface RewardDispatchResult {
  status:
    | 'sent'
    | 'duplicate'
    | 'no-email'
    | 'opted-out'
    | 'inventory-empty'
    | 'send-failed'
    | 'skipped';
  code?: string;
  reason?: string;
}

export interface RewardDispatchInputs {
  issueNumber: number;
  labels: string[];
  recipientEmail?: string | null;
  gameLanguage?: string | null;
  locale?: string | null;
}

/**
 * Main entry point invoked by the GitHub `issues.labeled` webhook handler.
 *
 * Fires ONLY when the label applied is the trigger label AND `no-reward` is
 * not present. Reserves a code, sends the email via Resend, marks the code
 * used. On email delivery failure, releases the code back to 'available'
 * and alerts Ra'uf.
 */
export async function dispatchReward(
  env: BBEEnv,
  inputs: RewardDispatchInputs
): Promise<RewardDispatchResult> {
  const labels = new Set((inputs.labels || []).map((l) => (l || '').toLowerCase()));

  // D2: trigger on `approved-for-fix` OR legacy `approved` (integration branch).
  const isTrigger = labels.has('approved-for-fix') || labels.has('approved');
  if (!isTrigger) {
    return { status: 'skipped', reason: 'no trigger label' };
  }
  // D3: default-on with `no-reward` opt-out.
  if (labels.has('no-reward')) {
    await writeAudit(env, {
      event: 'reward_opted_out',
      bug_report_id: String(inputs.issueNumber),
      detail: 'no-reward label present',
    });
    return { status: 'opted-out' };
  }

  const email = (inputs.recipientEmail || '').trim();
  if (!email || !email.includes('@')) {
    await writeAudit(env, {
      event: 'reward_no_email',
      bug_report_id: String(inputs.issueNumber),
    });
    return { status: 'no-email' };
  }

  const bugReportId = String(inputs.issueNumber);

  // AC12 duplicate protection lives inside claimCode().
  const alreadySent = await env.BBE_DB
    .prepare(`SELECT code FROM bug_bounty_codes
              WHERE bug_report_id = ? AND status IN ('reserved','used')
              LIMIT 1`)
    .bind(bugReportId)
    .first<{ code: string }>();
  if (alreadySent && alreadySent.code) {
    await writeAudit(env, {
      event: 'reward_duplicate',
      code: alreadySent.code,
      bug_report_id: bugReportId,
      recipient_email: email,
    });
    return { status: 'duplicate', code: alreadySent.code };
  }

  const code = await claimCode(env, bugReportId, email);
  if (!code) {
    const duplicate = await env.BBE_DB
      .prepare(`SELECT code FROM bug_bounty_codes
                WHERE bug_report_id = ? AND status IN ('reserved','used')
                LIMIT 1`)
      .bind(bugReportId)
      .first<{ code: string }>();
    if (duplicate && duplicate.code) {
      await writeAudit(env, {
        event: 'reward_duplicate',
        code: duplicate.code,
        bug_report_id: bugReportId,
        recipient_email: email,
      });
      return { status: 'duplicate', code: duplicate.code };
    }

    await writeAudit(env, {
      event: 'reward_inventory_empty',
      bug_report_id: bugReportId,
      recipient_email: email,
    });
    await sendAlert(env, 'BBE: inventory empty', `Could not reserve a code for bug #${bugReportId} — no available codes in bug_bounty_codes.`);
    return { status: 'inventory-empty' };
  }

  const redeemBase =
    env.BBE_REDEEM_BASE ||
    'https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=';
  const redeemUrl = `${redeemBase}${encodeURIComponent(code)}`;

  const expirationMs = env.BBE_BATCH_EXPIRATION ? Date.parse(env.BBE_BATCH_EXPIRATION) : NaN;
  const expirationISO = Number.isFinite(expirationMs)
    ? new Date(expirationMs).toISOString().slice(0, 10)
    : 'TBD';

  const locale = detectLocale(inputs.gameLanguage || inputs.locale);
  const rendered = renderRewardEmail({
    code,
    redeemUrl,
    issueNumber: inputs.issueNumber,
    expirationISO,
    locale,
  });

  const sendOk = await sendResendEmail(env, {
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  if (!sendOk) {
    await releaseCode(env, code, 'resend send failed');
    await sendAlert(env, 'BBE: send failure', `Resend send failed for bug #${bugReportId}, code released.`);
    return { status: 'send-failed', code };
  }

  await markUsed(env, code);
  return { status: 'sent', code };
}

// ---------------------------------------------------------------------------
// BBE-003: Intake-time code reservation
//
// Per BBE-003 (PM/Ra'uf decision Option B, 2026-05-02): the intake
// acknowledgement email must embed the reward code immediately at bug
// submission time, not on a later `approved-for-fix` label event. This
// helper reserves a code from the bug-bounty pool without sending any
// email -- the caller (the intake `sendThankYouEmail` in index.ts)
// renders its own template and is responsible for calling
// `markUsed(env, code)` on Resend success or `releaseCode(...)` on
// failure.
//
// Duplicate-protection: `claimCode` already guards on bug_report_id,
// so a retry for the same issue returns null after the first claim.
// The label-trigger `dispatchReward` path remains in place as a
// safety net; it will return `duplicate` once intake has already
// burned a code for the issue.
// ---------------------------------------------------------------------------

export interface IntakeReservation {
  code: string;
  redeemUrl: string;
  expirationISO: string;
}

export async function reserveIntakeCode(
  env: BBEEnv,
  bugReportId: string,
  recipientEmail: string
): Promise<IntakeReservation | null> {
  const code = await claimCode(env, bugReportId, recipientEmail);
  if (!code) return null;
  const redeemBase =
    env.BBE_REDEEM_BASE ||
    'https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=';
  const redeemUrl = `${redeemBase}${encodeURIComponent(code)}`;
  const expirationMs = env.BBE_BATCH_EXPIRATION ? Date.parse(env.BBE_BATCH_EXPIRATION) : NaN;
  const expirationISO = Number.isFinite(expirationMs)
    ? new Date(expirationMs).toISOString().slice(0, 10)
    : 'TBD';
  return { code, redeemUrl, expirationISO };
}

// ---------------------------------------------------------------------------
// Resend wrapper + alerts
// ---------------------------------------------------------------------------

async function sendResendEmail(
  env: BBEEnv,
  msg: { to: string; subject: string; html: string; text: string }
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.error('BBE: RESEND_API_KEY not configured');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Sorting History <hello@sortinghistory.com>',
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`BBE: Resend returned ${res.status}: ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('BBE: Resend threw', err);
    return false;
  }
}

export async function sendAlert(env: BBEEnv, subject: string, body: string): Promise<void> {
  if (!env.BBE_ALERT_EMAIL) return;
  await sendResendEmail(env, {
    to: env.BBE_ALERT_EMAIL,
    subject: `[BBE] ${subject}`,
    html: `<pre style="font-family:monospace;white-space:pre-wrap;">${escapeHtml(body)}</pre>`,
    text: body,
  });
}

// ---------------------------------------------------------------------------
// Alerts + weekly digest
// ---------------------------------------------------------------------------

export interface InventoryStatus {
  available: number;
  reserved: number;
  used: number;
  invalidated: number;
  total: number;
  daysToExpiration: number | null;
}

export async function getInventoryStatus(env: BBEEnv): Promise<InventoryStatus> {
  const rows = await env.BBE_DB
    .prepare(`SELECT status, COUNT(*) AS n FROM bug_bounty_codes GROUP BY status`)
    .all<{ status: string; n: number }>();
  const counts: Record<string, number> = { available: 0, reserved: 0, used: 0, invalidated: 0 };
  for (const r of rows.results || []) {
    counts[r.status] = r.n;
  }
  const total = counts.available + counts.reserved + counts.used + counts.invalidated;
  let daysToExpiration: number | null = null;
  if (env.BBE_BATCH_EXPIRATION) {
    const ms = Date.parse(env.BBE_BATCH_EXPIRATION);
    if (Number.isFinite(ms)) {
      daysToExpiration = Math.floor((ms - Date.now()) / (1000 * 60 * 60 * 24));
    }
  }
  return {
    available: counts.available,
    reserved: counts.reserved,
    used: counts.used,
    invalidated: counts.invalidated,
    total,
    daysToExpiration,
  };
}

export async function runInventoryAlertCheck(env: BBEEnv): Promise<void> {
  const inv = await getInventoryStatus(env);
  const lowThreshold = parseInt(env.BBE_LOW_INVENTORY_THRESHOLD || '100', 10);
  const warnDays = parseInt(env.BBE_EXPIRATION_WARN_DAYS || '30', 10);

  const alerts: string[] = [];
  if (inv.available < lowThreshold) {
    alerts.push(`Inventory low: ${inv.available} codes remaining (threshold ${lowThreshold}).`);
  }
  if (inv.daysToExpiration !== null && inv.daysToExpiration <= warnDays) {
    alerts.push(`Batch expires in ${inv.daysToExpiration} days (threshold ${warnDays}).`);
  }

  if (alerts.length === 0) return;

  // Debounce: only fire the same alert once per day.
  const today = new Date().toISOString().slice(0, 10);
  const key = `alert_${today}_${alerts.join('|').slice(0, 100)}`;
  const seen = await env.BBE_DB
    .prepare(`SELECT value FROM bug_bounty_meta WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  if (seen) return;
  await env.BBE_DB
    .prepare(`INSERT OR REPLACE INTO bug_bounty_meta (key, value) VALUES (?, ?)`)
    .bind(key, '1')
    .run();

  await sendAlert(env, 'Inventory/expiration alert', alerts.join('\n'));
}

export async function runWeeklyDigest(env: BBEEnv): Promise<{ skipped: boolean; body: string }> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sentThisWeek = await env.BBE_DB
    .prepare(`SELECT COUNT(*) AS n FROM bug_bounty_audit WHERE event = 'code_sent' AND ts >= ?`)
    .bind(weekAgo)
    .first<{ n: number }>();
  const fails = await env.BBE_DB
    .prepare(`SELECT COUNT(*) AS n FROM bug_bounty_audit
              WHERE event IN ('code_released','reward_inventory_empty') AND ts >= ?`)
    .bind(weekAgo)
    .first<{ n: number }>();

  const inv = await getInventoryStatus(env);
  const sent = sentThisWeek?.n ?? 0;
  const failed = fails?.n ?? 0;

  if (sent === 0 && failed === 0 && inv.available >= parseInt(env.BBE_LOW_INVENTORY_THRESHOLD || '100', 10)) {
    return { skipped: true, body: 'No activity; digest skipped.' };
  }

  const body =
    `BBE weekly digest\n` +
    `------------------\n` +
    `Codes sent this week: ${sent}\n` +
    `Send failures this week: ${failed}\n` +
    `Codes remaining: ${inv.available}\n` +
    `Codes reserved: ${inv.reserved}\n` +
    `Codes used: ${inv.used}\n` +
    `Days until batch expiration: ${inv.daysToExpiration ?? 'unknown'}\n`;

  await sendAlert(env, 'Weekly digest', body);
  return { skipped: false, body };
}

// ---------------------------------------------------------------------------
// Manual override + rollback
// ---------------------------------------------------------------------------

/**
 * Admin endpoint: send a code from inventory to any email. Writes the same
 * audit row format as automated sends. Requires BBE_ADMIN_TOKEN.
 */
export async function handleManualSend(
  env: BBEEnv,
  input: { recipient_email: string; reason?: string; locale?: string }
): Promise<{ ok: boolean; code?: string; reason?: string }> {
  const email = (input.recipient_email || '').trim();
  if (!email.includes('@')) return { ok: false, reason: 'invalid email' };
  const bugReportId = `manual-${Date.now()}`;

  const code = await claimCode(env, bugReportId, email);
  if (!code) return { ok: false, reason: 'inventory-empty' };

  const redeemBase =
    env.BBE_REDEEM_BASE ||
    'https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=';
  const redeemUrl = `${redeemBase}${encodeURIComponent(code)}`;
  const expirationMs = env.BBE_BATCH_EXPIRATION ? Date.parse(env.BBE_BATCH_EXPIRATION) : NaN;
  const expirationISO = Number.isFinite(expirationMs)
    ? new Date(expirationMs).toISOString().slice(0, 10)
    : 'TBD';
  const locale = detectLocale(input.locale);
  const rendered = renderRewardEmail({
    code,
    redeemUrl,
    issueNumber: 0,
    expirationISO,
    locale,
  });
  const ok = await sendResendEmail(env, {
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  if (!ok) {
    await releaseCode(env, code, 'manual send failed');
    return { ok: false, reason: 'send-failed' };
  }
  await markUsed(env, code);
  await writeAudit(env, {
    event: 'manual_send',
    code,
    recipient_email: email,
    bug_report_id: bugReportId,
    detail: input.reason || '',
  });
  return { ok: true, code };
}

/**
 * Rollback primitive: invalidate every available code in a batch so nothing
 * new can be sent. Used if Ra'uf needs to pause the automation without
 * tearing down the worker. Idempotent.
 */
export async function invalidateAvailableCodes(env: BBEEnv, reason: string): Promise<number> {
  const now = Date.now();
  const res = await env.BBE_DB
    .prepare(`UPDATE bug_bounty_codes
              SET status = 'invalidated', invalidated_at = ?
              WHERE status = 'available'`)
    .bind(now)
    .run();
  const changes = res?.meta?.changes ?? 0;
  await writeAudit(env, {
    event: 'batch_invalidated',
    detail: `${changes} codes invalidated: ${reason}`,
  });
  return changes;
}

// ---------------------------------------------------------------------------
// GitHub helpers (for the webhook trigger)
// ---------------------------------------------------------------------------

export async function fetchReporterEmailFromIssue(
  env: BBEEnv,
  issueNumber: number
): Promise<{ email: string | null; gameLanguage: string | null; locale: string | null }> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return { email: null, gameLanguage: null, locale: null };
  }
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`,
    {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!res.ok) return { email: null, gameLanguage: null, locale: null };
  const data = (await res.json()) as { body?: string };
  const body = data.body || '';
  const emailMatch = body.match(/\*\*Contact Email:\*\*\s*(\S+@\S+)/);
  return {
    email: emailMatch ? emailMatch[1] : null,
    gameLanguage: extractIssueField(body, 'Game Language'),
    locale: extractIssueField(body, 'Locale'),
  };
}

function extractIssueField(body: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boldMatch = body.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\s|]+)`));
  if (boldMatch) return boldMatch[1].trim();

  const tableMatch = body.match(new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|\\n]+?)\\s*\\|\\s*$`, 'im'));
  return tableMatch ? tableMatch[1].trim() : null;
}
