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

import * as path from "node:path";

// ---------------------------------------------------------------------------
// Category registry
// ---------------------------------------------------------------------------

/**
 * Maps category display name -> JSON file name (without path).
 *
 * These correspond to the files in the game repo's Data/Events/ directory.
 * Category names come from triage extraction / issue labels and match
 * the HistoryCategory enum rawValues in Models/GameModels.swift.
 */
const CATEGORY_FILE_MAP: Record<string, string> = {
  // --- 8 Free categories ---
  "US History": "USHistory.json",
  "World Wars": "WorldWars.json",
  "Scientific Discoveries": "ScientificDiscoveries.json",
  "Music & Entertainment": "MusicEntertainment.json",
  "Sports History": "SportsHistory.json",
  "Ancient Civilizations": "AncientCivilizations.json",
  "European History": "EuropeanHistory.json",
  "TV History": "TVHistory.json",

  // --- 2 Explorer categories ---
  "Food & Drink": "FoodAndDrink.json",
  "Portuguese History": "PortugueseHistory.json",

  // --- 2 Historian categories ---
  "German History": "GermanHistory.json",
  "Women's History": "WomensHistory.json",

  // --- Unreleased / expansion categories ---
  "Medieval History": "MedievalHistory.json",
  "Medical Breakthroughs": "MedicalBreakthroughs.json",
  "Space Exploration": "SpaceExploration.json",
  "Film History": "FilmHistory.json",
  "Economic Events": "EconomicEvents.json",
  "Technological Inventions": "TechnologicalInventions.json",
  "Political Events": "PoliticalEvents.json",
  "Religious Events": "ReligiousEvents.json",
  "Natural Disasters": "NaturalDisasters.json",
  "Revolutions & Independence": "RevolutionsIndependence.json",
  "Artists & Literature": "ArtistsLiterature.json",
  "African History": "AfricanHistory.json",
  "Asian History": "AsianHistory.json",
  "South American History": "SouthAmericanHistory.json",
  "LGBTQ History": "LGBTQHistory.json",
  "Black History": "BlackHistory.json",
  "Animal History": "AnimalHistory.json",
  "Geography History": "GeographyHistory.json",
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
  return path.join(gameRepoPath, "Data", "Events", fileName);
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
