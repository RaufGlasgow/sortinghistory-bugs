# SDK-BF.8: Multimodal Screenshot Support for Bug Fix Pipeline

**Epic:** SDK Bug Fix Pipeline
**Priority:** P1 — Pipeline is broken without this (triage hits maxTurns, Opus can't see screenshots)
**Estimated Cost Impact:** Triage stays ~$0.01, bug fix adds ~$0.01-0.05 per image

## Problem

1. **Triage fails on real bugs:** `maxTurns: 10` is too low — the Haiku subagent exhausts turns before producing classification JSON. Issue #86 failed with `error_max_turns`.
2. **Base64 screenshots sent as text:** The issue body contains `![Screenshot](data:image/png;base64,...)` which gets passed as raw text. The model receives thousands of base64 characters it can't interpret as an image.
3. **Opus bug-fix subagent can't see screenshots:** For UI bugs, visual verification is critical. The whole pipeline was designed around auto-captured screenshots.

## Solution

### Triage (Haiku) — Strip images, increase turns
- Strip base64 image data from report text before sending to Haiku
- Haiku only needs text for classification (ui_bug vs content_error vs gameplay_bug)
- Increase `maxTurns` from 10 → 20 to prevent turn exhaustion on file-heavy investigations

### Bug Fix (Opus) — Send images as proper content blocks
- Extract base64 images from issue body
- Send as `{type: "image", source: {type: "base64", media_type: "image/png", data: "..."}}` content blocks
- Update `spawnSubagent()` to accept multimodal prompt (content blocks, not just string)

## Acceptance Criteria

- [ ] AC1: Triage subagent strips base64 image data from report text before classification
- [ ] AC2: Triage `maxTurns` increased to 20
- [ ] AC3: `spawnSubagent()` accepts optional image content blocks alongside text prompt
- [ ] AC4: Bug-fix subagent extracts base64 images from issue body and passes as image content blocks to Opus
- [ ] AC5: If no screenshot present, both pipelines work as before (no regression)
- [ ] AC6: TypeScript compiles clean (`npm run build`)
- [ ] AC7: Re-run triage on issue #86 succeeds

## Files to Modify

| File | Change |
|------|--------|
| `Scripts/sdk/lib/subagent.ts` | Accept multimodal prompt (content blocks) |
| `Scripts/sdk/workflows/bug-triage.ts` | Strip base64 images, increase maxTurns to 20 |
| `Scripts/sdk/workflows/triage.ts` | Strip images from report text before passing to bug-triage |
| `Scripts/sdk/workflows/bug-fix.ts` | Extract images, pass as content blocks to Opus |

## Technical Notes

- SDK `query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`
- `SDKUserMessage.message` is `MessageParam` which supports `{type: "image", source: {...}}` content blocks
- Base64 pattern in issue body: `![Screenshot](data:image/<type>;base64,<data>)`
- Supported media types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
