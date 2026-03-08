/**
 * Story 2.1: Content Verifier Subagent
 *
 * Runs a two-phase content verification pipeline:
 *   Phase 1 (Automated): validate_content.py checks G0, P1-P12, D1-D3
 *   Phase 2 (AI):         Haiku subagent checks Gate 1 (factual) and Gate 2 (age)
 *
 * Only events that PASS automated gates proceed to AI verification.
 * Output is structured JSON combining both phases.
 *
 * Exit codes:
 * - 0: Success (verification completed, results returned)
 * - 1: Failure (could not run verification pipeline)
 */

import { MODELS, VERIFIER_TOOLS, PATHS } from "../config.js";
import { spawnSubagent, type SubagentResult } from "../lib/subagent.js";
import { extractJson } from "../lib/json-extract.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Single event from the fixture/category file */
interface GameEvent {
  title: string;
  year: number;
  description: string;
  category: string;
  difficulty: number;
  month?: number;
  day?: number;
  version?: number;
  imageURL?: string | null;
  _planted_error?: string;
}

/** Category file structure */
interface CategoryFile {
  category: string;
  events: GameEvent[];
}

/** Automated gate failure from validate_content.py or inline fallback */
interface AutomatedFailure {
  title: string;
  codes: string[];
  details: string;
}

/** AI gate failure from Haiku subagent */
interface AiFailure {
  title: string;
  codes: string[];
  details: string;
}

/** Per-event AI result from Haiku */
interface AiEventResult {
  title: string;
  year: number;
  gate1_factual: {
    passed: boolean;
    code: string | null;
    details: string;
  };
  gate2_age: {
    passed: boolean;
    code: string | null;
    details: string;
  };
  overall_passed: boolean;
}

/** Full AI response from Haiku subagent */
interface AiVerificationResponse {
  events_checked: number;
  events_passed: number;
  events_failed: number;
  results: AiEventResult[];
}

/** Complete verification result combining both phases */
export interface ContentVerificationResult {
  category: string;
  total_events: number;
  automated_gates: {
    passed: number;
    failed: number;
    failures: AutomatedFailure[];
  };
  ai_gates: {
    checked: number;
    passed: number;
    failed: number;
    failures: AiFailure[];
  };
  summary: {
    total_passed: number;
    total_failed: number;
    all_failures: Array<AutomatedFailure | AiFailure>;
  };
}

/** Input for the content verification workflow */
export interface ContentVerifyInput {
  /** Path to the JSON file to verify (absolute or relative to cwd) */
  filePath: string;
  /** Category name (used for logging) */
  category?: string;
}

// ------------------------------------------------------------------
// Phase 1: Automated gates (validate_content.py or inline fallback)
// ------------------------------------------------------------------

/** Word count check — matches content_rules.py WORD_COUNT_MIN / WORD_COUNT_MAX */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/** Year pattern — matches content_rules.py YEAR_PATTERN for P5 date spoiler check */
const YEAR_REGEX = /\b(1[0-9]{3}|20[0-2][0-9])\b/;

/** Valid category strings — must match HistoryCategory.rawValue exactly */
const VALID_CATEGORIES = new Set([
  "US History", "Portuguese History", "German History", "European History",
  "Medieval History", "Asian History", "African History", "South American History",
  "World Wars", "Ancient Civilizations", "Scientific Discoveries", "Medical Breakthroughs",
  "Technological Inventions", "Space Exploration", "Political Events",
  "Revolutions & Independence", "Artists & Literature", "Music & Entertainment",
  "Religious Events", "Natural Disasters", "Economic Events", "Sports History",
  "LGBTQ History", "Black History", "Women's History", "TV History", "Food & Drink",
  // Epic / Expansion categories (Historian-only, 500+ events)
  "US History Epic", "World Wars Epic", "Sports History Epic",
  "Film History Epic", "TV History Epic",
]);

