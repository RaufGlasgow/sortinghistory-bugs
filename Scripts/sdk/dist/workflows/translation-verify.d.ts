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
/**
 * T0 Structural Gate: Check if translation baseEnVersion matches English version.
 * This is an automated check, not an AI check.
 */
export declare function runT0StructuralCheck(translatedEvent: TranslatedEvent, englishEvent: EnglishEvent): T0GateResult;
/** Count diacritics characters in a string */
export declare function countDiacritics(text: string): number;
/**
 * T9 Diacritics Gate: Check if translated event has expected diacritics for language.
 * Verifies diacritics are present and not stripped to ASCII substitutes.
 */
export declare function runT9DiacriticsCheck(translatedEvent: TranslatedEvent, language: string): T9GateResult;
/**
 * Check if a translated event's text is still in English (untranslated).
 * Uses heuristic: if most words in the description match common English words
 * and the text lacks language-specific diacritics, it's likely untranslated.
 * Also checks title against the English source.
 */
export declare function isLikelyUntranslated(translatedEvent: TranslatedEvent, englishEvent: EnglishEvent, whitelist?: Set<string>): boolean;
/**
 * Validate diacritics density for Portuguese text.
 * Returns the density (diacritics per character) and whether it meets the baseline.
 * Used by the PostToolUse hook to reject writes that strip diacritics.
 */
export declare function validatePortugueseDiacritics(text: string, baselineDensity?: number): {
    density: number;
    diacriticsCount: number;
    charCount: number;
    passed: boolean;
    details: string;
};
/**
 * Run all automated translation gates on a set of translated events.
 * Returns per-event results for T0 (structural) and T9 (diacritics).
 * T1-T8 (translation quality) require AI verification and are not run here.
 */
export declare function runTranslationAutomatedChecks(translatedEvents: TranslatedEvent[], englishEvents: EnglishEvent[], language: string): {
    t0Results: T0GateResult[];
    t9Results: T9GateResult[];
    automatedFailures: Array<{
        id: string;
        title: string;
        gate: string;
        code: string;
        details: string;
    }>;
};
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
export declare function verifyTranslations(input: TranslationVerifyInput): TranslationVerifyResult;
