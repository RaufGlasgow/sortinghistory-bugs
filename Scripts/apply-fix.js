/**
 * Bug Fix Application Script
 *
 * BUG-006: Automated Fix Creation
 * BA-004.2: Content Bug Auto-Fix
 * BA-004.3: Code Bug Fix Generation
 *
 * Reads the AI analysis from the issue, parses the suggested fix,
 * and applies changes to the codebase.
 *
 * For CONTENT bugs: Directly modifies JSON files with validation
 * For CODE bugs: Uses Claude Opus to generate actual code changes
 *
 * Content fixes include:
 * - Date correction (year, month, day)
 * - Text replacement (title, description)
 * - Category reassignment
 * - Post-modification JSON validation
 * - Validation failure handling (needs-manual-review label)
 *
 * NOTE: Auto-merge has been removed (QG-003).
 * All fixes require manual review and merge.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Environment
const GITHUB_TOKEN = process.env.PRIVATE_REPO_TOKEN || process.env.GITHUB_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const FIX_TYPE = process.env.FIX_TYPE;
const GITHUB_REPOSITORY = process.env.PRIVATE_REPO_NAME || process.env.GITHUB_REPOSITORY;

// Retry context (Story 1.2 — rejection retry with failure context)
const IS_RETRY = process.env.RETRY === 'true';
const ATTEMPT_NUMBER = parseInt(process.env.ATTEMPT, 10) || 1;
const PREVIOUS_FIX_SUMMARY = process.env.PREVIOUS_FIX_SUMMARY || '';
const REJECTION_REASON = process.env.REJECTION_REASON || '';

// Debug: log resolved env vars so future failures are diagnosable
console.log(`Repository: ${GITHUB_REPOSITORY}`);
console.log(`Token present: ${!!GITHUB_TOKEN}`);

// OpenRouter configuration
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// BA-008.9: Configurable model IDs via environment variables with hardcoded fallback defaults
const FIX_MODEL = process.env.FIX_MODEL || 'anthropic/claude-opus-4.6';
const QA_MODEL = process.env.QA_MODEL || 'openai/gpt-5.2-codex';
const RCA_MODEL = process.env.RCA_MODEL || 'anthropic/claude-opus-4.6';
const FACT_CHECK_MODEL = process.env.FACT_CHECK_MODEL || 'moonshotai/kimi-k2.5';

// Legacy alias: CODE_MODEL used throughout the file, now reads from FIX_MODEL
const CODE_MODEL = FIX_MODEL;

// BA-008.9: Inner loop configuration
const MAX_INNER_ITERATIONS = 3;
const MAX_LOOP_TIME_MS = 15 * 60 * 1000; // 15 minutes wall-clock timeout for entire inner loop

// Paths
const DATA_EVENTS_PATH = 'Data/Events';
const SETTINGS_VIEW_PATH = 'Views/SettingsView.swift';

// BA-008.3: Architecture context registry path (relative to script location)
const ARCHITECTURE_REGISTRY_PATH = path.join(__dirname, 'context', 'architecture-registry.json');

// BA-008.3: Module-level storage for architecture context (populated by gatherRelevantContext,
// consumed by buildCodeFixPrompt). Graceful default: empty notes and behaviors.
let _architectureNotes = [];
let _relevantBehaviors = {};

// Required fields for content event validation (AC2)
const REQUIRED_EVENT_FIELDS = ['title', 'year', 'description'];

// BA-008.4: RCA configuration
const RCA_TIMEOUT_MS = 60000;     // 60 seconds timeout for RCA call
const RCA_MAX_TOKENS = 2000;
const RCA_TEMPERATURE = 0.3;
const CODE_GEN_TEMPERATURE = 0;   // Deterministic output for code generation
const HARD_CAP_CHARS = 150000;    // 150K character hard cap on total prompt

// Context gathering limits (QG-005 / BA-007.8)
const PRIMARY_FILE_LIMIT = 20000;    // Primary fix target
const SECONDARY_FILE_LIMIT = 12000;  // Related files (keyword match, explicit paths)
const REFERENCE_FILE_LIMIT = 8000;   // Always-included reference files
const TOTAL_CONTEXT_LIMIT = 80000;   // Hard cap across all files

/**
 * Read a file with a character limit, appending a truncation marker if cut.
 * Truncates at the last newline before the limit to avoid cutting mid-line.
 * BA-007.23: Context Truncation Awareness
 */
function readFileWithLimit(filePath, limit) {
  const fullContent = fs.readFileSync(filePath, 'utf8');
  if (fullContent.length <= limit) {
    return fullContent;  // No truncation needed
  }
  // Truncate at last newline before limit to avoid cutting mid-line
  const truncated = fullContent.substring(0, limit);
  const lastNewline = truncated.lastIndexOf('\n');
  const cleanTruncated = lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated;
  return cleanTruncated + `\n\n// ... [TRUNCATED — showing ${cleanTruncated.length} of ${fullContent.length} chars] ...`;
}

/**
 * BA-008.3: Load the architecture context registry.
 * Returns the parsed registry object, or null if the file is missing or malformed.
 * Graceful fallback: never throws — logs a warning and returns null.
 */
function loadArchitectureRegistry() {
  try {
    if (!fs.existsSync(ARCHITECTURE_REGISTRY_PATH)) {
      console.log('[ARCH] Architecture registry not found at ' + ARCHITECTURE_REGISTRY_PATH + ' — skipping');
      return null;
    }
    const raw = fs.readFileSync(ARCHITECTURE_REGISTRY_PATH, 'utf8');
    const registry = JSON.parse(raw);
    if (!registry.views || !registry.services || !registry.swiftui_behaviors) {
      console.warn('[ARCH] Registry loaded but missing required sections (views/services/swiftui_behaviors) — skipping');
      return null;
    }
    console.log(`[ARCH] Architecture registry loaded: ${Object.keys(registry.views).length} views, ${Object.keys(registry.services).length} services, ${Object.keys(registry.swiftui_behaviors).length} behaviors`);
    return registry;
  } catch (e) {
    console.warn(`[ARCH] Failed to load architecture registry: ${e.message} — falling back to default behavior`);
    return null;
  }
}

/**
 * BA-008.3: Given the set of files already gathered, look up each in the
 * architecture registry and return additional files that should be force-included
 * (embeds, viewModel, consumers). Also returns architecture notes (stateFlow,
 * runtimeNotes) and relevant swiftui_behaviors for prompt injection.
 *
 * @param {Object} registry - The loaded architecture registry
 * @param {Object} contextFiles - Map of filePath -> content already gathered
 * @returns {{ additionalFiles: string[], archNotes: string[], relevantBehaviors: Object }}
 */
function getArchitectureContext(registry, contextFiles) {
  const additionalFiles = [];
  const archNotes = [];
  const relevantBehaviorKeys = new Set();

  const allContextPaths = Object.keys(contextFiles);

  for (const filePath of allContextPaths) {
    // Check views section
    const viewEntry = registry.views[filePath];
    if (viewEntry) {
      // Force-include embeds
      if (viewEntry.embeds && Array.isArray(viewEntry.embeds)) {
        for (const embed of viewEntry.embeds) {
          if (!contextFiles[embed] && !additionalFiles.includes(embed)) {
            additionalFiles.push(embed);
          }
        }
      }
      // Force-include viewModel
      if (viewEntry.viewModel && !contextFiles[viewEntry.viewModel] && !additionalFiles.includes(viewEntry.viewModel)) {
        additionalFiles.push(viewEntry.viewModel);
      }
      // Collect stateFlow notes
      if (viewEntry.stateFlow && Array.isArray(viewEntry.stateFlow)) {
        archNotes.push(`### ${filePath} — State Flow`);
        for (const note of viewEntry.stateFlow) {
          archNotes.push(`- ${note}`);
        }
      }
      // Collect runtimeNotes
      if (viewEntry.runtimeNotes && Array.isArray(viewEntry.runtimeNotes)) {
        archNotes.push(`### ${filePath} — Runtime Notes`);
        for (const note of viewEntry.runtimeNotes) {
          archNotes.push(`- ${note}`);
        }
      }
    }

    // Check services section
    const serviceEntry = registry.services[filePath];
    if (serviceEntry) {
      // Force-include consumers
      if (serviceEntry.consumers && Array.isArray(serviceEntry.consumers)) {
        for (const consumer of serviceEntry.consumers) {
          if (!contextFiles[consumer] && !additionalFiles.includes(consumer)) {
            additionalFiles.push(consumer);
          }
        }
      }
      // Collect service notes
      if (serviceEntry.notes && Array.isArray(serviceEntry.notes)) {
        archNotes.push(`### ${filePath} — Service Notes`);
        for (const note of serviceEntry.notes) {
          archNotes.push(`- ${note}`);
        }
      }
    }
  }

  // Determine which swiftui_behaviors are relevant based on file content keywords
  // Map behavior keys to content patterns that indicate relevance
  const behaviorPatterns = {
    'onAppear_in_ScrollView': ['.onAppear', 'ScrollView'],
    'alert_collision': ['.alert(isPresented', 'isPresented'],
    'state_vs_appstorage': ['@AppStorage', '@State'],
    'binding_propagation': ['@Binding', '.alert(isPresented'],
    'environmentobject_crash': ['@EnvironmentObject', '.sheet(', '.fullScreenCover('],
    'geometryreader_sizing': ['GeometryReader', 'geometry.size'],
    'published_existential_limitation': ['@Published', 'any ', 'willSet']
  };

  // Scan all context file contents for matching patterns
  const allContent = Object.values(contextFiles).join('\n');
  for (const [behaviorKey, patterns] of Object.entries(behaviorPatterns)) {
    if (patterns.some(p => allContent.includes(p))) {
      relevantBehaviorKeys.add(behaviorKey);
    }
  }

  // Also check arch notes text for behavior relevance (e.g., runtimeNotes mentioning .onAppear)
  const archNotesText = archNotes.join('\n');
  for (const [behaviorKey, patterns] of Object.entries(behaviorPatterns)) {
    if (patterns.some(p => archNotesText.includes(p))) {
      relevantBehaviorKeys.add(behaviorKey);
    }
  }

  // Build the relevant behaviors subset
  const relevantBehaviors = {};
  for (const key of relevantBehaviorKeys) {
    if (registry.swiftui_behaviors[key]) {
      relevantBehaviors[key] = registry.swiftui_behaviors[key];
    }
  }

  return { additionalFiles, archNotes, relevantBehaviors };
}

// QG-001: Build validation timeout (3 minutes)
const BUILD_TIMEOUT_MS = 180000;

/**
 * Fetch issue details including comments
 */
async function fetchIssueWithComments() {
  const [owner, repo] = GITHUB_REPOSITORY.split('/');

  // Fetch issue
  const issueResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SortingHistory-AutoFix',
      },
    }
  );

  if (!issueResponse.ok) {
    throw new Error(`Failed to fetch issue: ${issueResponse.status}`);
  }

  const issue = await issueResponse.json();

  // Fetch comments
  const commentsResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SortingHistory-AutoFix',
      },
    }
  );

  const comments = await commentsResponse.json();

  return { issue, comments };
}

/**
 * Extract suggested fix from AI analysis comment
 */
function extractSuggestedFix(comments) {
  // Find the AI analysis comment
  const analysisComment = comments.find(
    (c) => c.body && c.body.includes('## AI Bug Analysis') && c.body.includes('Auto-Fix Data')
  );

  if (!analysisComment) {
    console.log('No AI analysis comment found with fix data');
    return null;
  }

  // Extract JSON from the Auto-Fix Data section
  const jsonMatch = analysisComment.body.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    console.log('No JSON fix data found in analysis comment');
    return null;
  }

  try {
    return JSON.parse(jsonMatch[1]);
  } catch (e) {
    console.error('Failed to parse fix JSON:', e.message);
    return null;
  }
}

/**
 * BA-008.2 P1-8: Validate pre-analysis from issue comments before injecting
 * into the code fix prompt. Filters out low-quality analysis that contains
 * hedge language or references non-existent files.
 */
function validatePreAnalysis(analysis, gameCodePath) {
  if (!analysis) {
    return { valid: false, reason: 'No analysis provided' };
  }

  const analysisStr = JSON.stringify(analysis);

  if (analysisStr.trim().length === 0) {
    return { valid: false, reason: 'Empty analysis' };
  }

  const hedgePatterns = [
    /or similar file/i,
    /something like/i,
    /probably in/i,
    /might be in/i,
    /could be in/i,
    /I think the file is/i,
    /I'm not sure/i,
  ];

  for (const pattern of hedgePatterns) {
    if (pattern.test(analysisStr)) {
      const matched = analysisStr.match(pattern);
      return { valid: false, reason: `Contains hedge language: "${matched[0]}"` };
    }
  }

  const filePathPattern = /(?:^|\s)([\w\/]+\.swift)(?:\s|$|,|:|")/gm;
  let match;
  while ((match = filePathPattern.exec(analysisStr)) !== null) {
    const filePath = match[1];
    const fullPath = path.join(gameCodePath, filePath);
    if (!fs.existsSync(fullPath)) {
      const basename = path.basename(filePath);
      const found = findFileInDirs(gameCodePath, basename);
      if (!found) {
        return { valid: false, reason: `References non-existent file: ${filePath}` };
      }
    }
  }

  return { valid: true };
}

function findFileInDirs(rootDir, targetBasename) {
  const searchDirs = ['Views', 'ViewModels', 'Models', 'Features', 'Core', 'Network', 'Data'];
  for (const dir of searchDirs) {
    const fullDir = path.join(rootDir, dir);
    if (!fs.existsSync(fullDir)) continue;
    const result = findFileRecursiveInDir(fullDir, targetBasename);
    if (result) return result;
  }
  return null;
}

function findFileRecursiveInDir(dir, targetBasename) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileRecursiveInDir(fullPath, targetBasename);
        if (found) return found;
      } else if (entry.name === targetBasename) {
        return fullPath;
      }
    }
  } catch (e) {
    // Directory not readable, skip
  }
  return null;
}

