/**
 * Bug Analysis Script
 *
 * Uses OpenRouter to analyze bug reports and suggest labels.
 * - GLM 4 Plus for content/UX bug triage (cheap, fast)
 * - Claude Sonnet 4 for code bugs (smart, more detailed)
 *
 * BUG-003: AI Bug Analysis via OpenRouter
 * Story 3.2: Loads codebase context based on bug type for grounded analysis
 * Story 3.3: Loads actual codebase context for accurate analysis
 */

const fs = require('fs');
const path = require('path');

// OpenRouter configuration
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Model IDs - using reliable models via OpenRouter
const TRIAGE_MODEL = 'z-ai/glm-4.7'; // Fast, cheap for triage
const CODE_MODEL = 'anthropic/claude-opus-4-5'; // Smart for code analysis
const CONTENT_MODEL = 'z-ai/glm-4.7'; // Fast for content fixes

// Notification: repo owner to @mention in analysis comments
const REPO_OWNER = process.env.BUG_NOTIFY_USER || 'raufglasgow';

// Get issue details from environment
const issueNumber = process.env.ISSUE_NUMBER;
const issueTitle = process.env.ISSUE_TITLE || '';
const issueBody = process.env.ISSUE_BODY || '';

// Key Swift files for code bug context
const CODE_CONTEXT_FILES = [
  'ViewModels/GameManager.swift',
  'ViewModels/GameManagerMultiplayer.swift',
  'Models/GameModels.swift',
  'Core/Navigation/GameCoordinator.swift',
  'Core/Services/DefaultContentService.swift',
];

// Event JSON directory
const EVENTS_DIR = 'Data/Events';

// Directories to search for Swift files by keyword
const SWIFT_SEARCH_DIRS = [
  'ViewModels',
  'Views',
  'Core',
  'Models',
];

// Token limit for context (approx 4 chars per token)
const CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_TOKENS = 50000;

/**
 * Estimate token count from a string (approx 4 chars per token)
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

/**
 * Truncate a context string to fit within the token limit.
 * Returns { text, wasTruncated }
 */
function truncateToTokenLimit(text, maxTokens = MAX_CONTEXT_TOKENS) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return { text, wasTruncated: false };
  }
  const truncated = text.slice(0, maxChars);
  return {
    text: truncated + '\n\n[CONTEXT TRUNCATED: exceeded ' + maxTokens + ' token limit. Most relevant files shown above.]',
    wasTruncated: true,
  };
}

/**
 * Recursively find all .swift files in a directory
 */
function findSwiftFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findSwiftFiles(fullPath));
      } else if (entry.name.endsWith('.swift') && !entry.name.includes(' 2')) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    // Graceful: skip unreadable directories
  }
  return results;
}

/**
 * Search Swift source directories for files matching bug description keywords.
 * Returns array of relative file paths ranked by relevance.
 */
function searchSwiftFilesByKeyword(bugText) {
  const bugLower = bugText.toLowerCase();
  // Extract meaningful keywords (3+ chars, no stop words)
  const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'bug', 'issue', 'not', 'when', 'does', 'should', 'from', 'have', 'has']);
  const keywords = bugLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  const cwd = process.cwd();
  const scored = [];

  for (const dir of SWIFT_SEARCH_DIRS) {
    const dirPath = path.join(cwd, dir);
    const files = findSwiftFiles(dirPath);
    for (const absPath of files) {
      const relPath = path.relative(cwd, absPath);
      const fileNameLower = path.basename(absPath, '.swift').toLowerCase();
      const pathLower = relPath.toLowerCase();

      let score = 0;
      for (const kw of keywords) {
        if (fileNameLower.includes(kw)) score += 3; // Strong: keyword in filename
        else if (pathLower.includes(kw)) score += 1; // Weak: keyword in path
      }

      if (score > 0) {
        scored.push({ relPath, score });
      }
    }
  }

  // Sort by relevance score descending
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.relPath);
}

/**
 * Load JSON event files for content bug context
 * Returns array of {filename, events} objects
 */
