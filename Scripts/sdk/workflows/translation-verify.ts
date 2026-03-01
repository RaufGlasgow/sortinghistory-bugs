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
