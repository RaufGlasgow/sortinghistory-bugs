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

// Debug: log resolved env vars so future failures are diagnosable
console.log(`Repository: ${GITHUB_REPOSITORY}`);
console.log(`Token present: ${!!GITHUB_TOKEN}`);

// OpenRouter configuration
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CODE_MODEL = 'anthropic/claude-opus-4.6';
const FACT_CHECK_MODEL = 'moonshotai/kimi-k2.5';

// Paths
const DATA_EVENTS_PATH = 'Data/Events';
const SETTINGS_VIEW_PATH = 'Views/SettingsView.swift';

// Required fields for content event validation (AC2)
const REQUIRED_EVENT_FIELDS = ['title', 'year', 'description'];

// Context gathering limits (QG-005 / BA-007.8)
const PRIMARY_FILE_LIMIT = 20000;    // Primary fix target
const SECONDARY_FILE_LIMIT = 12000;  // Related files (keyword match, explicit paths)
const REFERENCE_FILE_LIMIT = 8000;   // Always-included reference files
const TOTAL_CONTEXT_LIMIT = 80000;   // Hard cap across all files

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

/**
 * Apply a code fix using Claude
 */
async function applyCodeFix(suggestedFix, issue) {
  console.log('Applying code fix...');
  console.log(`[DEBUG] Code fix model: ${CODE_MODEL}`);
  console.log(`[DEBUG] OPENROUTER_API_KEY present: ${OPENROUTER_API_KEY ? 'YES (length: ' + OPENROUTER_API_KEY.length + ')' : 'NO'}`);

  // If we have a direct fix from analysis, try it first
  if (suggestedFix && suggestedFix.file && suggestedFix.searchText && suggestedFix.replaceText) {
    const filePath = suggestedFix.file;

    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');

      if (content.includes(suggestedFix.searchText)) {
        content = content.replace(suggestedFix.searchText, suggestedFix.replaceText);
        fs.writeFileSync(filePath, content);

        console.log(`Applied fix to ${filePath}`);
        await updateVersionString();
        setOutput('applied', 'true');
        setOutput('summary', suggestedFix.description || `Fixed code in ${path.basename(filePath)}`);
        return true;
      }
    }
  }

  // If no direct fix or it failed, use Claude to generate a fix
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set - cannot generate code fix');
    setOutput('applied', 'false');
    return false;
  }

  console.log('Generating code fix with Claude...');

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

    // Build prompt
    const prompt = buildCodeFixPrompt(issue, suggestedFix, relevantFiles);

    // Call Claude via OpenRouter
    console.log(`[DEBUG] Calling OpenRouter API...`);
    console.log(`[DEBUG] Model: ${CODE_MODEL}`);
    console.log(`[DEBUG] Prompt length: ${prompt.length} chars`);

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sortinghistory.com',
        'X-Title': 'Sorting History Bug Fix',
      },
      body: JSON.stringify({
        model: CODE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
      }),
    });

    console.log(`[DEBUG] OpenRouter response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[DEBUG] OpenRouter error response body: ${errorBody}`);
      throw new Error(`OpenRouter error: ${response.status} - ${errorBody}`);
    }

    const result = await response.json();
    console.log(`[DEBUG] OpenRouter response received, choices: ${result.choices?.length || 0}`);

    const fixText = result.choices?.[0]?.message?.content;
    console.log(`[DEBUG] Fix text length: ${fixText?.length || 0} chars`);

    if (!fixText) {
      throw new Error('No response from Claude');
    }

    // Parse and apply the fix
    const fixData = parseCodeFixResponse(fixText);

    if (!fixData || !fixData.modifications || fixData.modifications.length === 0) {
      console.error('Could not parse fix from Claude response');
      setOutput('applied', 'false');
      return false;
    }

    // Apply each modification
    let appliedCount = 0;
    const modifiedFiles = [];
    for (const mod of fixData.modifications) {
      if (await applyModification(mod)) {
        appliedCount++;
        if (mod.file && !modifiedFiles.includes(mod.file)) {
          modifiedFiles.push(mod.file);
        }
      }
    }

    if (appliedCount > 0) {
      await updateVersionString();
      setOutput('applied', 'true');
      setOutput('summary', fixData.summary || `Applied ${appliedCount} code change(s)`);
      setOutput('modified_files', modifiedFiles.join(', '));
      if (fixData.testInstructions) {
        setOutput('test_instructions', fixData.testInstructions);
      }
      return true;
    }

    setOutput('applied', 'false');
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
 * Gather relevant code context for Claude
 */
