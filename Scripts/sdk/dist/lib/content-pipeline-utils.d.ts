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
/**
 * After an English source event's version is incremented, check translations
 * in DE/NL/PT and flag any where baseEnVersion < the new English version.
 *
 * FR43 / AC6: When eventTitle is provided, only flags translations of that
 * specific event (matched by array index -- translations maintain the same
 * event order as the English source file). This ensures we flag only the
 * translations that need updating due to a specific English event change,
 * not all events in the category.
 *
 * @param eventTitle - The English event title that was modified (used for
 *   index-based matching: finds the event at the same array position in each
 *   translation file)
 * @param newEnVersion - The new version of the English event after fix
 * @param translationsDir - Path to the translations directory (e.g., Data/translations/)
 * @param categoryFileName - The category JSON file name (e.g., "USHistory.json")
 * @param options - Optional: eventIndex to directly specify which event index to check
 * @returns StaleTranslationResult with details of stale translations
 */
export declare function detectStaleTranslations(eventTitle: string, newEnVersion: number, translationsDir: string, categoryFileName: string, options?: {
    eventIndex?: number;
}): StaleTranslationResult;
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
export declare function checkCategoryBackfill(category: string, categoryFilePath: string): BackfillCheckResult;
