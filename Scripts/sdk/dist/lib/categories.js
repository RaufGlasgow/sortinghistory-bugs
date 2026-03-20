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
const CATEGORY_FILE_MAP = {
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
    // --- 5 Epic / Expansion categories (Historian-only, 500+ events) ---
    "US History Epic": "USHistory-Expansion1.json",
    "World Wars Epic": "WorldWars-Expansion1.json",
    "Sports History Epic": "SportsHistory-Expansion1.json",
    "Film History Epic": "FilmHistory-Expansion1.json",
    "TV History Epic": "TVHistory-Expansion1.json",
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
// Reverse map: file name (without extension) -> category display name
// ---------------------------------------------------------------------------
const FILE_TO_CATEGORY_MAP = {};
for (const [category, fileName] of Object.entries(CATEGORY_FILE_MAP)) {
    const baseName = fileName.replace(/\.json$/, "");
    FILE_TO_CATEGORY_MAP[baseName] = category;
}
// ---------------------------------------------------------------------------
// Epic category set and minimum event counts
// ---------------------------------------------------------------------------
/**
 * Set of Epic/Expansion category display names.
 * Epic categories are premium paid content (Historian-only) with 500+ events.
 * They are distinct registry entries, NOT extensions of base categories.
 */
const EPIC_CATEGORIES = new Set([
    "US History Epic",
    "World Wars Epic",
    "Sports History Epic",
    "Film History Epic",
    "TV History Epic",
]);
/** Minimum event count for Epic categories */
const EPIC_MIN_EVENTS = 500;
/** Minimum event count for base categories */
const BASE_MIN_EVENTS = 100;
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Look up the JSON file name for a given category display name.
 * Returns null if the category is unknown (AC7: does not crash).
 */
export function categoryToFileName(category) {
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
export function categoryToFilePath(category, gameRepoPath) {
    const fileName = categoryToFileName(category);
    if (!fileName)
        return null;
    return path.join(gameRepoPath, "Data", "Events", fileName);
}
/**
 * Check whether a category name is known.
 * Used for CI input validation (AC13).
 */
export function isKnownCategory(category) {
    return category in CATEGORY_FILE_MAP;
}
/**
 * Get all known category names.
 * Useful for error messages listing valid categories.
 */
export function allCategoryNames() {
    return Object.keys(CATEGORY_FILE_MAP);
}
/**
 * Reverse lookup: given a JSON file base name (without .json extension),
 * return the category display name.
 *
 * @param fileName - File base name, e.g. "WorldWars-Expansion1" or "USHistory"
 * @returns Category display name or null if not found
 */
export function fileNameToCategory(fileName) {
    // Strip .json extension if caller passed it
    const baseName = fileName.replace(/\.json$/, "");
    return FILE_TO_CATEGORY_MAP[baseName] ?? null;
}
/**
 * Check whether a category is an Epic/Expansion category.
 * Epic categories are premium paid content (Historian-only, 500+ events).
 */
export function isEpicCategory(category) {
    return EPIC_CATEGORIES.has(category);
}
/**
 * Get the minimum event count required for a category.
 * Epic categories require 500 events; base categories require 100.
 * Returns 0 if the category is unknown.
 */
export function getMinEventCount(category) {
    if (!isKnownCategory(category))
        return 0;
    return EPIC_CATEGORIES.has(category) ? EPIC_MIN_EVENTS : BASE_MIN_EVENTS;
}