/**
 * BA-008.4: Extract expected and actual behavior from the issue body.
 * Looks for markdown fields like "**Expected behavior:**" and "**Actual behavior:**".
 * Returns { expected: string|null, actual: string|null, warning: string|null }
 */
function extractExpectedActualBehavior(issueBody) {
  if (!issueBody) {
    return {
      expected: null,
      actual: null,
      warning: 'WARNING: No expected behavior specified. The fix may address symptoms without achieving the desired outcome.'
    };
  }

  // Match "**Expected behavior:**" followed by content until the next "**" header or end
  const expectedMatch = issueBody.match(/\*\*Expected behavior[:\s]*\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/i);
  const actualMatch = issueBody.match(/\*\*Actual behavior[:\s]*\*\*\s*([\s\S]*?)(?=\n\*\*|\n##|$)/i);

  const expected = expectedMatch ? expectedMatch[1].trim() : null;
  const actual = actualMatch ? actualMatch[1].trim() : null;

  let warning = null;
  if (!expected && !actual) {
    warning = 'WARNING: No expected behavior specified. The fix may address symptoms without achieving the desired outcome.';
  } else if (!expected) {
    warning = 'WARNING: No expected behavior specified. The fix may address symptoms without achieving the desired outcome.';
  }

  return { expected, actual, warning };
}

/**
 * BA-008.4: Perform Root Cause Analysis via a separate API call.
 * Returns the parsed RCA object on success, or null on failure (with fallback warning).
 *
 * RCA is only performed for code/ux fix types, NOT content fixes.
 *
 * @param {Object} issue - The GitHub issue object
 * @param {Object} suggestedFix - The extracted suggested fix (may be null)
 * @param {Object} relevantFiles - Map of filePath -> content
 * @param {Object} behaviorInfo - { expected, actual, warning } from extractExpectedActualBehavior
 * @returns {Object|null} Parsed RCA JSON or null on failure
 */
async function performRCA(issue, suggestedFix, relevantFiles, behaviorInfo) {
  console.log('\n--- Root Cause Analysis (BA-008.4) ---');

  // Build context section for RCA
  let contextSection = '';
  for (const [file, content] of Object.entries(relevantFiles)) {
    const isPrimary = suggestedFix?.file === file || (issue.body && issue.body.includes(file));
    const marker = isPrimary ? ' (PRIMARY FIX TARGET)' : '';
    contextSection += `\n### ${file}${marker}\n\`\`\`swift\n${content}\n\`\`\`\n`;
  }

  // Build behavior section
  let behaviorSection = '';
  if (behaviorInfo.expected || behaviorInfo.actual) {
    behaviorSection = '\n## Reported Behavior\n';
    if (behaviorInfo.expected) {
      behaviorSection += `**Expected:** ${behaviorInfo.expected}\n`;
    }
    if (behaviorInfo.actual) {
      behaviorSection += `**Actual:** ${behaviorInfo.actual}\n`;
    }
  }
  if (behaviorInfo.warning) {
    behaviorSection += `\n${behaviorInfo.warning}\n`;
  }

  // Build architecture context for RCA
  let architectureSection = '';
  if (_architectureNotes.length > 0 || Object.keys(_relevantBehaviors).length > 0) {
    architectureSection = '\n## Architecture Context\n\n';
    if (_architectureNotes.length > 0) {
      architectureSection += _architectureNotes.join('\n') + '\n\n';
    }
    if (Object.keys(_relevantBehaviors).length > 0) {
      architectureSection += '### SwiftUI Runtime Behaviors (relevant to this bug)\n\n';
      for (const [key, description] of Object.entries(_relevantBehaviors)) {
        architectureSection += `**${key}:** ${description}\n\n`;
      }
    }
  }

  const rcaPrompt = `You are a senior iOS developer performing root cause analysis on a bug in the Sorting History app - a history timeline game built with SwiftUI.

## Bug Report

**Title:** ${issue.title}

**Description:**
${issue.body}
${behaviorSection}
${suggestedFix ? `## Previous Analysis Suggestion\n${JSON.stringify(suggestedFix, null, 2)}` : ''}

## Relevant Code Context
${contextSection}
${architectureSection}
## Your Task

Analyze the root cause of this bug. Do NOT generate any code. Instead, provide a structured analysis.

You MUST respond with ONLY this JSON format (no other text):
{
  "root_cause": "1-2 sentence description of the root cause",
  "mechanism": "How the bug manifests at runtime — what triggers it and what goes wrong",
  "affected_files": ["list of file paths that need changes, with brief reason for each"],
  "fix_strategy": "Plain English description of the approach to fix this bug. No code.",
  "confidence": "high" or "medium" or "low",
  "alternative_strategies": ["2-3 other approaches that could also work"]
}

JSON ONLY - no other text.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RCA_TIMEOUT_MS);

    console.log(`[RCA] Calling OpenRouter API (model: ${RCA_MODEL}, max_tokens: ${RCA_MAX_TOKENS}, temperature: ${RCA_TEMPERATURE})...`);
    console.log(`[RCA] RCA prompt length: ${rcaPrompt.length} chars`);

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sortinghistory.com',
        'X-Title': 'Sorting History RCA',
      },
      body: JSON.stringify({
        model: RCA_MODEL,
        messages: [{ role: 'user', content: rcaPrompt }],
        max_tokens: RCA_MAX_TOKENS,
        temperature: RCA_TEMPERATURE,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`[RCA] OpenRouter response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn(`[RCA] RCA call failed: OpenRouter error ${response.status} - ${errorBody}. Falling back to single-call approach.`);
      return null;
    }

    const result = await response.json();
    const rcaText = result.choices?.[0]?.message?.content;

    if (!rcaText) {
      console.warn('[RCA] RCA call failed: No response content from model. Falling back to single-call approach.');
      return null;
    }

    console.log(`[RCA] RCA response length: ${rcaText.length} chars`);
    console.log(`[RCA] Raw RCA response:\n${rcaText}`);

    // Parse the RCA JSON response
    let rcaJson;
    try {
      // Try code fence extraction first
      const fenceMatch = rcaText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      let jsonStr;

      if (fenceMatch) {
        jsonStr = fenceMatch[1];
      } else {
        // Balanced brace extraction
        const startIdx = rcaText.indexOf('{');
        if (startIdx === -1) {
          console.warn('[RCA] RCA call failed: No JSON object found in response. Falling back to single-call approach.');
          return null;
        }
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < rcaText.length; i++) {
          if (rcaText[i] === '{') depth++;
          if (rcaText[i] === '}') depth--;
          if (depth === 0) { endIdx = i; break; }
        }
        if (endIdx === -1) {
          console.warn('[RCA] RCA call failed: Unbalanced braces in response. Falling back to single-call approach.');
          return null;
        }
        jsonStr = rcaText.substring(startIdx, endIdx + 1);
      }

      rcaJson = JSON.parse(jsonStr);
    } catch (e) {
      console.warn(`[RCA] RCA call failed: JSON parse error - ${e.message}. Falling back to single-call approach.`);
      return null;
    }

    // Validate required fields
    const requiredFields = ['root_cause', 'mechanism', 'affected_files', 'fix_strategy', 'confidence', 'alternative_strategies'];
    const missingFields = requiredFields.filter(f => rcaJson[f] === undefined);
    if (missingFields.length > 0) {
      console.warn(`[RCA] RCA call failed: Missing required fields: ${missingFields.join(', ')}. Falling back to single-call approach.`);
      return null;
    }

    // Normalize confidence to expected values
    if (!['high', 'medium', 'low'].includes(rcaJson.confidence)) {
      console.warn(`[RCA] Unexpected confidence value "${rcaJson.confidence}", defaulting to "medium"`);
      rcaJson.confidence = 'medium';
    }

    console.log(`[RCA] Root cause: ${rcaJson.root_cause}`);
    console.log(`[RCA] Confidence: ${rcaJson.confidence}`);
    console.log(`[RCA] Affected files: ${rcaJson.affected_files.join(', ')}`);
    console.log(`[RCA] Fix strategy: ${rcaJson.fix_strategy}`);
    console.log('[RCA] RCA completed successfully');

    return rcaJson;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn(`[RCA] RCA call failed: Timeout after ${RCA_TIMEOUT_MS}ms. Falling back to single-call approach.`);
    } else {
      console.warn(`[RCA] RCA call failed: ${e.message}. Falling back to single-call approach.`);
    }
    return null;
  }
}

/**
 * BA-008.4: Apply the hard cap on total prompt size.
 * If the prompt exceeds HARD_CAP_CHARS, trim secondary files first (those NOT
 * in the RCA affected_files list), then truncate the longest remaining files.
 *
 * @param {Object} relevantFiles - Map of filePath -> content (mutated in place)
 * @param {string[]} rcaAffectedFiles - Files identified by RCA as needing changes (protected from first-pass trimming)
 * @param {number} currentPromptLength - Current total prompt length in characters
 * @returns {number} New total prompt length after trimming
 */
function applyHardCap(relevantFiles, rcaAffectedFiles, currentPromptLength) {
  if (currentPromptLength <= HARD_CAP_CHARS) {
    return currentPromptLength;
  }

  console.log(`[DIAG] Prompt exceeds hard cap (${currentPromptLength} > ${HARD_CAP_CHARS} chars). Trimming...`);

  const protectedSet = new Set(rcaAffectedFiles || []);

  // Pass 1: Remove secondary files (not in RCA affected_files)
  const secondaryFiles = Object.keys(relevantFiles).filter(f => !protectedSet.has(f));
  // Sort by size descending so we remove the largest non-essential files first
  secondaryFiles.sort((a, b) => relevantFiles[b].length - relevantFiles[a].length);

  let totalLen = currentPromptLength;
  for (const file of secondaryFiles) {
    if (totalLen <= HARD_CAP_CHARS) break;
    const removed = relevantFiles[file].length;
    delete relevantFiles[file];
    totalLen -= removed;
    console.log(`[DIAG] Hard cap: removed secondary file ${file} (${removed} chars)`);
  }

  if (totalLen <= HARD_CAP_CHARS) {
    console.log(`[DIAG] Hard cap resolved after removing secondary files. New size: ${totalLen} chars`);
    return totalLen;
  }

  // Pass 2: Truncate longest remaining files
  let remaining = Object.entries(relevantFiles);
  remaining.sort((a, b) => b[1].length - a[1].length);

  for (const [file, content] of remaining) {
    if (totalLen <= HARD_CAP_CHARS) break;
    const overage = totalLen - HARD_CAP_CHARS;
    const newLimit = Math.max(content.length - overage, 2000); // Keep at least 2000 chars
    if (newLimit < content.length) {
      const truncated = content.substring(0, newLimit);
      const lastNewline = truncated.lastIndexOf('\n');
      const cleanTruncated = lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated;
      const truncatedContent = cleanTruncated + `\n\n// ... [HARD CAP TRUNCATED — showing ${cleanTruncated.length} of ${content.length} chars] ...`;
      const saved = content.length - truncatedContent.length;
      relevantFiles[file] = truncatedContent;
      totalLen -= saved;
      console.log(`[DIAG] Hard cap: truncated ${file} by ${saved} chars`);
    }
  }

  console.log(`[DIAG] Hard cap final size: ${totalLen} chars`);
  return totalLen;
}

/**
 * Validate a content JSON file after modification. (AC2)
 * Checks: parseable JSON, top-level structure, required fields on every event.
 * Returns { valid: true } or { valid: false, errors: [...] }
 */
