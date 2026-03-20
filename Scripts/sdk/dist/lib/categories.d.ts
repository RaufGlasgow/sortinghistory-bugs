/**
 * Story 2.4b: Category-to-File Registry (AC7)
 *
 * Maps every category display name to its JSON file name.
 * Used by both the verify and resume CI steps to resolve
 * the category from a dispatch payload to a file path.
 *
 * 30 categories mapped per Story 2.4 AC4 table.
 * Display names match HistoryCategory enum rawValues in GameModels.swift.
 * Unknown category returns null (not crash).
 */
/**
 * Look up the JSON file name for a given category display name.
 * Returns null if the category is unknown (AC7: does not crash).
 */
export declare function categoryToFileName(category: string): string | null;
/**
 * Resolve a category display name to a full file path within the game repo.
 * Returns null if the category is unknown.
 *
 * @param category - Category display name (e.g., "US History")
 * @param gameRepoPath - Absolute path to the game repo checkout
 * @returns Absolute file path or null
 */
export declare function categoryToFilePath(category: string, gameRepoPath: string): string | null;
/**
 * Check whether a category name is known.
 * Used for CI input validation (AC13).
 */
export declare function isKnownCategory(category: string): boolean;
/**
 * Get all known category names.
 * Useful for error messages listing valid categories.
 */
export declare function allCategoryNames(): string[];
/**
 * Reverse lookup: given a JSON file base name (without .json extension),
 * return the category display name.
 *
 * @param fileName - File base name, e.g. "WorldWars-Expansion1" or "USHistory"
 * @returns Category display name or null if not found
 */
export declare function fileNameToCategory(fileName: string): string | null;
/**
 * Check whether a category is an Epic/Expansion category.
 * Epic categories are premium paid content (Historian-only, 500+ events).
 */
export declare function isEpicCategory(category: string): boolean;
/**
 * Get the minimum event count required for a category.
 * Epic categories require 500 events; base categories require 100.
 * Returns 0 if the category is unknown.
 */
export declare function getMinEventCount(category: string): number;