async function gatherRelevantContext(issue, suggestedFix) {
  const context = {};
  let totalContextSize = 0;
  let filesSkipped = 0;
  const body = issue.body || '';
  const title = issue.title || '';
  const combined = `${title} ${body}`.toLowerCase();

  // If suggested fix specifies a file, always include it with more context
  if (suggestedFix && suggestedFix.file && fs.existsSync(suggestedFix.file)) {
    const content = fs.readFileSync(suggestedFix.file, 'utf8').substring(0, PRIMARY_FILE_LIMIT);
    context[suggestedFix.file] = content;
    totalContextSize += content.length;
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
        const content = fs.readFileSync(filePath, 'utf8').substring(0, SECONDARY_FILE_LIMIT);
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
    { keywords: ['settings', 'preference', 'config'], file: 'Views/SettingsView.swift' },
    { keywords: ['content', 'json', 'data', 'load'], file: 'Data/HistoricalEventsData.swift' },
    { keywords: ['audio', 'sound', 'music'], file: 'Core/Services/DefaultAudioService.swift' },
    { keywords: ['setup', 'difficulty', 'mode'], file: 'Views/GameSetupView.swift' },
    { keywords: ['view', 'ui', 'display', 'layout'], file: 'Views/ContentView.swift' },
    // BA-007.2: View-specific patterns for UX bugs
    { keywords: ['layout', 'padding', 'spacing', 'frame'], file: 'Views/Game/ModernSortingGameView.swift' },
    { keywords: ['modal', 'sheet', 'overlay', 'popup'], file: 'Views/Game/ModernSortingGameView.swift' },
    { keywords: ['ipad', 'tablet', 'size class'], file: 'Views/Game/ModernSortingGameView.swift' },
    { keywords: ['menu', 'home', 'main'], file: 'Views/MainMenu/MainMenuView.swift' },
    { keywords: ['setup', 'configure', 'team'], file: 'Views/GameSetupView.swift' },
  ];

  for (const pattern of filePatterns) {
    if (totalContextSize >= TOTAL_CONTEXT_LIMIT) {
      console.log(`Context budget exhausted (${totalContextSize} chars), skipping remaining files`);
      filesSkipped++;
      break;
    }
    if (pattern.keywords.some((kw) => combined.includes(kw))) {
      if (fs.existsSync(pattern.file) && !context[pattern.file]) {
        const content = fs.readFileSync(pattern.file, 'utf8').substring(0, SECONDARY_FILE_LIMIT);
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
      const content = fs.readFileSync(filePath, 'utf8').substring(0, SECONDARY_FILE_LIMIT);
      context[filePath] = content;
      totalContextSize += content.length;
    }
  }

  // BA-007.2: Include view file mapped from currentScreen in device info
  const screenViewFile = getViewFileFromScreen(body);
  if (screenViewFile && totalContextSize < TOTAL_CONTEXT_LIMIT) {
    if (fs.existsSync(screenViewFile) && !context[screenViewFile]) {
      const content = fs.readFileSync(screenViewFile, 'utf8').substring(0, SECONDARY_FILE_LIMIT);
      context[screenViewFile] = content;
      totalContextSize += content.length;
      console.log(`Included view file from currentScreen: ${screenViewFile} (${content.length} chars)`);
    }
  }

  // Always include GameModels.swift for reference
  if (totalContextSize < TOTAL_CONTEXT_LIMIT) {
    if (!context['Models/GameModels.swift'] && fs.existsSync('Models/GameModels.swift')) {
      const content = fs.readFileSync('Models/GameModels.swift', 'utf8').substring(0, REFERENCE_FILE_LIMIT);
      context['Models/GameModels.swift'] = content;
      totalContextSize += content.length;
    }
  } else {
    filesSkipped++;
  }

  console.log(`Total context: ${totalContextSize} chars across ${Object.keys(context).length} files${filesSkipped > 0 ? ` (${filesSkipped} skipped due to budget)` : ''}`);
  return context;
}

/**
 * Build prompt for Claude code fix generation
 */
function buildCodeFixPrompt(issue, suggestedFix, relevantFiles) {
  let contextSection = '';
  for (const [file, content] of Object.entries(relevantFiles)) {
    contextSection += `\n### ${file}\n\`\`\`swift\n${content}\n\`\`\`\n`;
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

  return `You are a senior iOS developer fixing a bug in the Sorting History app - a history timeline game built with SwiftUI.

## Bug Report

**Title:** ${issue.title}

**Description:**
${issue.body}

${suggestedFix ? `## Previous Analysis Suggestion\n${JSON.stringify(suggestedFix, null, 2)}` : ''}

## Relevant Code Context
${contextSection}
${uxContextSection}
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
}

/**
 * Parse Claude's code fix response
 */
function parseCodeFixResponse(text) {
  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('No JSON found in response');
    return null;
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Failed to parse JSON:', e.message);
    return null;
  }
}

/**
 * Apply a single file modification
 */
async function applyModification(mod) {
  if (!mod.file || !fs.existsSync(mod.file)) {
    console.error(`File not found: ${mod.file}`);
    return false;
  }

  let content = fs.readFileSync(mod.file, 'utf8');

  if (mod.action === 'replace' && mod.search && mod.replace) {
    if (!content.includes(mod.search)) {
      console.error(`Search text not found in ${mod.file}`);
      console.log('Looking for:', mod.search.substring(0, 100));
      return false;
    }

    content = content.replace(mod.search, mod.replace);
    fs.writeFileSync(mod.file, content);
    console.log(`Applied modification to ${mod.file}`);
    return true;
  }

  if (mod.action === 'insert_after' && mod.marker && mod.code) {
    if (!content.includes(mod.marker)) {
      console.error(`Marker not found in ${mod.file}`);
      return false;
    }

    content = content.replace(mod.marker, mod.marker + '\n' + mod.code);
    fs.writeFileSync(mod.file, content);
    console.log(`Inserted code after marker in ${mod.file}`);
    return true;
  }

  console.error(`Unknown modification action: ${mod.action}`);
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
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const check = JSON.parse(jsonMatch[0]);
      console.log(`Fact-check: verified=${check.verified}, confidence=${check.confidence}`);
      if (check.source) console.log(`Fact-check source: ${check.source}`);
      if (check.concern) console.log(`Fact-check concern: ${check.concern}`);
      return check;
    }
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

/**
 * QG-002: Retry a failed fix by feeding the build error back to Claude.
 *
 * Reverts the broken attempt, re-gathers context (files now clean),
 * builds a retry prompt that includes the compilation error, calls
 * Claude again, applies the revised fix, and validates the build.
 *
 * Returns { success: true } if the retry fix compiles, otherwise
 * { success: false, retryError: string? } after reverting everything.
 *
 * Called at most ONCE per fix attempt (no recursion, no loops).
 */
async function retryFixWithError(issue, originalFix, buildError) {
  console.log('\n--- Retry Fix with Error Context (QG-002) ---');

  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set - cannot retry');
    return { success: false };
  }

  // Revert the failed attempt so context files are back to their original state
  execSync('git checkout -- .');
  console.log('Reverted failed fix attempt');

  // Re-gather context (files now back to original state)
  const relevantFiles = await gatherRelevantContext(issue, originalFix);

  const retryPrompt = buildCodeFixPrompt(issue, originalFix, relevantFiles) + `

## IMPORTANT: Previous Fix Attempt Failed Compilation

\`\`\`
${buildError}
\`\`\`

Please revise the fix to address both the original bug AND this compilation error.
Do not repeat the same mistake. Double-check your code compiles before responding.`;

  try {
    console.log(`[DEBUG] Calling OpenRouter API for retry...`);
    console.log(`[DEBUG] Model: ${CODE_MODEL}`);
    console.log(`[DEBUG] Retry prompt length: ${retryPrompt.length} chars`);

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sortinghistory.com',
        'X-Title': 'Sorting History Bug Fix (Retry)',
      },
      body: JSON.stringify({
        model: CODE_MODEL,
        messages: [{ role: 'user', content: retryPrompt }],
        max_tokens: 4000,
      }),
    });

    console.log(`[DEBUG] Retry response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[DEBUG] Retry OpenRouter error: ${errorBody}`);
      return { success: false };
    }

    const result = await response.json();
    const fixText = result.choices?.[0]?.message?.content;

    if (!fixText) {
      console.error('No response from Claude on retry');
      return { success: false };
    }

    console.log(`[DEBUG] Retry fix text length: ${fixText.length} chars`);

    const fixData = parseCodeFixResponse(fixText);
    if (!fixData?.modifications?.length) {
      console.error('Could not parse retry fix from Claude response');
      return { success: false };
    }

    // Apply each modification from the retry
    let appliedCount = 0;
    for (const mod of fixData.modifications) {
      if (await applyModification(mod)) appliedCount++;
    }

    if (appliedCount === 0) {
      console.error('Retry: No modifications could be applied');
      return { success: false };
    }

    console.log(`Retry: Applied ${appliedCount} modification(s), validating build...`);

    // Validate retry fix compiles
    const retryBuild = validateBuild();
    if (!retryBuild.success) {
      console.log('Retry build validation also FAILED - reverting everything');
      execSync('git checkout -- .');
      return { success: false, retryError: retryBuild.error };
    }

    console.log('Retry build validation: PASSED');
    await updateVersionString();
    setOutput('retry_used', 'true');
    setOutput('summary', (fixData.summary || 'Code fix applied') + ' (retry succeeded)');
    return { success: true };
  } catch (e) {
    console.error('Retry failed:', e.message);
    execSync('git checkout -- .');
    return { success: false };
  }
}