function validateContentJSON(filePath) {
  const errors = [];

  // 1. File must exist
  if (!fs.existsSync(filePath)) {
    return { valid: false, errors: [`File does not exist: ${filePath}`] };
  }

  // 2. Must be parseable JSON
  let data;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    data = JSON.parse(raw);
  } catch (e) {
    return { valid: false, errors: [`JSON parse error: ${e.message}`] };
  }

  // 3. Must have top-level "events" array
  if (!Array.isArray(data.events)) {
    errors.push('Missing or non-array "events" field at top level');
    return { valid: false, errors };
  }

  // 4. Must have top-level "category" string
  if (typeof data.category !== 'string' || data.category.trim() === '') {
    errors.push('Missing or empty "category" field at top level');
  }

  // 5. Every event must have required fields with correct types
  data.events.forEach((event, index) => {
    const label = event.title || 'untitled';
    for (const field of REQUIRED_EVENT_FIELDS) {
      if (event[field] === undefined || event[field] === null) {
        errors.push(`Event[${index}] ("${label}"): missing required field "${field}"`);
      }
    }
    if (event.year !== undefined && typeof event.year !== 'number') {
      errors.push(`Event[${index}] ("${label}"): "year" must be a number, got ${typeof event.year}`);
    }
    if (event.title !== undefined && (typeof event.title !== 'string' || event.title.trim() === '')) {
      errors.push(`Event[${index}]: "title" must be a non-empty string`);
    }
    if (event.description !== undefined && (typeof event.description !== 'string' || event.description.trim() === '')) {
      errors.push(`Event[${index}] ("${label}"): "description" must be a non-empty string`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Get the severity label from issue labels.
 * Returns "P1", "P2", "P3", or "P4" (default).
 */
async function getIssueSeverity() {
  const [owner, repo] = GITHUB_REPOSITORY.split('/');

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/labels`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'SortingHistory-AutoFix',
        },
      }
    );

    if (!response.ok) {
      console.log(`Could not fetch labels: ${response.status}, defaulting to P4`);
      return 'P4';
    }

    const labels = await response.json();
    const severityLabel = labels.find((l) => l.name && l.name.startsWith('severity/'));

    if (severityLabel) {
      return severityLabel.name.replace('severity/', '');
    }
  } catch (e) {
    console.log(`Error fetching severity: ${e.message}, defaulting to P4`);
  }

  return 'P4';
}

/**
 * Handle a content fix that failed JSON validation. (AC5)
 * Sets outputs so the workflow can label the PR with needs-manual-review
 * and post a comment explaining the validation failure.
 */
function handleValidationFailure(filePath, validationResult) {
  const errorSummary = validationResult.errors.join('\n- ');
  console.error(`JSON validation failed for ${filePath}:`);
  console.error(`- ${errorSummary}`);

  // Mark the fix as applied (file was modified) but validation failed
  setOutput('applied', 'true');
  setOutput('validation_failed', 'true');
  setOutput('validation_errors', validationResult.errors.join(' | '));
}

/**
 * Apply a content fix (JSON modification) (AC1)
 * Returns { success: boolean, filePath: string|null }
 */
async function applyContentFix(suggestedFix, issue) {
  console.log('Applying content fix...');

  if (!suggestedFix || !suggestedFix.file) {
    console.log('Fix path: SMART DETECTION (no structured Auto-Fix Data with file path)');
    return await applyContentFixSmart(issue);
  }

  console.log('Fix path: STRUCTURED (using Auto-Fix Data from AI analysis)');
  console.log(`Structured fix data: ${JSON.stringify(suggestedFix, null, 2)}`);
  const filePath = suggestedFix.file;

  // Validate it's a JSON file in Data/Events
  if (!filePath.endsWith('.json') || !filePath.includes('Data/Events')) {
    console.error('Content fix must target a JSON file in Data/Events');
    return { success: false, filePath: null };
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return { success: false, filePath: null };
  }

  try {
    let content = fs.readFileSync(filePath, 'utf8');

    if (suggestedFix.searchText && suggestedFix.replaceText) {
      // Direct search and replace
      console.log(`Structured fix: Attempting search/replace in ${filePath}`);
      console.log(`Structured fix: Search text = "${suggestedFix.searchText.substring(0, 100)}..."`);
      if (!content.includes(suggestedFix.searchText)) {
        console.error('Structured fix FAILED: Search text not found in file');
        console.error(`File content preview (first 500 chars): ${content.substring(0, 500)}`);
        return { success: false, filePath };
      }

      content = content.replace(suggestedFix.searchText, suggestedFix.replaceText);
      fs.writeFileSync(filePath, content);

      console.log(`Applied fix to ${filePath}`);
      setOutput('applied', 'true');
      setOutput('summary', suggestedFix.description || `Fixed content in ${path.basename(filePath)}`);
      return { success: true, filePath };
    }

    // Try JSON-level modification
    console.log('Structured fix: Attempting JSON-level modification');
    const data = JSON.parse(content);

    if (data.events && suggestedFix.eventTitle) {
      console.log(`Structured fix: Searching for event titled "${suggestedFix.eventTitle}"`);
      console.log(`Structured fix: File has ${data.events.length} events`);
      const event = data.events.find((e) => e.title === suggestedFix.eventTitle);
      if (event) {
        console.log(`Structured fix: Found matching event "${event.title}"`);
        const changes = {};
        const eventTitleForCheck = event.title;
        // Date corrections
        if (suggestedFix.year !== undefined) {
          changes.year = { from: event.year, to: suggestedFix.year };
          event.year = suggestedFix.year;
        }
        if (suggestedFix.month !== undefined) {
          changes.month = { from: event.month, to: suggestedFix.month };
          event.month = suggestedFix.month;
        }
        if (suggestedFix.day !== undefined) {
          changes.day = { from: event.day, to: suggestedFix.day };
          event.day = suggestedFix.day;
        }
        // Text replacements
        if (suggestedFix.description !== undefined) {
          changes.description = { from: event.description, to: suggestedFix.description };
          event.description = suggestedFix.description;
        }
        if (suggestedFix.title !== undefined) {
          changes.title = { from: event.title, to: suggestedFix.title };
          event.title = suggestedFix.title;
        }
        if (suggestedFix.difficulty !== undefined) {
          changes.difficulty = { from: event.difficulty, to: suggestedFix.difficulty };
          event.difficulty = suggestedFix.difficulty;
        }
        // Category reassignment (top-level category field)
        if (suggestedFix.category !== undefined) {
          changes.category = { from: data.category, to: suggestedFix.category };
          data.category = suggestedFix.category;
        }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`Updated event "${suggestedFix.eventTitle}" in ${filePath}`);
        setOutput('applied', 'true');
        setOutput('summary', `Fixed "${suggestedFix.eventTitle}" in ${path.basename(filePath)}`);
        return { success: true, filePath, eventTitle: eventTitleForCheck, changes };
      } else {
        console.log(`Structured fix FAILED: No exact title match found for "${suggestedFix.eventTitle}"`);
        console.log(`Structured fix: Available event titles: ${data.events.map(e => e.title).slice(0, 10).join(', ')}${data.events.length > 10 ? '...' : ''}`);
      }
    }

    console.error('Could not apply content fix - no matching modification strategy');
    return { success: false, filePath: null };
  } catch (e) {
    console.error('Failed to apply content fix:', e.message);
    return { success: false, filePath: null };
  }
}

/**
 * Smart content fix - analyze issue and determine fix automatically
 * Returns { success: boolean, filePath: string|null }
 */
async function applyContentFixSmart(issue) {
  console.log('Attempting smart content fix based on issue description...');
  console.log('Smart detection path: No structured Auto-Fix Data, using pattern matching');

  // Parse issue body for date corrections
  const body = issue.body || '';

  // Pattern: "X is listed as YYYY but should be ZZZZ"
  const datePattern = /["']?([^"']+)["']?\s+(?:is listed as|shows|has|says)\s+(\d{4})\s+(?:but should be|should be|instead of)\s+(\d{4})/i;
  const dateMatch = body.match(datePattern);

  console.log(`Smart detection: regex pattern = ${datePattern}`);
  console.log(`Smart detection: regex match result = ${dateMatch ? 'FOUND' : 'NO MATCH'}`);

  if (!dateMatch) {
    console.log('Smart detection FAILED: Could not parse date correction pattern from issue body');
    console.log(`Issue body (first 500 chars): ${body.substring(0, 500)}`);
    return { success: false, filePath: null };
  }

  const [, eventName, wrongYear, correctYear] = dateMatch;
  console.log(`Smart detection: Event name = "${eventName}"`);
  console.log(`Smart detection: Wrong year = ${wrongYear}, Correct year = ${correctYear}`);

  // Search all JSON files for this event
  const jsonFiles = fs.readdirSync(DATA_EVENTS_PATH).filter((f) => f.endsWith('.json'));
  console.log(`Smart detection: Searching ${jsonFiles.length} JSON files in ${DATA_EVENTS_PATH}`);

  for (const file of jsonFiles) {
    const filePath = path.join(DATA_EVENTS_PATH, file);
    console.log(`Smart detection: Searching file ${file}...`);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);

      if (data.events) {
        console.log(`Smart detection: ${file} has ${data.events.length} events`);
        const event = data.events.find(
          (e) =>
            e.title.toLowerCase().includes(eventName.toLowerCase()) ||
            eventName.toLowerCase().includes(e.title.toLowerCase())
        );

        if (event) {
          console.log(`Smart detection: Found matching event "${event.title}" in ${file}`);
          console.log(`Smart detection: Event year in file = ${event.year}, expected wrong year = ${parseInt(wrongYear)}`);

          if (event.year === parseInt(wrongYear)) {
            const eventTitleForCheck = event.title;
            const changes = {
              year: { from: parseInt(wrongYear), to: parseInt(correctYear) },
            };
            event.year = parseInt(correctYear);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            console.log(`Fixed "${event.title}" year from ${wrongYear} to ${correctYear} in ${file}`);
            setOutput('applied', 'true');
            setOutput('summary', `Fixed "${event.title}" year: ${wrongYear} -> ${correctYear}`);
            return { success: true, filePath, eventTitle: eventTitleForCheck, changes };
          } else {
            console.log(`Smart detection: Year mismatch - event has ${event.year}, expected ${parseInt(wrongYear)}`);
          }
        } else {
          console.log(`Smart detection: No event title match for "${eventName}" in ${file}`);
        }
      } else {
        console.log(`Smart detection: ${file} has no events array`);
      }
    } catch (e) {
      console.log(`Smart detection: Error parsing ${file}: ${e.message}`);
    }
  }

  console.log('Smart detection FAILED: No matching event found with the expected wrong year');
  console.log(`Searched for: "${eventName}" with year ${wrongYear}`);
  return { success: false, filePath: null };
}

// ============================================================================
// BA-008.9: Inner Loop Functions
// ============================================================================

/**
 * BA-008.9: Check if the working tree has any changes (non-empty diff).
 * Returns { empty: boolean, diff: string }
 */
function checkEmptyDiff() {
  try {
    const diff = execSync('git diff', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const untrackedDiff = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const combinedDiff = diff + untrackedDiff;
    return { empty: combinedDiff.trim().length === 0, diff: diff };
  } catch (e) {
    console.warn(`[INNER-LOOP] git diff failed: ${e.message}`);
    return { empty: true, diff: '' };
  }
}

/**
 * BA-008.9: Structural checks on the diff.
 * Counts lines added vs removed. Flags feature deletion if removed > 3x added.
 * Returns { linesAdded: number, linesRemoved: number, featureDeletion: boolean, summary: string }
 */
function structuralChecks(diff) {
  const lines = diff.split('\n');
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved++;
    }
  }

  const featureDeletion = linesRemoved > 0 && linesAdded > 0
    ? linesRemoved > 3 * linesAdded
    : linesRemoved > 10 && linesAdded === 0;

  const summary = `Lines added: ${linesAdded}, Lines removed: ${linesRemoved}, Ratio: ${linesAdded > 0 ? (linesRemoved / linesAdded).toFixed(1) : 'inf'}:1${featureDeletion ? ' [LIKELY FEATURE DELETION]' : ''}`;

  console.log(`[STRUCTURAL] ${summary}`);

  return { linesAdded, linesRemoved, featureDeletion, summary };
}

/**
 * BA-008.9: QA Review using a different model family (adversarial reviewer).
 * Receives the diff, RCA, bug report, structural check output, and previous attempts.
 * Returns { approved: boolean, reason: string, suggestions: string, failure_type: string }
 */
/**
 * Parse QA response text into structured result.
 * Handles truncated JSON by attempting to close unbalanced braces.
 */
function parseAndReturnQA(qaText) {
  console.log(`[QA] Raw QA response:\n${qaText}`);

  let qaJson;
  try {
    const fenceMatch = qaText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    let jsonStr;

    if (fenceMatch) {
      jsonStr = fenceMatch[1];
    } else {
      const startIdx = qaText.indexOf('{');
      if (startIdx === -1) {
        console.warn('[QA] No JSON object found in QA response');
        return { approved: false, reason: 'Could not parse QA response', suggestions: 'Retry', failure_type: 'none' };
      }
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < qaText.length; i++) {
        if (qaText[i] === '{') depth++;
        if (qaText[i] === '}') depth--;
        if (depth === 0) { endIdx = i; break; }
      }
      if (endIdx === -1) {
        // Truncated JSON — try to repair by extracting known fields
        console.warn(`[QA] Unbalanced braces (depth=${depth}) — attempting truncated JSON repair`);
        const partialJson = qaText.substring(startIdx);
        const approvedMatch = partialJson.match(/"approved"\s*:\s*(true|false)/);
        const reasonMatch = partialJson.match(/"reason"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
        const failureMatch = partialJson.match(/"failure_type"\s*:\s*"([^"]*)"/);
        const suggestionsMatch = partialJson.match(/"suggestions"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
        if (approvedMatch) {
          const approved = approvedMatch[1] === 'true';
          const reason = reasonMatch ? reasonMatch[1] : (approved ? 'Approved (parsed from truncated response)' : 'Rejected (parsed from truncated response)');
          const failure_type = failureMatch ? failureMatch[1] : 'none';
          const suggestions = suggestionsMatch ? suggestionsMatch[1] : '';
          console.log(`[QA] Repaired truncated JSON — approved: ${approved}, reason: ${reason}`);
          return { approved, reason, suggestions, failure_type };
        }
        return { approved: false, reason: 'Malformed QA response (truncated)', suggestions: 'Retry', failure_type: 'none' };
      }
      jsonStr = qaText.substring(startIdx, endIdx + 1);
    }

    qaJson = JSON.parse(jsonStr);
  } catch (e) {
    console.warn(`[QA] QA JSON parse error: ${e.message}`);
    return { approved: false, reason: `QA parse error: ${e.message}`, suggestions: 'Retry', failure_type: 'none' };
  }

  const approved = qaJson.approved === true;
  const reason = qaJson.reason || (approved ? 'Approved' : 'Rejected without reason');
  const suggestions = qaJson.suggestions || '';
  const failure_type = qaJson.failure_type || 'none';

  console.log(`[QA] Decision: ${approved ? 'APPROVED' : 'REJECTED'}`);
  console.log(`[QA] Reason: ${reason}`);
  if (!approved) {
    console.log(`[QA] Failure type: ${failure_type}`);
    console.log(`[QA] Suggestions: ${suggestions}`);
  }

  return { approved, reason, suggestions, failure_type };
}

async function performQAReview(diff, rcaResult, issue, behaviorInfo, structuralResult, previousAttempts, bannedApproaches) {
  console.log('\n--- QA Review (BA-008.9) ---');
  console.log(`[QA] Model: ${QA_MODEL}`);
  console.log(`[QA] Diff size: ${diff.length} chars`);

  // Build banned approaches section
  const bannedSection = bannedApproaches && bannedApproaches.length > 0
    ? `\n## Banned Approaches (already failed in previous pipeline runs)\n${bannedApproaches.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n`
    : '';

  // Build previous attempts section
  const previousSection = previousAttempts && previousAttempts.length > 0
    ? '\n## Previous Attempts This Run (DO NOT REPEAT)\n' + previousAttempts.map(a =>
        `### Attempt ${a.iteration}\n**Rejected because:** ${a.reason}\n**Suggestions:** ${a.suggestions || 'None'}\n**Diff:**\n\`\`\`diff\n${a.diff.substring(0, 3000)}\n\`\`\``
      ).join('\n\n') + '\n'
    : '';

  const qaPrompt = `You are a senior iOS developer reviewing an AI-generated bug fix. Your job is to REJECT fixes that are wrong, incomplete, or lazy. You are an adversarial reviewer — assume the fix is bad until proven otherwise.

## Bug Report
**Title:** ${issue.title}
**Expected behavior:** ${behaviorInfo?.expected || 'Not specified'}
**Actual behavior:** ${behaviorInfo?.actual || (issue.body ? issue.body.substring(0, 500) : 'Not specified')}

## Root Cause Analysis
**Root Cause:** ${rcaResult?.root_cause || 'Not available'}
**Fix Strategy:** ${rcaResult?.fix_strategy || 'Not available'}

## Generated Diff
\`\`\`diff
${diff}
\`\`\`

## Structural Analysis
- Lines added: ${structuralResult.linesAdded}
- Lines removed: ${structuralResult.linesRemoved}
- Ratio (removed:added): ${structuralResult.linesAdded > 0 ? (structuralResult.linesRemoved / structuralResult.linesAdded).toFixed(1) : 'infinity'}:1
${structuralResult.featureDeletion ? '- **WARNING: LIKELY FEATURE DELETION DETECTED** (removed >> added)\n' : ''}
${bannedSection}${previousSection}
## Review Criteria (check ALL of these)

1. **Does the diff address the root cause?** The RCA says the root cause is: "${rcaResult?.root_cause || 'unknown'}". Does the code change actually fix this mechanism, or does it work around symptoms?

2. **Does the diff delete or disable functionality?** If the diff removes code (especially event handlers like .onAppear, .onTapGesture, .onChange, or conditional logic) without replacing it with equivalent or better functionality, this is FEATURE DELETION. REJECT.
   - CONCRETE EXAMPLE: Removing \`.onAppear { showGameModeHelp = true }\` without adding an alternative trigger is deleting the help-bubble feature. REJECT.
   - CONCRETE EXAMPLE: Wrapping existing code in \`if false { ... }\` or commenting it out is disabling, not fixing. REJECT.
   - CONCRETE EXAMPLE: Adding a print statement or renaming a variable is NOT a fix. REJECT.

3. **Is this a no-op or trivial change?** Adding a comment, renaming a variable without changing behavior, or adding a print statement is NOT a fix. REJECT.

4. **Does the diff repeat a banned approach?** Check the banned approaches list above. If the diff uses any of those strategies (even with minor variations), REJECT.

5. **Does the diff introduce obvious regressions?** Removing error handling, breaking API contracts, changing public function signatures, or modifying unrelated code. REJECT.

6. **If structural analysis shows removed >> added (3:1+ ratio), is the deletion justified?** Most legitimate fixes ADD or MODIFY code, not delete it. A high deletion ratio almost always indicates feature removal, not a fix.

Respond with ONLY this JSON (no other text):
{
  "approved": true or false,
  "reason": "1-2 sentence explanation of your decision",
  "suggestions": "If rejected, what should the next attempt do differently. Be specific.",
  "failure_type": "feature_deletion" or "noop" or "approach_repetition" or "regression" or "wrong_approach" or "none"
}

JSON ONLY - no other text.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    console.log(`[QA] QA prompt length: ${qaPrompt.length} chars`);

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sortinghistory.com',
        'X-Title': 'Sorting History QA Review',
      },
      body: JSON.stringify({
        model: QA_MODEL,
        messages: [{ role: 'user', content: qaPrompt }],
        max_tokens: 4096,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`[QA] OpenRouter response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn(`[QA] QA review API call failed: ${response.status} - ${errorBody}`);
      // On API failure, default to rejection to be safe
      return { approved: false, reason: `QA API call failed: ${response.status}`, suggestions: 'Retry', failure_type: 'none' };
    }

    const result = await response.json();
    const qaText = result.choices?.[0]?.message?.content;

    if (!qaText) {
      // Check reasoning_content fallback (some reasoning models put output there)
      const altText = result.choices?.[0]?.message?.reasoning_content;
      if (altText) {
        console.log('[QA] Found response in reasoning_content field');
        // Fall through using altText — reassign below
      } else {
        // Retry once on empty response
        console.warn('[QA] No response content from QA model — retrying once...');
        try {
          const retryResp = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://sortinghistory.com',
              'X-Title': 'Sorting History QA Review (retry)',
            },
            body: JSON.stringify({
              model: QA_MODEL,
              messages: [{ role: 'user', content: qaPrompt }],
              max_tokens: 4096,
              temperature: 0.2,
              response_format: { type: 'json_object' },
            }),
          });
          if (retryResp.ok) {
            const retryResult = await retryResp.json();
            const retryText = retryResult.choices?.[0]?.message?.content || retryResult.choices?.[0]?.message?.reasoning_content;
            if (retryText) {
              console.log('[QA] Retry succeeded — got response');
              // Continue with retryText below (reassign qaText)
              // We can't reassign const, so we handle inline
              return parseAndReturnQA(retryText);
            }
          }
        } catch (retryErr) {
          console.warn(`[QA] Retry also failed: ${retryErr.message}`);
        }
        console.warn('[QA] No response from QA model after retry');
        return { approved: false, reason: 'No response from QA model', suggestions: 'Retry', failure_type: 'none' };
      }
    }

    // Use shared parser (handles truncated JSON, extracts fields)
    const effectiveText = qaText || result.choices?.[0]?.message?.reasoning_content;
    return parseAndReturnQA(effectiveText);
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('[QA] QA review timed out after 60s');
    } else {
      console.warn(`[QA] QA review error: ${e.message}`);
    }
    return { approved: false, reason: `QA error: ${e.message}`, suggestions: 'Retry', failure_type: 'none' };
  }
}