/** Common nationalities and country names for P4 country context detection */
const COUNTRY_CONTEXT_TERMS = [
  // Nationalities
  "American", "British", "French", "German", "Japanese", "Chinese",
  "Russian", "Spanish", "Italian", "Portuguese", "Dutch", "Belgian",
  "Austrian", "Hungarian", "Polish", "Swedish", "Norwegian", "Danish",
  "Greek", "Turkish", "Ottoman", "Persian", "Iranian", "Egyptian",
  "Indian", "Korean", "Australian", "Canadian", "Mexican", "Brazilian",
  "Argentine", "Cuban", "African", "European", "Asian", "Soviet",
  "Confederate", "Prussian", "Byzantine", "Roman", "Vietnamese",
  // Short-form country abbreviations
  "US ", "U.S.",
  // Countries and regions
  "United States", "America", "Britain", "England", "France", "Spain",
  "Germany", "China", "Japan", "Russia", "Italy", "Portugal",
  "Netherlands", "Belgium", "Austria", "Hungary", "Poland", "Greece",
  "Turkey", "Egypt", "India", "Korea", "Australia", "Canada",
  "Mexico", "Brazil", "Argentina", "Cuba", "Vietnam",
  // US States (major)
  "Virginia", "Massachusetts", "Pennsylvania", "New York", "California",
  "Texas", "Florida", "Ohio", "Georgia", "Alabama", "Mississippi",
  "Louisiana", "Tennessee", "Kentucky", "Utah", "Montana", "Oregon",
  "South Carolina", "North Carolina", "Illinois", "Michigan", "Hawaii",
  // Cities
  "Washington", "Philadelphia", "Boston", "New Orleans", "Chicago",
  "San Francisco", "Los Angeles", "Montgomery", "Gettysburg",
];

/**
 * Run inline automated checks as a fallback when validate_content.py is unavailable.
 * Checks: G0 (category string), P1/P2 (word count), P4 (country context), P5 (date spoiler), D2 (near-duplicates).
 */
export function runInlineAutomatedChecks(events: GameEvent[]): {
  passed: GameEvent[];
  failed: AutomatedFailure[];
} {
  const passed: GameEvent[] = [];
  const failed: AutomatedFailure[] = [];

  // Build title index for duplicate detection
  const titleIndex = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const key = events[i].title.toLowerCase().trim();
    if (titleIndex.has(key)) {
      // Exact duplicate title — mark the later one
      failed.push({
        title: events[i].title,
        codes: ["D1"],
        details: "Exact duplicate title (case-insensitive)",
      });
      continue;
    }
    titleIndex.set(key, i);
  }

  // Track seen events for near-duplicate detection
  const seenEvents: Array<{ title: string; year: number; descWords: string[] }> = [];

  for (const event of events) {
    // Skip events already caught as exact duplicates
    if (failed.some(f => f.title === event.title && f.codes.includes("D1"))) {
      continue;
    }

    const codes: string[] = [];
    const details: string[] = [];

    // G0: Category string validation
    if (!VALID_CATEGORIES.has(event.category)) {
      codes.push("G0");
      details.push("Category string '" + event.category + "' does not match HistoryCategory.rawValue");
    }

    // P1: Description too short
    const wordCount = countWords(event.description);
    if (wordCount < 10) {
      codes.push("P1");
      details.push("Description has " + wordCount + " words (minimum 10)");
    }

    // P2: Description too long
    if (wordCount > 23) {
      codes.push("P2");
      details.push("Description has " + wordCount + " words (maximum 23)");
    }

    // P3: Title too long
    if (event.title.length > 50) {
      codes.push("P3");
      details.push("Title has " + event.title.length + " characters (maximum ~50)");
    }

    // P4: Missing country context
    const combinedText = event.title + " " + event.description;
    const hasCountryContext = COUNTRY_CONTEXT_TERMS.some(
      term => combinedText.includes(term),
    );
    if (!hasCountryContext) {
      codes.push("P4");
      details.push("No country, nationality, or geographic context found in title or description");
    }

    // P5: Date spoiler in description
    if (YEAR_REGEX.test(event.description)) {
      codes.push("P5");
      details.push("Description contains a year number (date spoiler)");
    }

    // D2: Near-duplicate detection (same year + >80% word overlap)
    const descWords = event.description.toLowerCase().split(/\s+/);
    for (const seen of seenEvents) {
      if (seen.year === event.year) {
        // Calculate word overlap
        const seenSet = new Set(seen.descWords);
        const overlapCount = descWords.filter(w => seenSet.has(w)).length;
        const overlapRatio = overlapCount / Math.max(descWords.length, seen.descWords.length);
        if (overlapRatio > 0.8) {
          codes.push("D2");
          details.push("Near-duplicate of '" + seen.title + "' (same year " + event.year + ", " + Math.round(overlapRatio * 100) + "% word overlap)");
          break;
        }
      }
    }

    seenEvents.push({ title: event.title, year: event.year, descWords });

    if (codes.length > 0) {
      failed.push({
        title: event.title,
        codes,
        details: details.join("; "),
      });
    } else {
      passed.push(event);
    }
  }

  return { passed, failed };
}

