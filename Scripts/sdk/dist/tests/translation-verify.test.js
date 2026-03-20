/**
 * BA-008.2: Translation verification tests.
 *
 * Tests verifyTranslations() for:
 *   - Key presence checking (AC4)
 *   - Format specifier matching (AC4)
 *   - Diacritics detection (T9)
 *   - Swift syntax validation (AC9)
 *   - Untranslated string detection
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { verifyTranslations } from "../workflows/translation-verify.js";
describe("verifyTranslations", () => {
    it("passes when all keys present and correct", () => {
        const input = {
            englishKeys: {
                "daily_challenge_title": "Daily Challenge",
                "daily_challenge_play": "Play Today's Challenge",
            },
            translations: {
                Portuguese: {
                    "daily_challenge_title": "Desafio Di\u00e1rio",
                    "daily_challenge_play": "Jogar o Desafio de Hoje",
                },
                German: {
                    "daily_challenge_title": "T\u00e4gliche Herausforderung",
                    "daily_challenge_play": "Heutige Herausforderung spielen",
                },
            },
        };
        const result = verifyTranslations(input);
        assert.equal(result.passed, true, "Should pass: " + result.summary);
    });
    it("fails when key is missing from a language (AC4)", () => {
        const input = {
            englishKeys: {
                "daily_challenge_title": "Daily Challenge",
                "daily_challenge_play": "Play Today's Challenge",
            },
            translations: {
                Portuguese: {
                    "daily_challenge_title": "Desafio Di\u00e1rio",
                    // missing daily_challenge_play
                },
            },
        };
        const result = verifyTranslations(input);
        assert.equal(result.passed, false);
        const keyFinding = result.findings.find(f => f.gate === "key_presence");
        assert.ok(keyFinding, "Should have a key_presence finding");
        assert.equal(keyFinding.key, "daily_challenge_play");
        assert.equal(keyFinding.language, "Portuguese");
    });
    it("fails when format specifier count mismatches (AC4)", () => {
        const input = {
            englishKeys: {
                "score_display": "Score: %d points",
            },
            translations: {
                Spanish: {
                    "score_display": "Puntuaci\u00f3n: puntos", // missing %d
                },
            },
        };
        const result = verifyTranslations(input);
        assert.equal(result.passed, false);
        const specFinding = result.findings.find(f => f.gate === "T6_format_specifiers");
        assert.ok(specFinding, "Should have a T6 finding");
    });
    it("passes when format specifiers match", () => {
        const input = {
            englishKeys: {
                "events_count": "%d events",
            },
            translations: {
                Portuguese: {
                    "events_count": "%d eventos",
                },
            },
        };
        const result = verifyTranslations(input);
        const specFindings = result.findings.filter(f => f.gate === "T6_format_specifiers");
        assert.equal(specFindings.length, 0, "Should have no format specifier errors");
    });
    it("warns when translation is identical to English (untranslated)", () => {
        const input = {
            englishKeys: {
                "daily_challenge_title": "Daily Challenge",
            },
            translations: {
                German: {
                    "daily_challenge_title": "Daily Challenge", // not translated
                },
            },
        };
        const result = verifyTranslations(input);
        const untranslated = result.findings.find(f => f.gate === "untranslated");
        assert.ok(untranslated, "Should warn about untranslated string");
        assert.equal(untranslated.severity, "warning");
    });
    it("detects missing diacritics in German (T9)", () => {
        const input = {
            englishKeys: {
                "daily_challenge_title": "Daily Challenge",
                "daily_challenge_play": "Play Challenge",
            },
            translations: {
                German: {
                    "daily_challenge_title": "Tagliche Herausforderung", // missing umlaut
                    "daily_challenge_play": "Herausforderung spielen",
                },
            },
        };
        const result = verifyTranslations(input);
        const diacriticsFinding = result.findings.find(f => f.gate === "T9_diacritics");
        assert.ok(diacriticsFinding, "Should flag missing German diacritics");
    });
    it("passes diacritics check when proper characters present", () => {
        const input = {
            englishKeys: {
                "daily_challenge_title": "Daily Challenge",
                "daily_challenge_play": "Play Challenge",
            },
            translations: {
                German: {
                    "daily_challenge_title": "T\u00e4gliche Herausforderung", // proper umlaut
                    "daily_challenge_play": "Herausforderung f\u00fcr heute",
                },
            },
        };
        const result = verifyTranslations(input);
        const diacriticsErrors = result.findings.filter(f => f.gate === "T9_diacritics" && f.severity === "error");
        assert.equal(diacriticsErrors.length, 0, "Should not flag proper German diacritics");
    });
    it("validates Swift syntax (AC9)", () => {
        const input = {
            englishKeys: {
                "test_key": "test value",
            },
            translations: {
                Spanish: {
                    "test_key": 'valor con "comillas" sin escapar', // unescaped quotes
                },
            },
        };
        const result = verifyTranslations(input);
        const syntaxFinding = result.findings.find(f => f.gate === "swift_syntax");
        assert.ok(syntaxFinding, "Should flag invalid Swift syntax");
    });
    it("handles multiple languages with mixed results", () => {
        const input = {
            englishKeys: {
                "daily_challenge_title": "Daily Challenge",
            },
            translations: {
                Portuguese: {
                    "daily_challenge_title": "Desafio Di\u00e1rio",
                },
                Spanish: {
                // key missing
                },
                German: {
                    "daily_challenge_title": "T\u00e4gliche Herausforderung",
                },
            },
        };
        const result = verifyTranslations(input);
        assert.equal(result.passed, false);
        const keyFindings = result.findings.filter(f => f.gate === "key_presence");
        assert.equal(keyFindings.length, 1);
        assert.equal(keyFindings[0].language, "Spanish");
    });
});