function loadEventContext(bugText) {
  const context = [];
  const eventsPath = path.join(process.cwd(), EVENTS_DIR);

  if (!fs.existsSync(eventsPath)) {
    console.log('Events directory not found, skipping content context');
    return context;
  }

  const files = fs.readdirSync(eventsPath).filter(f => f.endsWith('.json'));

  // Keywords from bug report to find relevant files
  const bugLower = bugText.toLowerCase();

  for (const file of files) {
    try {
      const filePath = path.join(eventsPath, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const events = content.events || content;

      // Check if this file's events match the bug description
      const categoryMatch = bugLower.includes(file.replace('.json', '').toLowerCase().replace(/([A-Z])/g, ' $1').trim());
      const eventMatch = events.some(e =>
        bugLower.includes(e.title?.toLowerCase()) ||
        bugLower.includes(e.description?.toLowerCase()?.slice(0, 50))
      );

      if (categoryMatch || eventMatch) {
        // Include this file's events (truncated for token limit)
        context.push({
          filename: `${EVENTS_DIR}/${file}`,
          eventCount: events.length,
          events: events.slice(0, 20).map(e => ({
            title: e.title,
            year: e.year,
            description: e.description?.slice(0, 100),
            category: e.category
          }))
        });
      }
    } catch (err) {
      console.log(`Error reading ${file}: ${err.message}`);
    }
  }

  // If no specific match, include a sample from each category
  if (context.length === 0) {
    for (const file of files.slice(0, 3)) {
      try {
        const filePath = path.join(eventsPath, file);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const events = content.events || content;
        context.push({
          filename: `${EVENTS_DIR}/${file}`,
          eventCount: events.length,
          events: events.slice(0, 5).map(e => ({
            title: e.title,
            year: e.year,
            category: e.category
          }))
        });
      } catch (err) {}
    }
  }

  return context;
}

/**
 * Load Swift files for code bug context
 * Combines hardcoded key files with dynamic keyword-based file discovery.
 * Returns array of {filename, content, lineCount} objects
 */
function loadCodeContext(bugText) {
  const context = [];
  const bugLower = bugText.toLowerCase();
  const loaded = new Set();

  // Phase 1: Check hardcoded key files for relevance
  const filesToLoad = CODE_CONTEXT_FILES.filter(file => {
    const fileName = path.basename(file, '.swift').toLowerCase();
    return bugLower.includes(fileName) ||
           bugLower.includes(fileName.replace('manager', '')) ||
           bugLower.includes('game') || // Always include GameManager for game bugs
           bugLower.includes('multiplayer') && file.includes('Multiplayer');
  });

  // Always include GameManager and GameModels as core context
  const mustInclude = ['ViewModels/GameManager.swift', 'Models/GameModels.swift'];
  for (const file of mustInclude) {
    if (!filesToLoad.includes(file)) {
      filesToLoad.push(file);
    }
  }

  // Phase 2: Dynamic keyword search across ViewModels/, Views/, Core/, Models/
  const dynamicFiles = searchSwiftFilesByKeyword(bugText);
  for (const file of dynamicFiles) {
    if (!filesToLoad.includes(file)) {
      filesToLoad.push(file);
    }
  }

  // Cap at 15 files to avoid excessive context
  const cappedFiles = filesToLoad.slice(0, 15);

  for (const file of cappedFiles) {
    if (loaded.has(file)) continue;
    loaded.add(file);
    try {
      const filePath = path.join(process.cwd(), file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        // Truncate to ~500 lines per file to stay within token limits
        const lines = content.split('\n').slice(0, 500);
        context.push({
          filename: file,
          lineCount: content.split('\n').length,
          content: lines.join('\n')
        });
      }
    } catch (err) {
      console.log(`Error reading ${file}: ${err.message}`);
    }
  }

  return context;
}

// Analysis prompt
const ANALYSIS_PROMPT = `You are a bug triage assistant for the Sorting History iOS app - a history timeline game where players place historical events in chronological order.

Analyze the following bug report and provide:

1. **Severity** (choose one):
   - P1: Critical - App crashes, data loss, or completely unusable
   - P2: High - Major feature broken, significant user impact
   - P3: Medium - Minor feature issue, workaround exists
   - P4: Low - Cosmetic issue, enhancement request

2. **Type** (choose one):
   - content: Issues with historical events (wrong dates, missing events, typos)
   - code: Technical bugs, crashes, performance issues
   - ux: User experience issues (confusing UI, accessibility)
   - other: Doesn't fit above categories

3. **Brief Analysis** (2-3 sentences): What seems to be the issue and potential cause?

4. **Suggested Next Steps** (1-2 bullet points): What should a developer investigate?

5. **Suggested Fix** (IMPORTANT for automation):
   - For content bugs: Specify the exact file, event, and correction needed
   - For code bugs: Identify the likely file(s) and describe the fix approach

---

## Bug Report

**Title:** ${issueTitle}

**Description:**
${issueBody}

---

Respond in this exact JSON format:
{
  "severity": "P1" | "P2" | "P3" | "P4",
  "type": "content" | "code" | "ux" | "other",
  "analysis": "Your 2-3 sentence analysis",
  "nextSteps": ["Step 1", "Step 2"],
  "suggestedFix": {
    "file": "Path to file (e.g., Data/Events/USHistory.json or ViewModels/GameManager.swift)",
    "description": "Exact fix description",
    "searchText": "Text to find (for content: event title; for code: code snippet to change)",
    "replaceText": "Corrected text or code"
  }
}`;

/**
 * Call OpenRouter API
 * @param {string} model - Model ID
 * @param {string} prompt - User prompt
 * @param {number} maxTokens - Max response tokens
 * @param {string|null} systemMessage - Optional system message for codebase context
 */
async function callOpenRouter(model, prompt, maxTokens = 500, systemMessage = null) {
  const messages = [];
  if (systemMessage) {
    messages.push({ role: 'system', content: systemMessage });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://sortinghistory.com',
      'X-Title': 'Sorting History Bug Automation',
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * Parse JSON from model response
 */
function parseJsonResponse(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse JSON from response');
  }
  return JSON.parse(jsonMatch[0]);
}

/**
 * Main analysis function
 */
async function analyzeBug() {
  console.log(`Analyzing issue #${issueNumber}...`);

  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set');
    process.exit(1);
  }

  try {
    // Step 1: Initial triage with GLM 4 Plus
    console.log(`Using ${TRIAGE_MODEL} for initial triage...`);
    const triageResponse = await callOpenRouter(TRIAGE_MODEL, ANALYSIS_PROMPT, 2000);

    // DIAGNOSTIC: Log full response structure
    console.log('=== OPENROUTER RAW RESPONSE ===');
    console.log(JSON.stringify(triageResponse, null, 2));
    console.log('=== END RAW RESPONSE ===');

    const triageText = triageResponse.choices?.[0]?.message?.content;
    if (!triageText) {
      console.error('=== EMPTY RESPONSE DEBUG ===');
      console.error('choices array:', JSON.stringify(triageResponse.choices, null, 2));
      console.error('Full response keys:', Object.keys(triageResponse));
      console.error('=== END DEBUG ===');
      throw new Error('No response from triage model');
    }

    console.log('=== MODEL OUTPUT TEXT ===');
    console.log(triageText);
    console.log('=== END MODEL OUTPUT ===');

    let result;
    try {
      result = parseJsonResponse(triageText);
    } catch (parseErr) {
      console.error('=== JSON PARSE FAILURE ===');
      console.error('Failed to parse:', triageText);
      console.error('Parse error:', parseErr.message);
      console.error('=== END PARSE FAILURE ===');
      throw parseErr;
    }
    let modelUsed = TRIAGE_MODEL;

    const bugText = `${issueTitle} ${issueBody}`;

    // Step 2: Load context and escalate based on bug type
    if (result.type === 'code') {
      console.log(`Code bug detected. Loading codebase context...`);
      const codeContext = loadCodeContext(bugText);
      console.log(`Loaded ${codeContext.length} Swift files for context`);

      let contextSection = codeContext.map(f =>
        `### ${f.filename} (${f.lineCount} lines)\n\`\`\`swift\n${f.content}\n\`\`\``
      ).join('\n\n');

      // Apply token limit to context
      const { text: boundedContext, wasTruncated } = truncateToTokenLimit(contextSection);
      contextSection = boundedContext;
      if (wasTruncated) {
        console.log(`Context truncated to ${MAX_CONTEXT_TOKENS} token limit`);
      }
      console.log(`Context size: ~${estimateTokens(contextSection)} tokens`);

      // Build system message with codebase context
      const codeSystemMessage = `You are analyzing a code bug in the Sorting History iOS app. The following Swift source files from the actual codebase are provided as context:\n\n${contextSection}`;

      console.log(`Escalating to ${CODE_MODEL}...`);
      const codePrompt = `${ANALYSIS_PROMPT}

---

This has been identified as a code/technical bug. Using the ACTUAL CODE provided in context:
- Identify the exact file and code that needs to change
- Provide the EXACT searchText from the code
- Provide the corrected replaceText

CRITICAL: The suggestedFix must reference real code from the codebase context.`;

      const codeResponse = await callOpenRouter(CODE_MODEL, codePrompt, 2000, codeSystemMessage);
      const codeText = codeResponse.choices?.[0]?.message?.content;

      if (codeText) {
        const codeResult = parseJsonResponse(codeText);
        result.analysis = codeResult.analysis;
        result.nextSteps = codeResult.nextSteps;
        result.suggestedFix = codeResult.suggestedFix;
        modelUsed = CODE_MODEL;
      }
    } else if (result.type === 'content') {
      console.log(`Content bug detected. Loading event data...`);
      const eventContext = loadEventContext(bugText);
      console.log(`Loaded ${eventContext.length} event files for context`);

      let contextSection = eventContext.map(f =>
        `### ${f.filename} (${f.eventCount} events)\n\`\`\`json\n${JSON.stringify(f.events, null, 2)}\n\`\`\``
      ).join('\n\n');

      // Apply token limit to context
      const { text: boundedContext, wasTruncated } = truncateToTokenLimit(contextSection);
      contextSection = boundedContext;
      if (wasTruncated) {
        console.log(`Context truncated to ${MAX_CONTEXT_TOKENS} token limit`);
      }
      console.log(`Context size: ~${estimateTokens(contextSection)} tokens`);

      // Build system message with event data context
      const contentSystemMessage = `You are analyzing a content bug in the Sorting History iOS app. The following event data from actual JSON files is provided as context:\n\n${contextSection}`;

      console.log(`Escalating to ${CONTENT_MODEL}...`);
      const contentPrompt = `${ANALYSIS_PROMPT}

---

This has been identified as a content bug. Using the ACTUAL EVENT DATA provided in context:
- Identify the exact file and event that needs correction
- For searchText, provide the exact event title
- For replaceText, specify what field needs to change and to what value

CRITICAL: The suggestedFix must reference real events from the context.
Format the fix so it can be applied to the JSON file automatically.`;

      const contentResponse = await callOpenRouter(CONTENT_MODEL, contentPrompt, 1500, contentSystemMessage);
      const contentText = contentResponse.choices?.[0]?.message?.content;

      if (contentText) {
        const contentResult = parseJsonResponse(contentText);
        result.analysis = contentResult.analysis;
        result.nextSteps = contentResult.nextSteps;
        result.suggestedFix = contentResult.suggestedFix;
        modelUsed = CONTENT_MODEL;
      }
    }

    console.log('Analysis result:', JSON.stringify(result, null, 2));

    // Build labels
    const labels = [`severity/${result.severity}`, `type/${result.type}`];

    // Build suggested fix section (for BUG-006 auto-fix parsing)
    const suggestedFixSection = result.suggestedFix
      ? `### Suggested Fix

**File:** \`${result.suggestedFix.file}\`
**Description:** ${result.suggestedFix.description}

<details>
<summary>Auto-Fix Data (for automation)</summary>

\`\`\`json
${JSON.stringify(result.suggestedFix, null, 2)}
\`\`\`

</details>`
      : '';

    // Build analysis comment
    const analysisComment = `## AI Bug Analysis

**Severity:** ${result.severity}
**Type:** ${result.type}

### Analysis
${result.analysis}

### Suggested Next Steps
${result.nextSteps.map((step) => `- ${step}`).join('\n')}

${suggestedFixSection}

---
cc @${REPO_OWNER}

*Analyzed by ${modelUsed} via OpenRouter*`;

    // Set outputs for GitHub Actions
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      fs.appendFileSync(outputFile, `labels=${labels.join(',')}\n`);
      fs.appendFileSync(outputFile, `analysis<<EOF\n${analysisComment}\nEOF\n`);
    }

    console.log('Labels:', labels.join(', '));
    console.log('Analysis complete!');
  } catch (error) {
    console.error('Analysis failed:', error.message);

    // Don't fail the workflow - label for manual triage
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      fs.appendFileSync(outputFile, `labels=analysis-failed\n`);
      fs.appendFileSync(
        outputFile,
        `analysis<<EOF\n## Analysis Failed\n\nAutomatic analysis could not be completed. Manual triage required.\n\nError: ${error.message}\nEOF\n`
      );
    }
  }
}

analyzeBug();