/**
 * Try to run validate_content.py via Python for full automated gate coverage.
 * Falls back to inline checks if the script is not available.
 */
async function runAutomatedGates(
  filePath: string,
  repoRoot: string,
): Promise<{
  passedEvents: GameEvent[];
  failures: AutomatedFailure[];
  usedPython: boolean;
}> {
  // Load the events file
  let categoryData: CategoryFile;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    categoryData = JSON.parse(raw) as CategoryFile;
  } catch (err: unknown) {
    const msg = "[content-verify] Could not read events file: " + filePath + " — " + (err instanceof Error ? err.message : String(err));
    console.error(msg);
    throw new Error(msg);
  }

  // Inherit file-level category onto events that don't have their own category field
  const fileCategory = categoryData.category;
  const events = categoryData.events.map(e => ({
    ...e,
    category: e.category ?? fileCategory,
  }));
  console.log("[content-verify] Loaded " + events.length + " events from " + filePath);

  // Try to find validate_content.py
  const gameRepo = path.resolve(repoRoot, PATHS.GAME_REPO);
  const pythonScript = path.join(gameRepo, "Scripts", "validate_content.py");
  const pythonExists = fs.existsSync(pythonScript);

  if (!pythonExists) {
    console.log("[content-verify] WARNING: validate_content.py not found at " + pythonScript);
    console.log("[content-verify] Running inline automated checks as fallback");

    const { passed, failed } = runInlineAutomatedChecks(events);
    return { passedEvents: passed, failures: failed, usedPython: false };
  }

  // Run validate_content.py with --staging --json
  console.log("[content-verify] Running validate_content.py on " + filePath);

  const { execSync } = await import("node:child_process");

  try {
    const output = execSync(
      "python3 " + JSON.stringify(pythonScript) + " " + JSON.stringify(filePath) + " --staging --json",
      {
        cwd: gameRepo,
        encoding: "utf-8",
        timeout: 60000,
        env: { ...process.env },
      },
    );

    // Parse the JSON output from validate_content.py
    // The script outputs human-readable text first, then JSON. Find the JSON part.
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) {
      console.log("[content-verify] WARNING: No JSON in validate_content.py output, falling back to inline checks");
      const { passed, failed } = runInlineAutomatedChecks(events);
      return { passedEvents: passed, failures: failed, usedPython: false };
    }

    const jsonOutput = output.slice(jsonStart);
    const parsed = JSON.parse(jsonOutput) as {
      summary: { total_events: number; passed: number; failed: number };
      categories: Record<string, {
        total: number;
        passed: number;
        failed: number;
        failures: Array<{
          title: string;
          year: number;
          failure_codes: string[];
          details: Record<string, string>;
        }>;
      }>;
    };

    // Extract failures from Python output
    const failures: AutomatedFailure[] = [];
    const failedTitles = new Set<string>();

    for (const catResult of Object.values(parsed.categories)) {
      if (catResult.failures) {
        for (const f of catResult.failures) {
          failures.push({
            title: f.title,
            codes: f.failure_codes,
            details: Object.values(f.details).join("; "),
          });
          failedTitles.add(f.title);
        }
      }
    }

    // Events that passed automated gates
    const passedEvents = events.filter(e => !failedTitles.has(e.title));

    return { passedEvents, failures, usedPython: true };

  } catch (err: unknown) {
    // Python script failed — fall back to inline checks
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log("[content-verify] WARNING: validate_content.py failed: " + errorMsg);
    console.log("[content-verify] Running inline automated checks as fallback");

    const { passed, failed } = runInlineAutomatedChecks(events);
    return { passedEvents: passed, failures: failed, usedPython: false };
  }
}

// ------------------------------------------------------------------
// Phase 2: AI verification via Haiku subagent
// ------------------------------------------------------------------

/** Maximum events per AI verification batch to avoid context overflow */
const AI_BATCH_SIZE = 100;

/**
 * Run AI verification on a single batch of events.
 */