/**
 * BA-008.9: Revert all working tree changes (tracked and untracked).
 * Uses git checkout -- . && git clean -fd
 */
function revertWorkingTree() {
  try {
    execSync('git checkout -- .', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    execSync('git clean -fd', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    console.log('[INNER-LOOP] Working tree reverted (checkout + clean)');
  } catch (e) {
    console.error(`[INNER-LOOP] Revert failed: ${e.message}`);
  }
}

/**
 * BA-008.9: Generate a fix using the AI model.
 * Extracted from the old applyCodeFix flow to enable iteration.
 *
 * @param {string} prompt - The full prompt to send
 * @param {number} iteration - Current iteration number (for logging)
 * @returns {Object|null} Parsed fix data or null on failure
 */
async function generateFix(prompt, iteration) {
  console.log(`\n--- Generate Fix (Iteration ${iteration}) ---`);
  console.log(`[GEN] Model: ${FIX_MODEL}`);
  console.log(`[GEN] Prompt length: ${prompt.length} chars`);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sortinghistory.com',
        'X-Title': `Sorting History Bug Fix (Iteration ${iteration})`,
      },
      body: JSON.stringify({
        model: FIX_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
        temperature: CODE_GEN_TEMPERATURE,
      }),
    });

    console.log(`[GEN] OpenRouter response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[GEN] OpenRouter error: ${errorBody}`);
      return null;
    }

    const result = await response.json();
    const fixText = result.choices?.[0]?.message?.content;

    if (!fixText) {
      console.error('[GEN] No response from model');
      return null;
    }

    console.log(`[GEN] Fix text length: ${fixText.length} chars`);

    const fixData = parseCodeFixResponse(fixText);

    if (!fixData || !fixData.modifications || fixData.modifications.length === 0) {
      console.error('[GEN] Could not parse fix from model response');
      return null;
    }

    console.log(`[GEN] Parsed ${fixData.modifications.length} modification(s)`);
    return fixData;
  } catch (e) {
    console.error(`[GEN] Fix generation failed: ${e.message}`);
    return null;
  }
}

/**
 * BA-008.9: The iterative fix loop.
 * Generates a fix, applies it, checks empty diff, runs structural checks,
 * compiles, and sends for QA review. Iterates up to MAX_INNER_ITERATIONS times.
 *
 * @param {Object} issue - GitHub issue object
 * @param {Object} suggestedFix - Extracted suggested fix (may be null)
 * @param {Object} relevantFiles - Map of filePath -> content
 * @param {Object|null} rcaResult - RCA analysis result
 * @param {Object|null} behaviorInfo - Expected/actual behavior info
 * @returns {Object} { success: boolean, fixData?, modifiedFiles?, qaIterations?, approvedIteration?, failedApproaches? }
 */