/**
 * Main function
 */
async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Bug Fix Application Script`);
  console.log(`Issue: #${ISSUE_NUMBER}`);
  console.log(`Type: ${FIX_TYPE}`);
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
    const suggestedFix = extractSuggestedFix(comments);

    if (suggestedFix) {
      console.log('Found suggested fix:', JSON.stringify(suggestedFix, null, 2));
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
      console.log(`Fix type: ${FIX_TYPE} - routing to Claude Opus 4.5`);
      success = await applyCodeFix(suggestedFix, issue);
    }
    console.log(`[DEBUG] Fix path completed. Success: ${success}`);

    // QG-001: Pre-commit build validation for non-content fixes
    if (success && FIX_TYPE !== 'content') {
      const buildResult = validateBuild();
      if (!buildResult.success) {
        // QG-002: Retry with error context (max 1 retry)
        console.log('Build validation failed - attempting retry with error context...');
        const retryResult = await retryFixWithError(issue, suggestedFix, buildResult.error);

        if (!retryResult.success) {
          // Both original and retry failed - give up
          console.log('Retry also failed -- reverting all file changes');
          execSync('git checkout -- .');
          setOutput('applied', 'false');
          setOutput('build_failed', 'true');
          setOutput('build_error', buildResult.error.substring(0, 500));
          if (retryResult.retryError) {
            setOutput('retry_error', retryResult.retryError.substring(0, 500));
          }
          setOutput('summary', 'Fix failed compilation validation (retry also failed)');
          success = false;
        }
        // If retryResult.success === true, outputs were already set by retryFixWithError()
      }
    } else if (success && FIX_TYPE === 'content') {
      console.log('Content fix -- skipping build validation (QG-001)');
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