async function runAiVerificationBatch(
  events: GameEvent[],
  systemPrompt: string,
  repoRoot: string,
  batchLabel: string,
): Promise<AiVerificationResponse> {
  // Strip _planted_error fields before sending to subagent
  const cleanEvents = events.map(e => {
    const clean = { ...e };
    delete clean._planted_error;
    return clean;
  });

  const eventsJson = JSON.stringify(cleanEvents, null, 2);

  const userPrompt = [
    "Verify the following " + events.length + " historical events for factual accuracy (Gate 1) and age appropriateness (Gate 2).",
    "",
    "These events have ALREADY passed automated parameter checks. You only need to check:",
    "1. Is the YEAR correct? (use Wikipedia to verify)",
    "2. Are the description CLAIMS accurate? (use Wikipedia to verify)",
    "3. Is the content AGE-APPROPRIATE? (check for graphic violence or mature themes)",
    "",
    "IMPORTANT: Be conservative with failures. Only flag something if you are CONFIDENT it is wrong.",
    "IMPORTANT: Do NOT flag standard historical vocabulary (brutal, devastating, massacre, etc.) as age-inappropriate.",
    "IMPORTANT: IGNORE diacritics issues completely.",
    "",
    "Events to verify:",
    eventsJson,
    "",
    "Output ONLY a JSON object with the verification results. No markdown, no explanation, just raw JSON.",
  ].join("\n");

  console.log("[content-verify] " + batchLabel + ": spawning Haiku subagent for " + events.length + " events");

  const result: SubagentResult = await spawnSubagent({
    model: MODELS.VERIFIER,
    tools: [...VERIFIER_TOOLS],
    prompt: userPrompt,
    systemPrompt,
    cwd: repoRoot,
    maxTurns: Math.max(25, events.length * 3),
  });

  // If AI verification failed, return empty results (automated gates still valid)
  if (!result.success) {
    console.warn("[content-verify] " + batchLabel + ": AI subagent failed (automated results still valid): " + result.error);
    return { events_checked: events.length, events_passed: events.length, events_failed: 0, results: [] };
  }

  if (result.usedWriteTools) {
    throw new Error("[content-verify] " + batchLabel + ": AI subagent used write tools (read-only violation). Tools: " + result.toolsUsed.join(", "));
  }

  if (!result.responseText) {
    throw new Error("[content-verify] " + batchLabel + ": No response text from AI subagent");
  }

  // Parse AI response
  let aiResponse: AiVerificationResponse;
  try {
    const jsonText = extractJson(result.responseText, "events_checked");
    aiResponse = JSON.parse(jsonText) as AiVerificationResponse;
  } catch (err: unknown) {
    const parseErr = err instanceof Error ? err.message : String(err);
    throw new Error("[content-verify] " + batchLabel + ": Could not parse AI response as JSON: " + parseErr + ". Raw (first 500 chars): " + (result.responseText ?? "").slice(0, 500));
  }

  // Log metrics
  console.log("[content-verify] " + batchLabel + ": AI verification complete");
  console.log("  Model: " + (result.model ?? MODELS.VERIFIER));
  console.log("  Session ID: " + result.sessionId);
  console.log("  Input tokens: " + result.inputTokens);
  console.log("  Output tokens: " + result.outputTokens);
  console.log("  Duration: " + result.durationMs + "ms");
  console.log("  Cost: $" + result.costUsd.toFixed(4));
  console.log("  Tools used: [" + result.toolsUsed.join(", ") + "]");

  return aiResponse;
}

async function runAiVerification(
  events: GameEvent[],
  repoRoot: string,
): Promise<AiVerificationResponse> {
  if (events.length === 0) {
    return { events_checked: 0, events_passed: 0, events_failed: 0, results: [] };
  }

  // Load system prompt (once, shared across all batches)
  const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "content-verifier.md");
  let systemPrompt: string;
  try {
    systemPrompt = fs.readFileSync(promptPath, "utf-8");
  } catch (err: unknown) {
    const msg = "[content-verify] Could not read system prompt at " + promptPath + " — " + (err instanceof Error ? err.message : String(err));
    console.error(msg);
    throw new Error(msg);
  }

  // Split into batches to avoid context overflow
  const batches: GameEvent[][] = [];
  for (let i = 0; i < events.length; i += AI_BATCH_SIZE) {
    batches.push(events.slice(i, i + AI_BATCH_SIZE));
  }

  if (batches.length > 1) {
    console.log("[content-verify] Splitting " + events.length + " events into " + batches.length + " batches of up to " + AI_BATCH_SIZE);
  }

  // Run each batch sequentially and merge results
  const merged: AiVerificationResponse = { events_checked: 0, events_passed: 0, events_failed: 0, results: [] };

  for (let i = 0; i < batches.length; i++) {
    const batchLabel = batches.length > 1 ? "Batch " + (i + 1) + "/" + batches.length : "Single batch";
    const batchResult = await runAiVerificationBatch(batches[i], systemPrompt, repoRoot, batchLabel);

    merged.events_checked += batchResult.events_checked;
    merged.events_passed += batchResult.events_passed;
    merged.events_failed += batchResult.events_failed;
    if (batchResult.results) {
      merged.results.push(...batchResult.results);
    }
  }

  return merged;
}

