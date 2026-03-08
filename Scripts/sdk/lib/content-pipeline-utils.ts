/**
 * Story 2.3b: Content Pipeline Utility Functions
 *
 * Shared helpers for the content verification/fix pipeline:
 *
 * - detectStaleTranslations (FR43): After an English source event's version
 *   is incremented, check DE/NL/PT translations and flag any where
 *   baseEnVersion < the new version.
 *
 * - checkCategoryBackfill (FR18): After a category move, check if the source
 *   category dropped below its minimum event count (100 for base, 500 for epic).
 *   If so, return a backfill flag for inclusion in the next digest.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getMinEventCount, isEpicCategory } from "./categories.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** A translation file that is stale relative to the English source */
export interface StaleTranslation {
  /** Language code (e.g., "de", "nl", "pt") */
  lang: string;
  /** Event title in the translation */
  eventTitle: string;
  /** The translation's baseEnVersion */
  baseEnVersion: number;
  /** The current English source version */
  currentEnVersion: number;
  /** Path to the translation file */
  filePath: string;
}

/** Result of stale translation detection */
export interface StaleTranslationResult {
  /** Whether any stale translations were found */
  hasStale: boolean;
  /** List of stale translations by language */
  staleByLang: Record<string, StaleTranslation[]>;
  /** Total count of stale translations across all languages */
  totalStale: number;
  /** Languages checked */
  languagesChecked: string[];
}

/** Backfill requirement after a category move */
export interface BackfillFlag {
  /** Category that needs backfill */
  category: string;
  /** Current event count after the move */
  currentCount: number;
  /** Minimum required event count */
  minimumRequired: number;
  /** Number of events short */
  deficit: number;
  /** Human-readable action description */
  actionRequired: string;
}

/** Result of category backfill check */
export interface BackfillCheckResult {
  /** Whether backfill is needed */
  needsBackfill: boolean;
  /** Backfill details (null if not needed) */
  flag: BackfillFlag | null;
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Languages to check for stale translations (FR43) */
const TRANSLATION_LANGUAGES = ["de", "nl", "pt"] as const;

// ------------------------------------------------------------------
// FR43: Stale Translation Detection
// ------------------------------------------------------------------

/**
 * After an English source event's version is incremented, check translations
 * in DE/NL/PT and flag any where baseEnVersion < the new English version.
 *
 * @param eventTitle - The English event title that was modified
 * @param newEnVersion - The new version of the English event after fix
 * @param translationsDir - Path to the translations directory (e.g., Data/translations/)
 * @param categoryFileName - The category JSON file name (e.g., "USHistory.json")
 * @returns StaleTranslationResult with details of stale translations
 */
export function detectStaleTranslations(
  eventTitle: string,
  newEnVersion: number,
  translationsDir: string,
  categoryFileName: string,
): StaleTranslationResult {
  const result: StaleTranslationResult = {
    hasStale: false,
    staleByLang: {},
    totalStale: 0,
    languagesChecked: [],
  };

  for (const lang of TRANSLATION_LANGUAGES) {
    const transFilePath = path.join(translationsDir, lang, categoryFileName);
    result.languagesChecked.push(lang);

    if (!fs.existsSync(transFilePath)) {
      // Translation file does not exist for this language -- skip
      continue;
    }

    let transData: {
      events?: Array<{
        title: string;
        baseEnVersion?: number;
      }>;
    };

    try {
      const raw = fs.readFileSync(transFilePath, "utf-8");
      transData = JSON.parse(raw) as typeof transData;
    } catch {
      // Could not read/parse translation file -- skip
      continue;
    }

    if (!transData.events) continue;

    const staleEntries: StaleTranslation[] = [];

    for (const transEvent of transData.events) {
      // Match by title (translations may have different titles, but
      // baseEnVersion tracks the English source version)
      const baseVer = transEvent.baseEnVersion ?? 0;

      if (baseVer < newEnVersion) {
        staleEntries.push({
          lang,
          eventTitle: transEvent.title,
          baseEnVersion: baseVer,
          currentEnVersion: newEnVersion,
          filePath: transFilePath,
        });
      }
    }

    if (staleEntries.length > 0) {
      result.staleByLang[lang] = staleEntries;
      result.totalStale += staleEntries.length;
      result.hasStale = true;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// FR18: Category Backfill Check
// ------------------------------------------------------------------

/**
 * After a content fix that involves moving an event to a different category,
 * check if the source category dropped below its minimum event count.
 *
 * Base categories require >= 100 events.
 * Epic categories require >= 500 events.
 *
 * @param category - The source category name (e.g., "US History")
 * @param categoryFilePath - Absolute path to the category JSON file
 * @returns BackfillCheckResult indicating whether backfill is needed
 */
export function checkCategoryBackfill(
  category: string,
  categoryFilePath: string,
): BackfillCheckResult {
  const minRequired = getMinEventCount(category);

  if (minRequired === 0) {
    // Unknown category -- cannot determine minimum
    return { needsBackfill: false, flag: null };
  }

  let eventCount: number;
  try {
    const raw = fs.readFileSync(categoryFilePath, "utf-8");
    const data = JSON.parse(raw) as { events?: unknown[] };
    eventCount = Array.isArray(data.events) ? data.events.length : 0;
  } catch {
    // Cannot read the file -- cannot determine backfill need
    return { needsBackfill: false, flag: null };
  }

  if (eventCount >= minRequired) {
    return { needsBackfill: false, flag: null };
  }

  const deficit = minRequired - eventCount;
  return {
    needsBackfill: true,
    flag: {
      category,
      currentCount: eventCount,
      minimumRequired: minRequired,
      deficit,
      actionRequired:
        "Create " + deficit + " replacement event(s) for " + category +
        " (currently " + eventCount + ", minimum " + minRequired + ")",
    },
  };
}