async function iterativeFixLoop(issue, suggestedFix, relevantFiles, rcaResult, behaviorInfo) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`BA-008.9: Iterative Fix Loop (max ${MAX_INNER_ITERATIONS} iterations)`);
  console.log(`${'='.repeat(50)}\n`);

  const loopStartTime = Date.now();
  const failedApproaches = [];
  const previousAttempts = []; // { iteration, diff, reason, suggestions }

  // Collect banned approaches from outer retry context
  const bannedApproaches = [];
  if (IS_RETRY && PREVIOUS_FIX_SUMMARY) {
    bannedApproaches.push(PREVIOUS_FIX_SUMMARY);
  }
  if (IS_RETRY && REJECTION_REASON) {
    bannedApproaches.push(`Previous attempt rejected: ${REJECTION_REASON}`);
  }
  // Also include any inner_loop_failures from the dispatch payload
  const innerLoopFailuresEnv = process.env.INNER_LOOP_FAILURES;
  if (innerLoopFailuresEnv) {
    try {
      const pastFailures = JSON.parse(innerLoopFailuresEnv);
      if (Array.isArray(pastFailures)) {
        for (const f of pastFailures) {
          bannedApproaches.push(`Previous run iteration ${f.iteration}: ${f.strategy} — rejected: ${f.rejection_reason}`);
        }
      }
    } catch (e) {
      console.warn(`[INNER-LOOP] Could not parse INNER_LOOP_FAILURES: ${e.message}`);
    }
  }

  for (let iteration = 1; iteration <= MAX_INNER_ITERATIONS; iteration++) {
    // Step 0: Check wall-clock timeout
    const elapsed = Date.now() - loopStartTime;
    if (elapsed > MAX_LOOP_TIME_MS) {
      console.log(`[INNER-LOOP] Wall-clock timeout after ${Math.round(elapsed / 1000)}s — exiting loop`);
      break;
    }

    console.log(`\n--- Inner Loop Iteration ${iteration}/${MAX_INNER_ITERATIONS} (elapsed: ${Math.round(elapsed / 1000)}s) ---`);

    // Step 1: Build prompt (with previous attempt context for iteration 2+)
    let prompt = buildCodeFixPrompt(issue, suggestedFix, relevantFiles, rcaResult, behaviorInfo);

    // BA-008.4: Apply hard cap if prompt exceeds limit
    if (prompt.length > HARD_CAP_CHARS) {
      console.log(`[DIAG] Prompt exceeds hard cap (${prompt.length} > ${HARD_CAP_CHARS}). Trimming context files...`);
      const rcaAffectedFiles = rcaResult ? rcaResult.affected_files : [];
      const contextSize = Object.values(relevantFiles).reduce((sum, c) => sum + c.length, 0);
      applyHardCap(relevantFiles, rcaAffectedFiles, contextSize);
      prompt = buildCodeFixPrompt(issue, suggestedFix, relevantFiles, rcaResult, behaviorInfo);
    }

    // Append previous attempt context for iteration 2+
    if (previousAttempts.length > 0) {
      prompt += '\n\n## PREVIOUS ATTEMPTS (DO NOT REPEAT)\n\nYour previous approach(es) were rejected. Generate a FUNDAMENTALLY DIFFERENT approach.\n';
      for (const attempt of previousAttempts) {
        prompt += `\n### Attempt ${attempt.iteration}\n`;
        prompt += `**Diff:**\n\`\`\`diff\n${attempt.diff.substring(0, 3000)}\n\`\`\`\n`;
        if (attempt.compileError) {
          prompt += `**Compilation Error:**\n\`\`\`\n${attempt.compileError.substring(0, 1500)}\n\`\`\`\n`;
        }
        if (attempt.reason) {
          prompt += `**QA Rejection:** ${attempt.reason}\n`;
        }
        if (attempt.suggestions) {
          prompt += `**QA Suggestions:** ${attempt.suggestions}\n`;
        }
      }
    }

    // Append outer retry context if applicable
    if (IS_RETRY && REJECTION_REASON) {
      prompt += `\n\n## IMPORTANT: Previous Pipeline Run Was Rejected (Attempt ${ATTEMPT_NUMBER - 1} failed)\n\n`;
      prompt += `**Rejection Reason:** ${REJECTION_REASON}\n`;
      prompt += `**What the previous fix attempted:**\n${PREVIOUS_FIX_SUMMARY || '(Not available)'}\n`;
      prompt += `\n**You MUST try a FUNDAMENTALLY DIFFERENT approach.** Do not repeat the same strategy.\n`;
    }

    const estimatedTokens = Math.round(prompt.length / 4);
    console.log(`[DIAG] Iteration ${iteration} prompt: ${prompt.length} characters (est ~${estimatedTokens} tokens)`);

    // Step 1: Generate fix
    const fixData = await generateFix(prompt, iteration);
    if (!fixData) {
      const failureRecord = {
        iteration,
        strategy: 'Fix generation returned no parseable modifications',
        rejection_reason: 'No parseable fix generated',
        diff: '',
      };
      failedApproaches.push(failureRecord);
      previousAttempts.push({ iteration, diff: '', reason: 'No parseable fix generated', suggestions: 'Produce valid JSON with modifications array' });
      console.log(`[INNER-LOOP] Iteration ${iteration}: Fix generation failed, continuing...`);
      continue;
    }

    // Step 2: Apply modifications
    let appliedCount = 0;
    const modifiedFiles = [];
    for (let i = 0; i < fixData.modifications.length; i++) {
      const mod = fixData.modifications[i];
      console.log(`[INNER-LOOP] Applying modification ${i + 1}/${fixData.modifications.length}: ${mod.action} on ${mod.file}`);
      if (await applyModification(mod, i + 1, fixData.modifications.length)) {
        appliedCount++;
        if (mod.file && !modifiedFiles.includes(mod.file)) {
          modifiedFiles.push(mod.file);
        }
      }
    }

    // Step 3: Check empty diff
    const diffResult = checkEmptyDiff();
    if (diffResult.empty) {
      const failureRecord = {
        iteration,
        strategy: fixData.summary || 'Unknown strategy',
        rejection_reason: 'No modifications applied — all search/replace patterns failed to match',
        diff: '',
      };
      failedApproaches.push(failureRecord);
      previousAttempts.push({ iteration, diff: '', reason: 'No modifications applied — all search/replace patterns failed to match', suggestions: 'Use exact text from the file for search strings. Check indentation carefully.' });
      console.log(`[INNER-LOOP] Iteration ${iteration}: Empty diff — no modifications applied, continuing...`);
      revertWorkingTree();
      continue;
    }

    console.log(`[INNER-LOOP] Diff captured (${diffResult.diff.length} chars)`);

    // Step 4: Structural checks
    const structuralResult = structuralChecks(diffResult.diff);

    // Step 5: Compile with xcodebuild
    console.log(`[INNER-LOOP] Iteration ${iteration}: Compiling...`);
    const buildResult = validateBuild();
    if (!buildResult.success) {
      const failureRecord = {
        iteration,
        strategy: fixData.summary || 'Unknown strategy',
        rejection_reason: `Compilation failed: ${buildResult.error?.substring(0, 300) || 'unknown error'}`,
        diff: diffResult.diff.substring(0, 2000),
      };
      failedApproaches.push(failureRecord);
      previousAttempts.push({
        iteration,
        diff: diffResult.diff,
        compileError: buildResult.error,
        reason: `Compilation failed`,
        suggestions: `Fix these compilation errors: ${buildResult.error?.substring(0, 500) || 'unknown'}`,
      });
      console.log(`[INNER-LOOP] Iteration ${iteration}: Compilation FAILED, reverting...`);
      revertWorkingTree();
      continue;
    }
    console.log(`[INNER-LOOP] Iteration ${iteration}: Compilation PASSED`);

    // Step 6: QA Review
    console.log(`[INNER-LOOP] Iteration ${iteration}: Sending to QA reviewer...`);
    const qaResult = await performQAReview(
      diffResult.diff,
      rcaResult,
      issue,
      behaviorInfo,
      structuralResult,
      previousAttempts,
      bannedApproaches
    );

    if (!qaResult.approved) {
      const failureRecord = {
        iteration,
        strategy: fixData.summary || 'Unknown strategy',
        rejection_reason: qaResult.reason,
        diff: diffResult.diff.substring(0, 2000),
      };
      failedApproaches.push(failureRecord);
      previousAttempts.push({
        iteration,
        diff: diffResult.diff,
        reason: qaResult.reason,
        suggestions: qaResult.suggestions,
      });
      console.log(`[INNER-LOOP] Iteration ${iteration}: QA REJECTED (${qaResult.failure_type}), reverting...`);
      revertWorkingTree();
      continue;
    }

    // Step 7: Both compile and QA passed!
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[INNER-LOOP] FIX APPROVED on iteration ${iteration}/${MAX_INNER_ITERATIONS}`);
    console.log(`[INNER-LOOP] QA reason: ${qaResult.reason}`);
    console.log(`${'='.repeat(50)}\n`);

    return {
      success: true,
      fixData,
      modifiedFiles,
      qaIterations: iteration,
      approvedIteration: iteration,
      totalAttempts: iteration,
      qaApprovalReason: qaResult.reason,
      failedApproaches,
    };
  }

  // All iterations exhausted
  const elapsed = Date.now() - loopStartTime;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[INNER-LOOP] ALL ${MAX_INNER_ITERATIONS} ITERATIONS EXHAUSTED (${Math.round(elapsed / 1000)}s)`);
  console.log(`[INNER-LOOP] Failed approaches:`);
  for (const approach of failedApproaches) {
    console.log(`  - Iteration ${approach.iteration}: ${approach.rejection_reason}`);
  }
  console.log(`${'='.repeat(50)}\n`);

  return {
    success: false,
    failedApproaches,
    qaIterations: MAX_INNER_ITERATIONS,
    totalAttempts: MAX_INNER_ITERATIONS,
  };
}

// ============================================================================
// End BA-008.9: Inner Loop Functions
// ============================================================================

/**
 * Apply a code fix using Claude
 * BA-008.9: Refactored to use iterativeFixLoop() instead of single-shot generation.
 */
async function applyCodeFix(suggestedFix, issue) {
  console.log('Applying code fix...');
  console.log(`[DEBUG] Code fix model: ${CODE_MODEL}`);
  console.log(`[DEBUG] OPENROUTER_API_KEY present: ${OPENROUTER_API_KEY ? 'YES (length: ' + OPENROUTER_API_KEY.length + ')' : 'NO'}`);

  // If we have a direct fix from analysis, try it first
  // Note: This path bypasses the iterative loop but still validates the build.
  if (suggestedFix && suggestedFix.file && suggestedFix.searchText && suggestedFix.replaceText) {
    const filePath = suggestedFix.file;

    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');

      if (content.includes(suggestedFix.searchText)) {
        content = content.replace(suggestedFix.searchText, suggestedFix.replaceText);
        fs.writeFileSync(filePath, content);

        console.log(`Applied direct fix to ${filePath}, validating build...`);
        const buildResult = validateBuild();
        if (!buildResult.success) {
          console.log('Direct fix failed build validation, reverting and falling through to iterative loop...');
          revertWorkingTree();
          // Fall through to the iterative loop below
        } else {
          await updateVersionString();
          setOutput('applied', 'true');
          setOutput('summary', suggestedFix.description || `Fixed code in ${path.basename(filePath)}`);
          return true;
        }
      }
    }
  }

  // If no direct fix or it failed, use AI to generate a fix via iterative loop
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set - cannot generate code fix');
    setOutput('applied', 'false');
    return false;
  }

  console.log('Generating code fix via iterative loop (BA-008.9)...');
  console.log(`[DEBUG] Fix model: ${FIX_MODEL}`);
  console.log(`[DEBUG] QA model: ${QA_MODEL}`);
  console.log(`[DEBUG] RCA model: ${RCA_MODEL}`);

  try {
    // Gather context (pass suggestedFix so its file paths are included)
    console.log('[DEBUG] Gathering relevant file context...');
    const relevantFiles = await gatherRelevantContext(issue, suggestedFix);

    console.log(`[DEBUG] Gathered context from ${Object.keys(relevantFiles).length} file(s):`);
    for (const [filePath, content] of Object.entries(relevantFiles)) {
      console.log(`  - ${filePath} (${content.length} chars)`);
    }

    if (Object.keys(relevantFiles).length === 0) {
      console.error('[DEBUG] WARNING: No relevant files gathered! This may cause poor fix generation.');
    }

    // BA-008.4: Extract expected/actual behavior from issue body
    const behaviorInfo = extractExpectedActualBehavior(issue.body);
    if (behaviorInfo.expected) console.log(`[RCA] Expected behavior: ${behaviorInfo.expected.substring(0, 100)}...`);
    if (behaviorInfo.actual) console.log(`[RCA] Actual behavior: ${behaviorInfo.actual.substring(0, 100)}...`);
    if (behaviorInfo.warning) console.log(`[RCA] ${behaviorInfo.warning}`);

    // BA-008.4: Perform Root Cause Analysis ONCE (not per iteration)
    const rcaResult = await performRCA(issue, suggestedFix, relevantFiles, behaviorInfo);

    // Output fix_confidence for workflow consumption
    if (rcaResult) {
      setOutput('fix_confidence', rcaResult.confidence);
    } else {
      setOutput('fix_confidence', 'medium'); // Default when RCA unavailable
    }

    // BA-008.5: Output RCA fields for PR body (fix strategy, root cause, mechanism)
    if (rcaResult) {
      setOutput('fix_strategy', rcaResult.fix_strategy || '');
      setOutput('rca_root_cause', rcaResult.root_cause || '');
      setOutput('rca_mechanism', rcaResult.mechanism || '');
    } else {
      setOutput('fix_strategy', '');
      setOutput('rca_root_cause', '');
      setOutput('rca_mechanism', '');
    }

    // BA-008.9: Run the iterative fix loop (compile + QA inside the loop)
    const loopResult = await iterativeFixLoop(issue, suggestedFix, relevantFiles, rcaResult, behaviorInfo);

    // BA-008.9: Output inner_loop_failures for outer retry consumption
    if (loopResult.failedApproaches && loopResult.failedApproaches.length > 0) {
      setOutput('inner_loop_failures', JSON.stringify(loopResult.failedApproaches));
    }

    // BA-008.9: Output QA iteration info for PR body
    if (loopResult.qaIterations) {
      setOutput('qa_iterations', String(loopResult.qaIterations));
    }
    if (loopResult.approvedIteration) {
      setOutput('qa_approved_iteration', String(loopResult.approvedIteration));
    }

    if (loopResult.success) {
      // BA-008.9: Version bump OUTSIDE the loop — runs exactly once after approval
      await updateVersionString();
      setOutput('applied', 'true');
      setOutput('summary', loopResult.fixData.summary || `Applied code fix (QA approved on iteration ${loopResult.approvedIteration})`);
      setOutput('modified_files', (loopResult.modifiedFiles || []).join(', '));
      if (loopResult.fixData.testInstructions) {
        setOutput('test_instructions', loopResult.fixData.testInstructions);
      }
      return true;
    }

    // All iterations failed
    setOutput('applied', 'false');
    setOutput('summary', `Fix generation failed after ${loopResult.totalAttempts} iterations — all approaches rejected by QA or failed compilation`);
    return false;
  } catch (e) {
    console.error('Code fix generation failed:', e.message);
    setOutput('applied', 'false');
    return false;
  }
}

/**
 * Map currentScreen from issue device info to the corresponding view file.
 * BA-007.2: Used by gatherRelevantContext() to include the correct view file
 * when the bug report includes a "Current Screen" field.
 *
 * Returns the file path string, or null if no match is found.
 */
function getViewFileFromScreen(issueBody) {
  const screenMatch = issueBody.match(/Current Screen[:\s]+(\w+)/i);
  if (!screenMatch) return null;

  const screenToView = {
    'GameView': 'Views/Game/ModernSortingGameView.swift',
    'GameSetupView': 'Views/GameSetupView.swift',
    'SettingsView': 'Views/SettingsView.swift',
    'CategorySelectionView': 'Views/Categories/CategorySelectionView.swift',
    'MainMenuView': 'Views/MainMenu/MainMenuView.swift',
    'BugReportView': 'Views/BugReport/BugReportView.swift',
  };

  return screenToView[screenMatch[1]] || null;
}

/**
 * BA-007.25: Find files similar to a non-existent suggested file path.
 * Extracts meaningful name parts and searches the codebase for matches.
 * Returns up to 3 matching file paths, prioritizing exact basename matches.
 */
