/**
 * BA-008.2 AC4: Translation Verifier
 *
 * Lightweight UI-string verification adapted from the full T0-T9 translation
 * verification pipeline. Checks only the gates relevant to UI strings:
 *   - Key presence in all target languages
 *   - Format specifier match between English and translation
 *   - Diacritics spot-check (T9)
 *   - Swift dictionary syntax validity
 *   - No untranslated English left in non-English sections
 *
 * Does NOT check T0/T0.1/T1/T2 (JSON-specific gates).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranslationVerifyInput {
  /** English key-value pairs (source of truth) */
  englishKeys: Record<string, string>;
  /** Translations per language: { "Portuguese": { "key": "value" }, ... } */
  translations: Record<string, Record<string, string>>;
}

export interface VerifyFinding {
  language: string;
  key: string;
  gate: string;
  issue: string;
  severity: "error" | "warning";
}

export interface TranslationVerifyResult {
  passed: boolean;
  findings: VerifyFinding[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Format specifier extraction
// ---------------------------------------------------------------------------

/** Extract format specifiers like %d, %@, %lld, %.1f from a string */
function extractFormatSpecifiers(value: string): string[] {
  const matches = value.match(/%[@dlfse]|%\.\d+[dfe]|%ll[du]|%[0-9]*[diouxXeEfgGaAcspn@]/g);
  return matches ?? [];
}

// ---------------------------------------------------------------------------
// Diacritics checks per language (T9)
// ---------------------------------------------------------------------------

/** Expected diacritics characters per language */
const LANGUAGE_DIACRITICS: Record<string, RegExp> = {
  German: /[\u00e4\u00f6\u00fc\u00df\u00c4\u00d6\u00dc]/,     // a-umlaut, o-umlaut, u-umlaut, sharp-s, and uppercase
  Portuguese: /[\u00e1\u00e0\u00e2\u00e3\u00e9\u00ea\u00ed\u00f3\u00f4\u00f5\u00fa\u00e7]/,  // accented chars + cedilla
  Spanish: /[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00bf\u00a1]/, // accented + enye + inverted punct
  Dutch: /[\u00eb\u00ef\u00e9]/,                                  // diaeresis + accent
  French: /[\u00e0\u00e2\u00e7\u00e8\u00e9\u00ea\u00eb\u00ee\u00ef\u00f4\u00f9\u00fb\u00fc]/, // accented chars + cedilla
};

/** ASCII substitutions that indicate stripped diacritics */
const DIACRITIC_SUBSTITUTIONS: Record<string, RegExp[]> = {
  German: [
    /\bae\b/i,  // "ae" for a-umlaut (but skip legitimate "ae" in names)
    /\bue\b/i,  // "ue" for u-umlaut
    /\boe\b/i,  // "oe" for o-umlaut
  ],
  Portuguese: [
    /\bnao\b/i,   // "nao" for "n\u00e3o"
    /\bacao\b/i,  // "acao" for "a\u00e7\u00e3o"
  ],
};

// ---------------------------------------------------------------------------
// Swift syntax check (AC9)
// ---------------------------------------------------------------------------

/** Check if a key-value pair is valid Swift dictionary syntax */
function isValidSwiftDictEntry(key: string, value: string): boolean {
  // Keys and values must not contain unescaped quotes
  const unescapedQuoteInKey = key.replace(/\\"/g, "").includes('"');
  const unescapedQuoteInValue = value.replace(/\\"/g, "").includes('"');
  if (unescapedQuoteInKey || unescapedQuoteInValue) return false;

  // Key must not be empty
  if (key.trim().length === 0) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Event-level translation verification (Story 2.4a calibration)
// ---------------------------------------------------------------------------

/** Single translated event from the game data */
export interface TranslatedEvent {
  id: string;
  title: string;
  version: number;
  baseEnVersion: number;
  description: string;
  year: number;
  month?: number;
  day?: number;
  category: string;
  difficulty: number;
  imageURL?: string | null;
  _planted_error?: string;
}

/** Single English source event */
export interface EnglishEvent {
  id: string;
  title: string;
  version: number;
  description: string;
  year: number;
  month?: number;
  day?: number;
  category: string;
  difficulty: number;
  imageURL?: string | null;
}

/** Result of automated T0 gate check on a single event */
export interface T0GateResult {
  event_id: string;
  title: string;
  passed: boolean;
  code: string | null;
  details: string;
}

/** Result of automated T9 diacritics gate check on a single event */
export interface T9GateResult {
  event_id: string;
  title: string;
  passed: boolean;
  code: string | null;
  details: string;
  diacritics_count: number;
}

/** Words that are identical across languages and should never be flagged as untranslated */
const CROSS_LANGUAGE_WHITELIST = new Set([
  "Version", "Build", "iPhone", "iPad", "App Store", "App",
  "Martin Luther", "Friedrich Barbarossa", "Otto", "Karl",
  "Gutenberg", "Canossa", "Wittenberg", "Mainz", "Worms",
  "Internet", "Computer", "Software", "Hardware", "Email",
  "GPS", "USB", "PDF", "URL", "API",
]);

/**
 * T0 Structural Gate: Check if translation baseEnVersion matches English version.
 * This is an automated check, not an AI check.
 */
export function runT0StructuralCheck(
  translatedEvent: TranslatedEvent,
  englishEvent: EnglishEvent,
): T0GateResult {
  if (translatedEvent.baseEnVersion < englishEvent.version) {
    return {
      event_id: translatedEvent.id,
      title: translatedEvent.title,
      passed: false,
      code: "T0_STALE",
      details: "Stale translation: baseEnVersion=" + translatedEvent.baseEnVersion +
        " but English version=" + englishEvent.version +
        ". Translation needs update.",
    };
  }

  return {
    event_id: translatedEvent.id,
    title: translatedEvent.title,
    passed: true,
    code: null,
    details: "baseEnVersion matches English version",
  };
}

/** Count diacritics characters in a string */
export function countDiacritics(text: string): number {
  // Match common diacritics: accented Latin chars, umlauts, cedillas, tildes, etc.
  const diacriticsRegex = /[\u00C0-\u00FF\u0100-\u017F]/g;
  const matches = text.match(diacriticsRegex);
  return matches ? matches.length : 0;
}

/**
 * T9 Diacritics Gate: Check if translated event has expected diacritics for language.
 * Verifies diacritics are present and not stripped to ASCII substitutes.
 */
export function runT9DiacriticsCheck(
  translatedEvent: TranslatedEvent,
  language: string,
): T9GateResult {
  const fullText = translatedEvent.title + " " + translatedEvent.description;
  const diacriticsCount = countDiacritics(fullText);

  const expectedDiacritics = LANGUAGE_DIACRITICS[language];
  if (!expectedDiacritics) {
    return {
      event_id: translatedEvent.id,
      title: translatedEvent.title,
      passed: true,
      code: null,
      details: "No diacritics rules defined for language: " + language,
      diacritics_count: diacriticsCount,
    };
  }

  // Check if any expected diacritics are present
  if (!expectedDiacritics.test(fullText) && fullText.length > 20) {
    return {
      event_id: translatedEvent.id,
      title: translatedEvent.title,
      passed: false,
      code: "T9_STRIPPED",
      details: "No expected " + language + " diacritics found in text (" +
        fullText.length + " chars). Likely stripped to ASCII.",
      diacritics_count: diacriticsCount,
    };
  }

  // Check for ASCII substitutions in German
  if (language === "German") {
    // Check for common German ASCII substitutions: ue, ae, oe within words
    const uePattern = /(?<=[a-z])ue(?=[a-z])/i;
    const aePattern = /(?<=[a-z])ae(?=[a-z])/i;
    const oePattern = /(?<=[a-z])oe(?=[a-z])/i;
    if (uePattern.test(fullText) || aePattern.test(fullText) || oePattern.test(fullText)) {
      return {
        event_id: translatedEvent.id,
        title: translatedEvent.title,
        passed: false,
        code: "T9_STRIPPED",
        details: "ASCII diacritic substitutions detected in German text (ae/oe/ue instead of umlauts).",
        diacritics_count: diacriticsCount,
      };
    }
  }

  return {
    event_id: translatedEvent.id,
    title: translatedEvent.title,
    passed: true,
    code: null,
    details: "Diacritics check passed (" + diacriticsCount + " diacritics found)",
    diacritics_count: diacriticsCount,
  };
}

/**
 * Check if a translated event's text is still in English (untranslated).
 * Uses heuristic: if most words in the description match common English words
 * and the text lacks language-specific diacritics, it's likely untranslated.
 * Also checks title against the English source.
 */
export function isLikelyUntranslated(
  translatedEvent: TranslatedEvent,
  englishEvent: EnglishEvent,
  whitelist: Set<string> = CROSS_LANGUAGE_WHITELIST,
): boolean {
  // Direct title match (excluding whitelisted terms)
  const translatedTitle = translatedEvent.title;
  const englishTitle = englishEvent.title;

  // If title is identical to English and not a whitelisted term, likely untranslated
  if (translatedTitle === englishTitle) {
    const isWhitelisted = whitelist.has(translatedTitle);
    if (!isWhitelisted) return true;
  }

  // If description is identical to English, likely untranslated
  if (translatedEvent.description === englishEvent.description) {
    return true;
  }

  return false;
}

/**
 * Validate diacritics density for Portuguese text.
 * Returns the density (diacritics per character) and whether it meets the baseline.
 * Used by the PostToolUse hook to reject writes that strip diacritics.
 */
export function validatePortugueseDiacritics(
  text: string,
  baselineDensity?: number,
): { density: number; diacriticsCount: number; charCount: number; passed: boolean; details: string } {
  const charCount = text.length;
  const diacriticsCount = countDiacritics(text);
  const density = charCount > 0 ? diacriticsCount / charCount : 0;

  // Default baseline: Portuguese text typically has ~3-8% diacritics density
  const threshold = baselineDensity ?? 0.02; // 2% minimum

  if (density < threshold) {
    return {
      density,
      diacriticsCount,
      charCount,
      passed: false,
      details: "Diacritics density " + (density * 100).toFixed(2) + "% is below threshold " +
        (threshold * 100).toFixed(2) + "% (" + diacriticsCount + " diacritics in " + charCount + " chars)",
    };
  }

  return {
    density,
    diacriticsCount,
    charCount,
    passed: true,
    details: "Diacritics density " + (density * 100).toFixed(2) + "% meets threshold (" +
      diacriticsCount + " diacritics in " + charCount + " chars)",
  };
}

/**
 * Run all automated translation gates on a set of translated events.
 * Returns per-event results for T0 (structural) and T9 (diacritics).
 * T1-T8 (translation quality) require AI verification and are not run here.
 */
export function runTranslationAutomatedChecks(
  translatedEvents: TranslatedEvent[],
  englishEvents: EnglishEvent[],
  language: string,
): {
  t0Results: T0GateResult[];
  t9Results: T9GateResult[];
  automatedFailures: Array<{ id: string; title: string; gate: string; code: string; details: string }>;
} {
  const englishMap = new Map(englishEvents.map(e => [e.id, e]));
  const t0Results: T0GateResult[] = [];
  const t9Results: T9GateResult[] = [];
  const automatedFailures: Array<{ id: string; title: string; gate: string; code: string; details: string }> = [];

  for (const event of translatedEvents) {
    const englishEvent = englishMap.get(event.id);

    // T0: Structural check (baseEnVersion)
    if (englishEvent) {
      const t0 = runT0StructuralCheck(event, englishEvent);
      t0Results.push(t0);
      if (!t0.passed) {
        automatedFailures.push({
          id: event.id,
          title: event.title,
          gate: "T0",
          code: t0.code!,
          details: t0.details,
        });
      }
    }

    // T9: Diacritics check
    const t9 = runT9DiacriticsCheck(event, language);
    t9Results.push(t9);
    if (!t9.passed) {
      automatedFailures.push({
        id: event.id,
        title: event.title,
        gate: "T9",
        code: t9.code!,
        details: t9.details,
      });
    }
  }

  return { t0Results, t9Results, automatedFailures };
}

// ---------------------------------------------------------------------------
// Main verification function
// ---------------------------------------------------------------------------

/**
 * Verify translated UI strings against English source.
 *
 * Checks:
 * 1. Every English key has a corresponding entry in each target language
 * 2. Format specifiers match between English and translation
 * 3. Diacritics spot-check (T9) -- warns if expected diacritics are absent
 * 4. Swift dictionary syntax validity
 * 5. No untranslated English left in non-English sections
 */
export function verifyTranslations(input: TranslationVerifyInput): TranslationVerifyResult {
  const findings: VerifyFinding[] = [];
  const englishKeys = input.englishKeys;
  const englishKeyNames = Object.keys(englishKeys);

  for (const [language, translations] of Object.entries(input.translations)) {
    // Check 1: Key presence (AC4, AC7)
    for (const key of englishKeyNames) {
      if (!(key in translations)) {
        findings.push({
          language,
          key,
          gate: "key_presence",
          issue: "Key '" + key + "' missing from " + language + " translations",
          severity: "error",
        });
        continue; // Skip further checks for missing key
      }

      const englishValue = englishKeys[key];
      const translatedValue = translations[key];

      // Check 2: Format specifier match (AC4)
      const englishSpecifiers = extractFormatSpecifiers(englishValue);
      const translatedSpecifiers = extractFormatSpecifiers(translatedValue);
      if (englishSpecifiers.length !== translatedSpecifiers.length) {
        findings.push({
          language,
          key,
          gate: "T6_format_specifiers",
          issue: "Format specifier count mismatch: English has " + englishSpecifiers.length +
            " (" + englishSpecifiers.join(", ") + "), " + language + " has " +
            translatedSpecifiers.length + " (" + translatedSpecifiers.join(", ") + ")",
          severity: "error",
        });
      } else {
        // Check order matches
        for (let i = 0; i < englishSpecifiers.length; i++) {
          if (englishSpecifiers[i] !== translatedSpecifiers[i]) {
            findings.push({
              language,
              key,
              gate: "T6_format_specifiers",
              issue: "Format specifier order mismatch at position " + (i + 1) +
                ": English has '" + englishSpecifiers[i] + "', " + language +
                " has '" + translatedSpecifiers[i] + "'",
              severity: "error",
            });
          }
        }
      }

      // Check 4: Swift syntax validity (AC9)
      if (!isValidSwiftDictEntry(key, translatedValue)) {
        findings.push({
          language,
          key,
          gate: "swift_syntax",
          issue: "Invalid Swift dictionary syntax for key '" + key + "' in " + language,
          severity: "error",
        });
      }

      // Check 5: Untranslated English (value identical to English source)
      if (translatedValue === englishValue && translatedValue.length > 3) {
        // Short strings like "OK" might legitimately be the same
        findings.push({
          language,
          key,
          gate: "untranslated",
          issue: "Value for '" + key + "' in " + language + " is identical to English ('" +
            englishValue.slice(0, 50) + "'). Possible untranslated string.",
          severity: "warning",
        });
      }
    }

    // Check 3: Diacritics spot-check (T9) -- aggregate across all values
    const allValues = Object.values(translations).join(" ");
    const expectedDiacritics = LANGUAGE_DIACRITICS[language];
    if (expectedDiacritics && allValues.length > 20 && !expectedDiacritics.test(allValues)) {
      findings.push({
        language,
        key: "*",
        gate: "T9_diacritics",
        issue: language + " translations contain no expected diacritics characters. " +
          "Likely stripped or ASCII-substituted.",
        severity: "error",
      });
    }

    // Check for known ASCII substitutions (T9)
    const substitutions = DIACRITIC_SUBSTITUTIONS[language];
    if (substitutions) {
      for (const [key, value] of Object.entries(translations)) {
        for (const pattern of substitutions) {
          if (pattern.test(value)) {
            findings.push({
              language,
              key,
              gate: "T9_diacritics",
              issue: "Possible ASCII substitution for diacritics in '" + key +
                "': '" + value.slice(0, 80) + "'",
              severity: "warning",
            });
          }
        }
      }
    }
  }

  const errors = findings.filter(f => f.severity === "error");
  const warnings = findings.filter(f => f.severity === "warning");
  const passed = errors.length === 0;

  const summary = "Verification " + (passed ? "PASSED" : "FAILED") +
    ": " + errors.length + " error(s), " + warnings.length + " warning(s) across " +
    Object.keys(input.translations).length + " language(s)";

  return { passed, findings, summary };
}
