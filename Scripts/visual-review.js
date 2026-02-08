/**
 * Visual Review Script
 *
 * Takes light and dark mode screenshots of the running app and sends them
 * to Claude for visual assessment of the bug fix.
 *
 * Usage: node visual-review.js <light-screenshot> [dark-screenshot]
 *
 * The dark screenshot is optional. If missing or the file does not exist,
 * the review proceeds with only the light mode screenshot.
 *
 * Environment:
 *   OPENROUTER_API_KEY  - OpenRouter API key
 *   PRIVATE_REPO_TOKEN  - GitHub PAT for fetching issue details
 *   ISSUE_NUMBER        - Issue number to fetch bug description
 *   PRIVATE_REPO_NAME   - Repo in owner/name format
 *   FIX_SUMMARY         - One-line summary of the fix applied
 *   FIX_TYPE            - Bug type (code, ux, content)
 */

const fs = require('fs');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REVIEW_MODEL = 'anthropic/claude-opus-4.6';

async function main() {
  const lightScreenshotPath = process.argv[2];
  const darkScreenshotPath = process.argv[3]; // optional
  const apiKey = process.env.OPENROUTER_API_KEY;
  const ghToken = process.env.PRIVATE_REPO_TOKEN;
  const issueNumber = process.env.ISSUE_NUMBER;
  const repoName = process.env.PRIVATE_REPO_NAME || 'RaufGlasgow/Sorting-History';
  const fixSummary = process.env.FIX_SUMMARY || '';
  const fixType = process.env.FIX_TYPE || '';

  // Check if at least the light screenshot exists
  const hasLight = lightScreenshotPath && fs.existsSync(lightScreenshotPath);
  const hasDark = darkScreenshotPath && fs.existsSync(darkScreenshotPath);

  if (!hasLight) {
    console.log('No screenshot available for visual review');
    setOutput('review_result', 'skipped');
    return;
  }

  if (!apiKey) {
    console.log('No API key — skipping visual review');
    setOutput('review_result', 'skipped');
    return;
  }

  // Fetch issue details for context
  let bugTitle = '';
  let bugDescription = '';
  if (ghToken && issueNumber) {
    try {
      const [owner, repo] = repoName.split('/');
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          headers: {
            Authorization: `token ${ghToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'SortingHistory-VisualReview',
          },
        }
      );
      if (resp.ok) {
        const issue = await resp.json();
        bugTitle = issue.title || '';
        // Strip base64 images from body to save tokens
        bugDescription = (issue.body || '')
          .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[screenshot omitted]')
          .substring(0, 2000);
      }
    } catch (e) {
      console.log(`Could not fetch issue: ${e.message}`);
    }
  }

  // Build image content blocks
  const contentParts = [];

  // Light mode screenshot
  const lightBuffer = fs.readFileSync(lightScreenshotPath);
  console.log(`Light mode screenshot: ${lightBuffer.length} bytes`);
  contentParts.push({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${lightBuffer.toString('base64')}` }
  });

  // Dark mode screenshot (optional — graceful if missing)
  if (hasDark) {
    const darkBuffer = fs.readFileSync(darkScreenshotPath);
    console.log(`Dark mode screenshot: ${darkBuffer.length} bytes`);
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${darkBuffer.toString('base64')}` }
    });
  } else {
    console.log('Dark mode screenshot not available — reviewing light mode only');
  }

  // Build the prompt based on how many screenshots we have
  const modeInstruction = hasDark
    ? `You are reviewing TWO screenshots — the FIRST image is LIGHT mode, the SECOND image is DARK mode.
Assess both independently. Flag any issues specific to dark mode (invisible text, missing contrast, broken colors, elements that disappear against dark backgrounds).`
    : `You are reviewing a single LIGHT mode screenshot. Dark mode was not captured for this run.`;

  const prompt = `You are a QA engineer reviewing screenshot(s) of the Sorting History iOS app after an automated bug fix was applied.

## Bug Report
**Title:** ${bugTitle}
**Type:** ${fixType}
**Description:** ${bugDescription}

## Fix Applied
${fixSummary}

## Screenshot Mode
${modeInstruction}

## Your Task
Examine the screenshot(s) carefully and assess:
1. Does the app appear to have launched correctly? (no crash screen, no blank screen)
2. Are there any obvious visual issues? (overlapping text, broken layout, missing elements, cut-off content)
3. Based on the bug description and fix summary, can you see evidence the fix was applied from this screenshot alone?
${hasDark ? '4. Are there any dark-mode-specific issues? (invisible text, poor contrast, broken colors, elements disappearing against dark background)' : ''}

Important: You may only be seeing the app's initial/main screen, not the specific screen where the bug occurs. Be honest about what you can and cannot determine.

Respond in JSON only:
{
  "app_launches": true,
  "obvious_visual_issues": false,
  "visual_issue_details": "",
  "dark_mode_issues": ${hasDark ? 'false' : 'null'},
  "dark_mode_details": "${hasDark ? '' : 'dark mode not captured'}",
  "fix_verifiable_from_screenshot": false,
  "verification_note": "explanation of what you can/cannot verify from this screenshot",
  "recommendation": "approve" | "needs_manual_testing" | "visual_concerns",
  "summary": "one sentence summary for the PR comment"
}

JSON ONLY — no other text.`;

  // Add the prompt as the final content part
  contentParts.push({ type: 'text', text: prompt });

  try {
    console.log(`Calling OpenRouter for visual review (model: ${REVIEW_MODEL})...`);
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sortinghistory.com',
        'X-Title': 'Sorting History Visual Review',
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        messages: [{
          role: 'user',
          content: contentParts
        }],
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`Visual review API error: ${response.status} — ${errBody}`);
      setOutput('review_result', 'api_error');
      return;
    }

    const result = await response.json();
    const text = result.choices?.[0]?.message?.content || '';
    console.log('Visual review response:', text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const review = JSON.parse(jsonMatch[0]);
      setOutput('review_result', review.recommendation || 'unknown');

      // Build summary including dark mode status
      let summary = review.summary || '';
      if (hasDark && review.dark_mode_issues) {
        summary += ` Dark mode issues: ${review.dark_mode_details || 'see details'}`;
      } else if (hasDark && review.dark_mode_issues === false) {
        summary += ' Dark mode: OK.';
      }
      setOutput('review_summary', summary);

      console.log(`Visual review: ${review.recommendation}`);
      console.log(`Summary: ${summary}`);
      if (hasDark) {
        console.log(`Dark mode issues: ${review.dark_mode_issues}`);
      }
    } else {
      console.error('Could not parse visual review response');
      setOutput('review_result', 'parse_error');
    }
  } catch (e) {
    console.error(`Visual review failed: ${e.message}`);
    setOutput('review_result', 'error');
  }
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const strValue = String(value);
    if (strValue.includes('\n')) {
      const delimiter = 'GHEOF_' + Date.now();
      fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${strValue}\n${delimiter}\n`);
    } else {
      fs.appendFileSync(outputFile, `${name}=${strValue}\n`);
    }
  }
}

main().catch(e => {
  console.error('Visual review fatal error:', e.message);
});