function findSimilarFiles(suggestedPath) {
  const basename = path.basename(suggestedPath, '.swift');
  // Extract meaningful words from the filename (e.g., "GameSetupHelpManager" -> ["Game", "Setup", "Help", "Manager"])
  const nameWords = basename.match(/[A-Z][a-z]+/g) || [basename];
  // Remove generic suffixes like "Manager", "Controller", "Service", "Model"
  const meaningfulWords = nameWords.filter(w => !['Manager', 'Controller', 'Service', 'Model', 'View', 'Helper', 'Provider'].includes(w));

  const results = [];
  const searchDirs = ['Views', 'ViewModels', 'Models', 'Features', 'Core', 'Network'];

  function searchDir(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        searchDir(fullPath);
      } else if (entry.name.endsWith('.swift')) {
        const entryBasename = entry.name.replace('.swift', '');
        // Score: how many meaningful words from the suggested name appear in this file name
        const score = meaningfulWords.filter(w => entryBasename.includes(w)).length;
        if (score >= 2 || (meaningfulWords.length === 1 && score === 1)) {
          results.push({ path: fullPath, score });
        }
      }
    }
  }

  for (const dir of searchDirs) {
    searchDir(dir);
  }

  // Sort by score descending, return top 3
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3).map(r => r.path);
}

/**
 * Gather relevant code context for Claude
 */
async function gatherRelevantContext(issue, suggestedFix) {
  const context = {};
  let totalContextSize = 0;
  let filesSkipped = 0;
  const body = issue.body || '';
  const title = issue.title || '';
  // Normalize compound words so "set up" matches "setup", "time line" matches "timeline", etc.
  const combined = `${title} ${body}`.toLowerCase().replace(/set up/g, 'setup').replace(/time line/g, 'timeline').replace(/pop up/g, 'popup');

  // If suggested fix specifies a file, try to include it with more context
  if (suggestedFix && suggestedFix.file) {
    if (fs.existsSync(suggestedFix.file)) {
      const content = readFileWithLimit(suggestedFix.file, PRIMARY_FILE_LIMIT);
      context[suggestedFix.file] = content;
      totalContextSize += content.length;
    } else {
      // BA-007.25: Suggested file doesn't exist — search for similar files
      console.log(`[DIAG] Suggested file "${suggestedFix.file}" does not exist. Searching for similar files...`);
      const similarFiles = findSimilarFiles(suggestedFix.file);
      if (similarFiles.length > 0) {
        console.log(`[DIAG] Found ${similarFiles.length} similar file(s): ${similarFiles.join(', ')}`);
        for (const similarFile of similarFiles) {
          if (totalContextSize >= TOTAL_CONTEXT_LIMIT) break;
          if (!context[similarFile]) {
            const content = readFileWithLimit(similarFile, PRIMARY_FILE_LIMIT);
            context[similarFile] = content;
            totalContextSize += content.length;
            console.log(`[DIAG] Included similar file: ${similarFile} (${content.length} chars)`);
          }
        }
      } else {
        console.log(`[DIAG] No similar files found for "${suggestedFix.file}"`);
      }
    }
  }

  // If suggested fix specifies multiple files, include them
  if (suggestedFix && suggestedFix.files && Array.isArray(suggestedFix.files)) {
    for (const filePath of suggestedFix.files) {
      if (totalContextSize >= TOTAL_CONTEXT_LIMIT) {
        console.log(`Context budget exhausted (${totalContextSize} chars), skipping remaining files`);
        filesSkipped++;
        continue;
      }
      if (fs.existsSync(filePath) && !context[filePath]) {
        const content = readFileWithLimit(filePath, SECONDARY_FILE_LIMIT);
        context[filePath] = content;
        totalContextSize += content.length;
      }
    }
  }

  // Key files based on keywords
  const filePatterns = [
    { keywords: ['game', 'score', 'timer', 'round'], file: 'ViewModels/GameManager.swift' },
    { keywords: ['multiplayer', 'network', 'peer', 'player'], file: 'Network/MultipeerManager.swift' },
    { keywords: ['category', 'event', 'timeline'], file: 'Models/GameModels.swift' },
    { keywords: ['settings', 'preference', 'config', 'version'], file: 'Views/SettingsView.swift' },
    { keywords: ['content', 'json', 'data', 'load'], file: 'Data/HistoricalEventsData.swift' },
    { keywords: ['audio', 'sound', 'music'], file: 'Core/Services/DefaultAudioService.swift' },
    { keywords: ['setup', 'difficulty', 'mode', 'configure', 'team'], file: 'Views/GameSetupView.swift' },
    { keywords: ['setup', 'help', 'hint', 'bubble', 'tooltip', 'popup'], file: 'Views/GameSetupSections.swift' },
    { keywords: ['help', 'hint', 'bubble', 'tooltip', 'popup', 'info'], file: 'Views/GameSetupView.swift' },
    { keywords: ['view', 'ui', 'display', 'layout'], file: 'Views/ContentView.swift' },
    // BA-007.2: View-specific patterns for UX bugs
    { keywords: ['layout', 'padding', 'spacing', 'frame'], file: 'Views/Game/ModernSortingGameView.swift' },
    { keywords: ['modal', 'sheet', 'overlay'], file: 'Views/Game/ModernSortingGameView.swift' },
    { keywords: ['ipad', 'tablet', 'size class'], file: 'Views/Game/ModernSortingGameView.swift' },
    { keywords: ['menu', 'home', 'main'], file: 'Views/MainMenu/MainMenuView.swift' },
    { keywords: ['top bar', 'topbar', 'navigation', 'header'], file: 'Views/Components/GameTopBarDSKit.swift' },
    { keywords: ['top bar', 'topbar', 'navigation', 'header'], file: 'Views/Components/MenuTopBarDSKit.swift' },
    { keywords: ['statistics', 'stats', 'history', 'record'], file: 'Features/Statistics/Views/StatisticsView.swift' },
    { keywords: ['coordinator', 'navigation', 'deep link', 'deeplink'], file: 'Models/App/AppCoordinator.swift' },
  ];

  for (const pattern of filePatterns) {
    if (totalContextSize >= TOTAL_CONTEXT_LIMIT) {
      console.log(`Context budget exhausted (${totalContextSize} chars), skipping remaining files`);
      filesSkipped++;
      break;
    }
    if (pattern.keywords.some((kw) => combined.includes(kw))) {
      if (fs.existsSync(pattern.file) && !context[pattern.file]) {
        const content = readFileWithLimit(pattern.file, SECONDARY_FILE_LIMIT);
        context[pattern.file] = content;
        totalContextSize += content.length;
      }
    }
  }

  // Scan issue body for explicit Swift file paths (e.g., "Views/SomeView.swift")
  const filePathRegex = /(?:^|\s)([\w/]+\.swift)\b/g;
  let fileMatch;
  while ((fileMatch = filePathRegex.exec(body)) !== null) {
    if (totalContextSize >= TOTAL_CONTEXT_LIMIT) {
      console.log(`Context budget exhausted (${totalContextSize} chars), skipping remaining files`);
      filesSkipped++;
      break;
    }
    const filePath = fileMatch[1];
    if (fs.existsSync(filePath) && !context[filePath]) {
      const content = readFileWithLimit(filePath, SECONDARY_FILE_LIMIT);
      context[filePath] = content;
      totalContextSize += content.length;
    }
  }

  // BA-007.2: Include view file mapped from currentScreen in device info
  const screenViewFile = getViewFileFromScreen(body);
  if (screenViewFile && totalContextSize < TOTAL_CONTEXT_LIMIT) {
    if (fs.existsSync(screenViewFile) && !context[screenViewFile]) {
      const content = readFileWithLimit(screenViewFile, SECONDARY_FILE_LIMIT);
      context[screenViewFile] = content;
      totalContextSize += content.length;
      console.log(`Included view file from currentScreen: ${screenViewFile} (${content.length} chars)`);
    }
  }

  // Always include GameModels.swift for reference
  if (totalContextSize < TOTAL_CONTEXT_LIMIT) {
    if (!context['Models/GameModels.swift'] && fs.existsSync('Models/GameModels.swift')) {
      const content = readFileWithLimit('Models/GameModels.swift', REFERENCE_FILE_LIMIT);
      context['Models/GameModels.swift'] = content;
      totalContextSize += content.length;
    }
  } else {
    filesSkipped++;
  }

  // BA-008.3: Architecture registry — force-include related files and gather arch notes
  const registry = loadArchitectureRegistry();
  if (registry) {
    const archContext = getArchitectureContext(registry, context);

    // Force-include additional files identified by the registry (embeds, viewModel, consumers)
    for (const additionalFile of archContext.additionalFiles) {
      if (totalContextSize >= TOTAL_CONTEXT_LIMIT) {
        console.log(`[ARCH] Context budget exhausted (${totalContextSize} chars), skipping remaining registry files`);
        filesSkipped++;
        break;
      }
      if (fs.existsSync(additionalFile) && !context[additionalFile]) {
        const content = readFileWithLimit(additionalFile, SECONDARY_FILE_LIMIT);
        context[additionalFile] = content;
        totalContextSize += content.length;
        console.log(`[ARCH] Force-included from registry: ${additionalFile} (${content.length} chars)`);
      } else if (!fs.existsSync(additionalFile)) {
        console.warn(`[ARCH] Registry references ${additionalFile} but file not found — skipping (graceful)`);
      }
    }

    // Store architecture notes and behaviors for prompt injection
    _architectureNotes = archContext.archNotes;
    _relevantBehaviors = archContext.relevantBehaviors;

    if (archContext.archNotes.length > 0) {
      console.log(`[ARCH] Collected ${archContext.archNotes.length} architecture note lines for prompt`);
    }
    if (Object.keys(archContext.relevantBehaviors).length > 0) {
      console.log(`[ARCH] Matched ${Object.keys(archContext.relevantBehaviors).length} SwiftUI behavior(s): ${Object.keys(archContext.relevantBehaviors).join(', ')}`);
    }
  } else {
    // Reset to defaults when registry is unavailable
    _architectureNotes = [];
    _relevantBehaviors = {};
  }

  console.log(`Total context: ${totalContextSize} chars across ${Object.keys(context).length} files${filesSkipped > 0 ? ` (${filesSkipped} skipped due to budget)` : ''}`);
  return context;
}

/**
 * Build prompt for Claude code fix generation
 * BA-008.4: Extended to accept RCA result and behavior info for injection
 *
 * @param {Object} issue - GitHub issue object
 * @param {Object} suggestedFix - Extracted suggested fix (may be null)
 * @param {Object} relevantFiles - Map of filePath -> content
 * @param {Object|null} rcaResult - RCA analysis result (null if RCA was skipped/failed)
 * @param {Object|null} behaviorInfo - { expected, actual, warning } (null if not extracted)
 */
