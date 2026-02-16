/**
 * Story 2.4b: Category-to-File Registry (AC7)
 *
 * Maps every category display name to its JSON file name.
 * Used by both the verify and resume CI steps to resolve
 * the category from a dispatch payload to a file path.
 *
 * 30 categories mapped per Story 2.4 AC4 table.
 * Unknown category returns null (not crash).
 */

import * as path from "node:path";

// ---------------------------------------------------------------------------
// Category registry
// ---------------------------------------------------------------------------

/**
 * Maps category display name -> JSON file name (without path).
 *
 * These correspond to the files in the game repo's Data/ directory.
 * Category names come from triage extraction / issue labels.
 */
const CATEGORY_FILE_MAP: Record<string, string> = {
  // --- 8 Free categories ---
  "US History": "USHistoryEvents.json",
  "World Wars": "WorldWarsEvents.json",
  "Scientific Discoveries": "ScientificDiscoveriesEvents.json",
  "Music & Entertainment": "MusicEntertainmentEvents.json",
  "Sports History": "SportsHistoryEvents.json",
  "Ancient Civilizations": "AncientCivilizationsEvents.json",
  "European History": "EuropeanHistoryEvents.json",
  "TV History": "TVHistoryEvents.json",

  // --- 2 Explorer categories ---
  "Food & Drink": "FoodDrinkEvents.json",
  "Portuguese History": "PortugueseHistoryEvents.json",

  // --- 2 Historian categories ---
  "German History": "GermanHistoryEvents.json",
  "Women's History": "WomensHistoryEvents.json",

  // --- Unreleased / expansion categories ---
  "Medieval History": "MedievalHistoryEvents.json",
  "Medical Breakthroughs": "MedicalBreakthroughsEvents.json",
  "Space Exploration": "SpaceExplorationEvents.json",
  "Film History": "FilmHistoryEvents.json",
  "Economic Events": "EconomicEvents.json",
  "Art History": "ArtHistoryEvents.json",
  "Technology History": "TechnologyHistoryEvents.json",
  "Political History": "PoliticalHistoryEvents.json",
  "Religious History": "ReligiousHistoryEvents.json",
  "Environmental History": "EnvironmentalHistoryEvents.json",
  "Literary History": "LiteraryHistoryEvents.json",
  "Fashion History": "FashionHistoryEvents.json",
  "African History": "AfricanHistoryEvents.json",
  "Asian History": "AsianHistoryEvents.json",
  "Latin American History": "LatinAmericanHistoryEvents.json",
  "Middle Eastern History": "MiddleEasternHistoryEvents.json",
  "Australian History": "AustralianHistoryEvents.json",
  "Canadian History": "CanadianHistoryEvents.json",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up the JSON file name for a given category display name.
 * Returns null if the category is unknown (AC7: does not crash).
 */
export function categoryToFileName(category: string): string | null {
  return CATEGORY_FILE_MAP[category] ?? null;
}

/**
 * Resolve a category display name to a full file path within the game repo.
 * Returns null if the category is unknown.
 *
 * @param category - Category display name (e.g., "US History")
 * @param gameRepoPath - Absolute path to the game repo checkout
 * @returns Absolute file path or null
 */
export function categoryToFilePath(
  category: string,
  gameRepoPath: string,
): string | null {
  const fileName = categoryToFileName(category);
  if (!fileName) return null;
  return path.join(gameRepoPath, "Data", fileName);
}

/**
 * Check whether a category name is known.
 * Used for CI input validation (AC13).
 */
export function isKnownCategory(category: string): boolean {
  return category in CATEGORY_FILE_MAP;
}

/**
 * Get all known category names.
 * Useful for error messages listing valid categories.
 */
export function allCategoryNames(): string[] {
  return Object.keys(CATEGORY_FILE_MAP);
}