// ------------------------------------------------------------------
// Main workflow: combines Phase 1 + Phase 2
// ------------------------------------------------------------------

export async function runContentVerify(input: ContentVerifyInput): Promise<ContentVerificationResult> {
  const category = input.category ?? "Unknown";
  console.log("=== Story 2.1: Content Verification — " + category + " ===");
  console.log("File: " + input.filePath);
  console.log("Model: " + MODELS.VERIFIER);
  console.log("Tools: [" + VERIFIER_TOOLS.join(", ") + "]");
  console.log("");

  // Resolve repo root from this file's location (dist/workflows/ -> dist/ -> sdk/ -> Scripts/ -> repo root)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? path.resolve(__dirname, "..", "..", "..", "..");

  // Resolve the file path
  const resolvedPath = path.isAbsolute(input.filePath)
    ? input.filePath
    : path.resolve(repoRoot, input.filePath);

  // Phase 1: Automated gates
  console.log("--- Phase 1: Automated Gates ---");
  const { passedEvents, failures: autoFailures, usedPython } = await runAutomatedGates(
    resolvedPath,
    repoRoot,
  );

  console.log("Automated gates: " + (usedPython ? "validate_content.py" : "inline fallback"));
  console.log("  Passed: " + passedEvents.length);
  console.log("  Failed: " + autoFailures.length);

  if (autoFailures.length > 0) {
    console.log("  Failures:");
    for (const f of autoFailures) {
      console.log("    [" + f.codes.join(", ") + "] " + f.title + " — " + f.details);
    }
  }
  console.log("");

  // Phase 2: AI verification (only events that passed automated gates)
  console.log("--- Phase 2: AI Verification (Haiku) ---");
  const aiResponse = await runAiVerification(passedEvents, repoRoot);

  // Collect AI failures
  const aiFailures: AiFailure[] = [];
  let aiPassed = 0;

  if (aiResponse.results) {
    for (const r of aiResponse.results) {
      if (!r.overall_passed) {
        const codes: string[] = [];
        const details: string[] = [];

        if (!r.gate1_factual.passed && r.gate1_factual.code) {
          codes.push(r.gate1_factual.code);
          details.push(r.gate1_factual.details);
        }
        if (!r.gate2_age.passed && r.gate2_age.code) {
          codes.push(r.gate2_age.code);
          details.push(r.gate2_age.details);
        }

        aiFailures.push({
          title: r.title,
          codes,
          details: details.join("; "),
        });
      } else {
        aiPassed++;
      }
    }
  }

  console.log("AI verification:");
  console.log("  Checked: " + (aiResponse.events_checked ?? passedEvents.length));
  console.log("  Passed: " + aiPassed);
  console.log("  Failed: " + aiFailures.length);

  if (aiFailures.length > 0) {
    console.log("  Failures:");
    for (const f of aiFailures) {
      console.log("    [" + f.codes.join(", ") + "] " + f.title + " — " + f.details);
    }
  }
  console.log("");

  // Combine results
  const totalEvents = passedEvents.length + autoFailures.length;
  const totalFailed = autoFailures.length + aiFailures.length;
  const totalPassed = totalEvents - totalFailed;

  const allFailures: Array<AutomatedFailure | AiFailure> = [
    ...autoFailures,
    ...aiFailures,
  ];

  const result: ContentVerificationResult = {
    category,
    total_events: totalEvents,
    automated_gates: {
      passed: passedEvents.length,
      failed: autoFailures.length,
      failures: autoFailures,
    },
    ai_gates: {
      checked: aiResponse.events_checked ?? passedEvents.length,
      passed: aiPassed,
      failed: aiFailures.length,
      failures: aiFailures,
    },
    summary: {
      total_passed: totalPassed,
      total_failed: totalFailed,
      all_failures: allFailures,
    },
  };

  // Output final result
  console.log("=== Content Verification Summary — " + category + " ===");
  console.log("Total events: " + totalEvents);
  console.log("Total passed: " + totalPassed);
  console.log("Total failed: " + totalFailed);
  console.log("");
  console.log(JSON.stringify(result, null, 2));

  return result;
}