function buildCodeFixPrompt(issue, suggestedFix, relevantFiles, rcaResult, behaviorInfo) {
  let contextSection = '';
  for (const [file, content] of Object.entries(relevantFiles)) {
    const isPrimary = suggestedFix?.file === file || (issue.body && issue.body.includes(file));
    const marker = isPrimary ? ' (PRIMARY FIX TARGET)' : '';
    contextSection += `\n### ${file}${marker}\n\`\`\`swift\n${content}\n\`\`\`\n`;
  }

  // BA-007.2: Add SwiftUI-specific context for UX bug fixes
  let uxContextSection = '';
  if (FIX_TYPE === 'ux') {
    uxContextSection = `
## SwiftUI Context
This app uses DSKit for design system components. If the file imports DSKit,
use DSKit patterns (DSTextStyle, DSPadding, etc.).

Common SwiftUI fixes for UX bugs:
- Layout: .frame(maxWidth: .infinity), .padding()
- iPad adaptive: @Environment(\\.horizontalSizeClass)
- Safe areas: .ignoresSafeArea() or .safeAreaInset()
- Modals: .sheet(), .fullScreenCover()\n\n`;
  }

  // BA-008.3: Build architecture context section from registry data
  let architectureSection = '';
  if (_architectureNotes.length > 0 || Object.keys(_relevantBehaviors).length > 0) {
    architectureSection = '\n## Architecture Context\n\n';
    if (_architectureNotes.length > 0) {
      architectureSection += _architectureNotes.join('\n') + '\n\n';
    }
    if (Object.keys(_relevantBehaviors).length > 0) {
      architectureSection += '### SwiftUI Runtime Behaviors (relevant to this bug)\n\n';
      for (const [key, description] of Object.entries(_relevantBehaviors)) {
        architectureSection += `**${key}:** ${description}\n\n`;
      }
    }
  }

  // BA-008.4: Build RCA section if available
  let rcaSection = '';
  if (rcaResult) {
    rcaSection = `\n## Root Cause Analysis

**Root Cause:** ${rcaResult.root_cause}

**Mechanism:** ${rcaResult.mechanism}

**Affected Files:** ${rcaResult.affected_files.join(', ')}

**Fix Strategy:** ${rcaResult.fix_strategy}

**Confidence:** ${rcaResult.confidence}

**Alternative Strategies:**
${rcaResult.alternative_strategies.map(s => `- ${s}`).join('\n')}

IMPORTANT: Follow the fix strategy above. The root cause analysis was performed by a separate reasoning step — trust it unless the code context clearly contradicts it.\n`;
  }

  // BA-008.4: Build behavior section if available
  let behaviorSection = '';
  if (behaviorInfo) {
    if (behaviorInfo.expected || behaviorInfo.actual) {
      behaviorSection = '\n## Expected vs Actual Behavior\n';
      if (behaviorInfo.expected) {
        behaviorSection += `**Expected:** ${behaviorInfo.expected}\n`;
      }
      if (behaviorInfo.actual) {
        behaviorSection += `**Actual:** ${behaviorInfo.actual}\n`;
      }
      behaviorSection += '\n';
    }
    if (behaviorInfo.warning) {
      behaviorSection += `${behaviorInfo.warning}\n\n`;
    }
  }

  let prompt = `You are a senior iOS developer fixing a bug in the Sorting History app - a history timeline game built with SwiftUI.

## Bug Report

**Title:** ${issue.title}

**Description:**
${issue.body}

${suggestedFix ? `## Previous Analysis Suggestion\n${JSON.stringify(suggestedFix, null, 2)}` : ''}
${rcaSection}${behaviorSection}
## Relevant Code Context
${contextSection}
${uxContextSection}${architectureSection}
## Your Task

Generate the EXACT code changes needed to fix this bug. For each file that needs modification:

1. Specify the full file path
2. Use search/replace with exact code snippets
3. Make sure the code compiles and is syntactically correct

CRITICAL REQUIREMENTS:
- Generate ACTUAL working Swift code, not placeholders or TODOs
- Use the EXACT text that appears in the file for the search string
- Keep changes minimal and focused on the fix
- Do not change unrelated code
- You can ONLY modify files shown in "Relevant Code Context" above. Do NOT reference files not shown. Do NOT create new files — action must be "replace" or "insert_after", NEVER "create".
- If the Previous Analysis Suggestion references a file that is NOT in the context above, IGNORE that suggestion and work only with the files you can see.
- File contents above may be TRUNCATED (look for "[TRUNCATED]" markers). Your search text MUST use ONLY code visible in the provided context. Do NOT guess, infer, or reconstruct code beyond what is shown.
- Your search text MUST include the EXACT indentation (leading spaces) as shown in the context above.

Respond in this exact JSON format:
{
  "modifications": [
    {
      "file": "ViewModels/GameManager.swift",
      "action": "replace",
      "search": "// Exact multi-line code to find",
      "replace": "// Exact multi-line replacement code"
    }
  ],
  "summary": "Brief description of the fix (one sentence)",
  "testInstructions": "How to verify the fix works"
}

JSON ONLY - no other text.`;

  // BA-008.9: Retry/previous-attempt context is now appended by iterativeFixLoop(),
  // not here. The base prompt stays clean; the loop adds PREVIOUS ATTEMPTS and
  // outer retry context as needed per iteration.

  return prompt;
}

/**
 * Parse Claude's code fix response
 * BA-007.23: Robust JSON parsing with code-fence extraction,
 * balanced-brace fallback, and per-modification validation.
 */
function parseCodeFixResponse(text) {
  // Log the raw response for diagnostics
  console.log(`[DIAG] Raw AI response (${text.length} chars):\n${text}`);

  // Strategy 1: Try to find JSON in a code fence first (most reliable)
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);

  // Strategy 2: Fall back to finding a standalone JSON object
  // Use a balanced-brace approach instead of greedy regex
  let jsonStr = null;

  if (fenceMatch) {
    jsonStr = fenceMatch[1];
    console.log('[DIAG] Extracted JSON from code fence');
  } else {
    // Find the first { and match to its balanced closing }
    const startIdx = text.indexOf('{');
    if (startIdx === -1) {
      console.error('[DIAG] No JSON object found in response — no opening brace');
      return null;
    }

    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }

    if (endIdx === -1) {
      console.error('[DIAG] Unbalanced braces in response — could not find matching }');
      return null;
    }

    jsonStr = text.substring(startIdx, endIdx + 1);
    console.log('[DIAG] Extracted JSON via balanced-brace matching');
  }

  // Parse
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error(`[DIAG] JSON parse failed: ${e.message}`);
    console.error(`[DIAG] Attempted to parse:\n${jsonStr.substring(0, 500)}`);
    return null;
  }

  // Validate structure
  if (!parsed.modifications || !Array.isArray(parsed.modifications)) {
    console.error('[DIAG] Parsed JSON has no "modifications" array');
    console.error(`[DIAG] Top-level keys: ${Object.keys(parsed).join(', ')}`);
    return null;
  }

  // Validate each modification
  const validMods = [];
  for (let i = 0; i < parsed.modifications.length; i++) {
    const mod = parsed.modifications[i];

    if (!mod.file) {
      console.error(`[DIAG] Modification ${i + 1}/${parsed.modifications.length}: missing "file" field — skipping`);
      continue;
    }
    if (!mod.action) {
      console.error(`[DIAG] Modification ${i + 1}/${parsed.modifications.length}: missing "action" field — skipping`);
      continue;
    }
    if (mod.action === 'replace' && (!mod.search || !mod.replace)) {
      console.error(`[DIAG] Modification ${i + 1}/${parsed.modifications.length}: action=replace but missing search/replace — skipping`);
      continue;
    }
    if (mod.action === 'insert_after' && (!mod.marker || !mod.code)) {
      console.error(`[DIAG] Modification ${i + 1}/${parsed.modifications.length}: action=insert_after but missing marker/code — skipping`);
      continue;
    }

    validMods.push(mod);
  }

  if (validMods.length < parsed.modifications.length) {
    console.log(`[DIAG] ${parsed.modifications.length - validMods.length} modification(s) failed validation and were skipped`);
  }

  parsed.modifications = validMods;
  return parsed;
}

/**
 * Normalize indentation: collapse leading whitespace on each line.
 * BA-007.23: Used for whitespace-tolerant search matching.
 */
function normalizeIndentation(text) {
  return text.split('\n').map(line => line.trimStart()).join('\n');
}

/**
 * Attempt whitespace-normalized matching and return the replacement
 * with the original file's indentation preserved.
 * Returns { matched: true, result: string } or { matched: false }.
 * BA-007.23: Whitespace-tolerant search matching.
 */
function normalizedSearchReplace(content, search, replace) {
  const searchLines = search.split('\n').map(l => l.trimStart());
  const contentLines = content.split('\n');

  let matchStartLine = -1;
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trimStart() !== searchLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchStartLine = i;
      break;
    }
  }

  if (matchStartLine < 0) {
    return { matched: false };
  }

  // Determine the indentation of the first matched line in the original file
  const originalIndent = contentLines[matchStartLine].match(/^(\s*)/)[1];

  // Determine the base indentation from the AI's search text
  const searchBaseIndent = search.split('\n')[0].match(/^(\s*)/)[1];

  // Apply the replacement, preserving the original file's indentation
  const replaceLines = replace.split('\n');
  const reindentedReplace = replaceLines.map((line, idx) => {
    if (idx === 0) return originalIndent + line.trimStart();
    // Preserve relative indentation from the AI's replacement
    const lineIndent = line.match(/^(\s*)/)[1];
    const relativeIndent = lineIndent.length - searchBaseIndent.length;
    const newIndent = originalIndent + ' '.repeat(Math.max(0, relativeIndent));
    return newIndent + line.trimStart();
  }).join('\n');

  // Replace the original lines
  const matchedOriginalLines = contentLines.slice(matchStartLine, matchStartLine + searchLines.length);
  const originalText = matchedOriginalLines.join('\n');
  const result = content.replace(originalText, reindentedReplace);

  return { matched: true, result, indent: originalIndent.length };
}

/**
 * Log diagnostic near-miss information when a search string is not found.
 * BA-007.23: Diagnostic logging for failed matches.
 */
function logNearMisses(content, search, file, modIndex, totalMods) {
  console.error(`[DIAG] Search text NOT FOUND in ${file} (modification ${modIndex}/${totalMods})`);
  console.error(`[DIAG] Full search text (${search.length} chars):\n${search}`);

  // Show what the file actually contains near likely match points
  const searchFirstLine = search.split('\n')[0].trim();
  if (!searchFirstLine) {
    console.error(`[DIAG] Search text first line is empty — cannot detect near-misses`);
    return;
  }

  const fileLines = content.split('\n');
  const nearMisses = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim().includes(searchFirstLine) ||
        searchFirstLine.includes(fileLines[i].trim())) {
      nearMisses.push({ line: i + 1, content: fileLines[i] });
    }
  }
  if (nearMisses.length > 0) {
    console.error(`[DIAG] Near-misses found (first line of search appears at):`);
    for (const nm of nearMisses) {
      console.error(`  Line ${nm.line}: "${nm.content.substring(0, 120)}"`);
    }
  } else {
    console.error(`[DIAG] No near-misses — first line of search "${searchFirstLine}" not found anywhere in file`);
  }
}

/**
 * Apply a single file modification
 * BA-007.23: Whitespace-tolerant matching, diagnostic logging, modification index tracking.
 * @param {object} mod - The modification object
 * @param {number} modIndex - 1-based index of this modification (e.g., 1)
 * @param {number} totalMods - Total number of modifications (e.g., 3)
 */
async function applyModification(mod, modIndex = 1, totalMods = 1) {
  // BA-007.25: Reject file creation — only modifications to existing files are allowed
  if (mod.action === 'create') {
    console.error(`[DIAG] REJECTED: File creation not allowed (modification ${modIndex}/${totalMods}). AI tried to create "${mod.file}". Only "replace" and "insert_after" actions on existing files are supported.`);
    return false;
  }

  if (!mod.file || !fs.existsSync(mod.file)) {
    console.error(`[DIAG] File not found: ${mod.file} (modification ${modIndex}/${totalMods})`);
    return false;
  }

  let content = fs.readFileSync(mod.file, 'utf8');

  if (mod.action === 'replace' && mod.search && mod.replace) {
    // Phase 1: Try exact match first (preserves current behavior for simple cases)
    if (content.includes(mod.search)) {
      content = content.replace(mod.search, mod.replace);
      fs.writeFileSync(mod.file, content);
      console.log(`[DIAG] Applied modification ${modIndex}/${totalMods} to ${mod.file} (exact match)`);
      return true;
    }

    // Phase 2: Try whitespace-normalized matching
    const normalized = normalizedSearchReplace(content, mod.search, mod.replace);
    if (normalized.matched) {
      fs.writeFileSync(mod.file, normalized.result);
      console.log(`[DIAG] Applied modification ${modIndex}/${totalMods} to ${mod.file} via whitespace-normalized match (original indent: ${normalized.indent} spaces)`);
      return true;
    }

    // Both phases failed — log diagnostics
    logNearMisses(content, mod.search, mod.file, modIndex, totalMods);
    return false;
  }

  if (mod.action === 'insert_after' && mod.marker && mod.code) {
    // Phase 1: Try exact match for marker
    if (content.includes(mod.marker)) {
      content = content.replace(mod.marker, mod.marker + '\n' + mod.code);
      fs.writeFileSync(mod.file, content);
      console.log(`[DIAG] Inserted code after marker in ${mod.file} (modification ${modIndex}/${totalMods}, exact match)`);
      return true;
    }

    // Phase 2: Try whitespace-normalized matching for marker
    // For insert_after, we find the marker via normalized match, then insert after it
    const markerLines = mod.marker.split('\n').map(l => l.trimStart());
    const contentLines = content.split('\n');

    let matchStartLine = -1;
    for (let i = 0; i <= contentLines.length - markerLines.length; i++) {
      let matches = true;
      for (let j = 0; j < markerLines.length; j++) {
        if (contentLines[i + j].trimStart() !== markerLines[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        matchStartLine = i;
        break;
      }
    }

    if (matchStartLine >= 0) {
      const matchEndLine = matchStartLine + markerLines.length - 1;
      const originalIndent = contentLines[matchStartLine].match(/^(\s*)/)[1];

      // Re-indent the inserted code to match the original file's indentation
      const codeLines = mod.code.split('\n');
      const reindentedCode = codeLines.map(line => {
        return originalIndent + line.trimStart();
      }).join('\n');

      // Insert after the matched marker lines
      contentLines.splice(matchEndLine + 1, 0, reindentedCode);
      content = contentLines.join('\n');
      fs.writeFileSync(mod.file, content);
      console.log(`[DIAG] Inserted code after marker in ${mod.file} (modification ${modIndex}/${totalMods}, whitespace-normalized match, indent: ${originalIndent.length} spaces)`);
      return true;
    }

    // Both phases failed — log diagnostics
    logNearMisses(content, mod.marker, mod.file, modIndex, totalMods);
    return false;
  }

  console.error(`[DIAG] Unknown modification action: ${mod.action} (modification ${modIndex}/${totalMods})`);
  return false;
}

/**
 * Read the NEXT_ALPHA_VERSION GitHub Actions variable from the private repo.
 * Uses the GitHub REST API: GET /repos/{owner}/{repo}/actions/variables/{name}
 *
 * Returns { success: true, value: "N" } on success,
 * or { success: false } on any failure (network, auth, missing variable).
 */
async function getNextVersionFromVariable() {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/variables/NEXT_ALPHA_VERSION`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-AutoFix',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      console.warn(`GitHub variable read failed: ${response.status} ${response.statusText}`);
      return { success: false };
    }

    const data = await response.json();
    const value = data.value;

    if (!value || isNaN(parseInt(value))) {
      console.warn(`GitHub variable NEXT_ALPHA_VERSION has invalid value: "${value}"`);
      return { success: false };
    }

    console.log(`Read NEXT_ALPHA_VERSION from GitHub: ${value}`);
    return { success: true, value: value };
  } catch (e) {
    console.warn(`GitHub variable read error: ${e.message}`);
    return { success: false };
  }
}

/**
 * Update the NEXT_ALPHA_VERSION GitHub Actions variable on the private repo.
 * Uses the GitHub REST API: PATCH /repos/{owner}/{repo}/actions/variables/{name}
 *
 * @param {string} newValue - The new value to set (e.g., "135")
 * @returns {boolean} true on success, false on failure
 */
async function setVersionVariable(newValue) {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/variables/NEXT_ALPHA_VERSION`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'SortingHistory-AutoFix',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        name: 'NEXT_ALPHA_VERSION',
        value: String(newValue),
      }),
    });

    if (!response.ok) {
      console.error(`GitHub variable update failed: ${response.status} ${response.statusText}`);
      return false;
    }

    console.log(`Updated NEXT_ALPHA_VERSION to ${newValue}`);
    return true;
  } catch (e) {
    console.error(`GitHub variable update error: ${e.message}`);
    return false;
  }
}

/**
 * Update version string in SettingsView.swift.
 *
 * Primary approach: Reads the centralized NEXT_ALPHA_VERSION GitHub Actions
 * variable from the private repo, uses it as the alpha suffix, writes it to
 * SettingsView.swift, then increments the variable for the next pipeline run.
 * This prevents version collisions across branches.
 *
 * Fallback: If the GitHub variable API call fails for any reason (network,
 * auth, missing variable), falls back to the original behavior of reading
 * the current version from SettingsView.swift and incrementing by 1.
 */
async function updateVersionString() {
  if (!fs.existsSync(SETTINGS_VIEW_PATH)) {
    console.log('SettingsView.swift not found, skipping version update');
    return;
  }

  let content = fs.readFileSync(SETTINGS_VIEW_PATH, 'utf8');

  // Parse current version pattern: "1.1.0-alpha.XXX"
  const versionMatch = content.match(/value:\s*"(\d+\.\d+\.\d+)-alpha\.(\d+)"/);
  if (!versionMatch) {
    console.log('Could not find version string to update');
    return;
  }

  const [fullMatch, version] = versionMatch;

  // Primary: try centralized GitHub variable
  const variableResult = await getNextVersionFromVariable();

  if (variableResult.success) {
    const newAlpha = parseInt(variableResult.value);
    const newVersion = `value: "${version}-alpha.${newAlpha}"`;

    content = content.replace(fullMatch, newVersion);
    fs.writeFileSync(SETTINGS_VIEW_PATH, content);
    console.log(`Updated version to ${version}-alpha.${newAlpha} (from GitHub variable)`);

    // Increment and store next value
    const nextValue = newAlpha + 1;
    const writeSuccess = await setVersionVariable(String(nextValue));
    if (!writeSuccess) {
      console.warn(`Warning: Version ${newAlpha} was used but NEXT_ALPHA_VERSION was not incremented to ${nextValue}. Next run may reuse this version.`);
    }
    return;
  }

  // Fallback: file-based increment (original behavior)
  console.warn('Falling back to file-based version increment (GitHub variable unavailable)');
  const alpha = versionMatch[2];
  const newAlpha = parseInt(alpha) + 1;
  const newVersion = `value: "${version}-alpha.${newAlpha}"`;

  content = content.replace(fullMatch, newVersion);
  fs.writeFileSync(SETTINGS_VIEW_PATH, content);
  console.log(`Updated version to ${version}-alpha.${newAlpha} (file-based fallback)`);
}

/**
 * Set GitHub Actions output
 */
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  const strValue = String(value);
  if (outputFile) {
    if (strValue.includes('\n')) {
      const delimiter = 'GHEOF_' + Date.now();
      fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${strValue}\n${delimiter}\n`);
    } else {
      fs.appendFileSync(outputFile, `${name}=${strValue}\n`);
    }
  }
  console.log(`Output: ${name}=${strValue}`);
}

/**
 * Fact-check a content fix using a second LLM call (QG-004)
 * Advisory only -- never blocks a fix.
 * Returns { verified, confidence, source, concern }
 */
async function factCheckContentFix(issue, eventTitle, changes) {
  console.log('\n--- Content Fact-Check ---');

  if (!OPENROUTER_API_KEY) {
    console.log('Fact-check skipped: No API key available');
    return { verified: false, confidence: 'unknown', concern: 'No API key' };
  }

  let checkPrompt = `You are a history fact-checker. A user reported a problem with this game content:\n\n`;
  checkPrompt += `**User's bug report:** ${issue.title}\n${issue.body || ''}\n\n`;
  checkPrompt += `**Event:** "${eventTitle}"\n`;
  checkPrompt += `**Changes being applied:**\n`;

  for (const [field, { from, to }] of Object.entries(changes)) {
    checkPrompt += `- ${field}: ${from} → ${to}\n`;
  }

  checkPrompt += `\nIs the NEW value factually correct for this historical event? Only check what's being changed.

Respond in JSON only:
{
  "verified": true/false,
  "confidence": "high"/"medium"/"low",
  "source": "Brief reasoning or citation",
  "concern": "If not verified, explain why"
}

JSON ONLY.`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sortinghistory.com',
        'X-Title': 'Sorting History Fact Check',
      },
      body: JSON.stringify({
        model: FACT_CHECK_MODEL,
        messages: [{ role: 'user', content: checkPrompt }],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.log(`Fact-check API call failed: ${response.status}`);
      return { verified: false, confidence: 'unknown', concern: 'API call failed' };
    }

    const result = await response.json();
    const text = result.choices?.[0]?.message?.content || '';

    // Use balanced-brace matching instead of greedy regex
    const startIdx = text.indexOf('{');
    if (startIdx === -1) {
      console.log('Fact-check: No JSON object found in response');
      return { verified: false, confidence: 'unknown', concern: 'No JSON in response' };
    }

    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }

    if (endIdx === -1) {
      console.log('Fact-check: Unbalanced braces in response');
      return { verified: false, confidence: 'unknown', concern: 'Malformed JSON' };
    }

    const jsonStr = text.substring(startIdx, endIdx + 1);
    const check = JSON.parse(jsonStr);
    console.log(`Fact-check: verified=${check.verified}, confidence=${check.confidence}`);
    if (check.source) console.log(`Fact-check source: ${check.source}`);
    if (check.concern) console.log(`Fact-check concern: ${check.concern}`);
    return check;
  } catch (e) {
    console.error('Fact-check error:', e.message);
  }

  return { verified: false, confidence: 'unknown', concern: 'Could not parse response' };
}

/**
 * QG-001: Pre-commit build validation
 *
 * Runs xcodebuild to verify the fix compiles before committing.
 * Only called for code/ux fixes (content fixes skip this).
 * Returns { success: true } or { success: false, error: string }
 */
function validateBuild() {
  console.log('\n--- Pre-Commit Build Validation (QG-001) ---');
  console.log('Running xcodebuild build...');

  try {
    execSync(
      'xcodebuild build ' +
      '-scheme SortingHistory ' +
      '-destination "platform=iOS Simulator,name=iPhone 16,OS=18.2" ' +
      'CODE_SIGNING_ALLOWED=NO',
      {
        timeout: BUILD_TIMEOUT_MS,
        stdio: 'pipe',
        cwd: process.cwd(),
        maxBuffer: 50 * 1024 * 1024
      }
    );
    console.log('Build validation: PASSED');
    return { success: true };
  } catch (error) {
    const stderr = error.stderr?.toString() || '';
    const stdout = error.stdout?.toString() || '';
    const errorOutput = (stderr + '\n' + stdout).trim() || error.message;

    // Extract only lines containing 'error:' for a concise summary
    const errorLines = errorOutput
      .split('\n')
      .filter(line => line.includes('error:'))
      .slice(0, 20)
      .join('\n');

    // Cap at 2000 chars to prevent massive log dumps
    const errorSummary = (errorLines || errorOutput).substring(0, 2000);

    console.log('Build validation: FAILED');
    console.log(`Build errors:\n${errorSummary}`);
    return { success: false, error: errorSummary };
  }
}

// QG-002 retryFixWithError() — REMOVED (BA-008.9)
// The iterative inner loop in iterativeFixLoop() now handles all compile failures
// and QA rejections. The standalone retry function is superseded.

/**
 * Main function
 */
async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Bug Fix Application Script`);
  console.log(`Issue: #${ISSUE_NUMBER}`);
  console.log(`Type: ${FIX_TYPE}`);
  if (IS_RETRY) {
    console.log(`RETRY: attempt ${ATTEMPT_NUMBER} (previous fix rejected)`);
    console.log(`Rejection reason: ${REJECTION_REASON}`);
  }
  console.log(`${'='.repeat(50)}\n`);

  // Validate environment
  if (!GITHUB_TOKEN) {
    console.error('PRIVATE_REPO_TOKEN (or GITHUB_TOKEN) not set');
    process.exit(1);
  }
  if (!ISSUE_NUMBER) {
    console.error('ISSUE_NUMBER not set');
    process.exit(1);
  }

  try {
    // Fetch issue and comments
    console.log('Fetching issue details...');
    const { issue, comments } = await fetchIssueWithComments();

    // Extract suggested fix from analysis
    let suggestedFix = extractSuggestedFix(comments);

    if (suggestedFix) {
      console.log('Found suggested fix:', JSON.stringify(suggestedFix, null, 2));

      // BA-008.2 P1-8: Validate pre-analysis before using it
      // Script runs with working-directory: game-code, so cwd IS the game code root
      const gameCodePath = process.cwd();
      const validation = validatePreAnalysis(suggestedFix, gameCodePath);
      if (!validation.valid) {
        console.log(`[WARN] Pre-analysis excluded: ${validation.reason}`);
        suggestedFix = null;
      } else {
        console.log('[INFO] Pre-analysis validated, injecting into prompt');
      }
    } else {
      console.log('No structured fix data found, will attempt smart detection');
    }

    // Apply fix based on type
    let success = false;
    let contentFilePath = null;

    console.log(`\n[DEBUG] Fix type routing: FIX_TYPE="${FIX_TYPE}"`);
    console.log(`[DEBUG] Content fix path: ${FIX_TYPE === 'content' ? 'YES' : 'NO'}`);
    console.log(`[DEBUG] Code fix path: ${FIX_TYPE !== 'content' ? 'YES' : 'NO'}`);

    if (FIX_TYPE === 'content') {
      console.log('[DEBUG] Entering content fix path...');
      const result = await applyContentFix(suggestedFix, issue);
      success = result.success;
      contentFilePath = result.filePath;

      // Fact-check content changes (QG-004 - advisory only, never blocks)
      if (success && result.changes && Object.keys(result.changes).length > 0) {
        const factCheck = await factCheckContentFix(issue, result.eventTitle, result.changes);
        setOutput('fact_check_verified', factCheck.verified.toString());
        setOutput('fact_check_confidence', factCheck.confidence || 'unknown');

        if (!factCheck.verified || factCheck.confidence === 'low') {
          setOutput('needs_fact_check', 'true');
          setOutput('fact_check_concern', factCheck.concern || 'Unverified');
        }
      }
    } else {
      // All non-content bugs (code, ux, other) route to Claude Opus 4.5
      // for intelligent fix generation
      console.log(`[DEBUG] Entering code fix path (FIX_TYPE=${FIX_TYPE})...`);
      console.log(`Fix type: ${FIX_TYPE} - routing to iterative fix loop (model: ${FIX_MODEL})`);
      success = await applyCodeFix(suggestedFix, issue);
    }
    console.log(`[DEBUG] Fix path completed. Success: ${success}`);

    // BA-008.9: Build validation for code/ux fixes is now handled INSIDE iterativeFixLoop().
    // The inner loop compiles + QA reviews before returning success.
    // Content fixes skip build validation entirely.
    if (success && FIX_TYPE === 'content') {
      console.log('Content fix -- skipping build validation (content fixes are JSON-only)');
    } else if (success && FIX_TYPE !== 'content') {
      console.log('Code/UX fix -- build validation already passed inside inner loop (BA-008.9)');
    }

    if (success) {
      // For content fixes, validate the modified JSON (AC2)
      let validationPassed = true;
      if (FIX_TYPE === 'content' && contentFilePath) {
        console.log(`\nValidating modified JSON: ${contentFilePath}`);
        const validation = validateContentJSON(contentFilePath);

        if (validation.valid) {
          console.log('JSON validation passed');
          setOutput('validation_failed', 'false');
        } else {
          // Validation failed -- handle per AC5
          console.log('JSON validation FAILED');
          handleValidationFailure(contentFilePath, validation);
          validationPassed = false;
          // Do NOT return false -- the fix was applied, but it needs manual review
        }
      }

      // Only update version string if the fix was actually successful
      // (code fixes already call updateVersionString internally)
      // Do NOT update version if validation failed - the fix needs manual review
      if (FIX_TYPE === 'content' && validationPassed) {
        await updateVersionString();
      } else if (FIX_TYPE === 'content' && !validationPassed) {
        console.log('Skipping version update: JSON validation failed, manual review required');
      }

      // Determine severity (for informational output only -- no auto-merge)
      const severity = await getIssueSeverity();
      setOutput('severity', severity);
      console.log(`Severity: ${severity} (all fixes require manual review and merge)`);

      console.log('\nFix applied successfully!');
    } else {
      console.log('\nCould not apply fix automatically');
      console.log('No files were modified - version string will NOT be updated');
      setOutput('applied', 'false');
      setOutput('summary', 'Manual fix required');
    }
  } catch (error) {
    console.error('Fix application failed:', error.message);
    setOutput('applied', 'false');
    setOutput('summary', `Error: ${error.message}`);
    process.exit(1);
  }
}

main();
