/**
 * PV2-6.2: Model Router Tests
 *
 * Tests model selection for all 4 profiles x 3 attempts = 12 combinations.
 * Also tests determineBugProfile() classification logic.
 *
 * Max model is Sonnet. QA always uses Haiku.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { selectModels, determineBugProfile } from "../lib/model-router.js";
import { MODELS } from "../config.js";

// Alias for readability
const HAIKU = MODELS.VERIFIER;
const SONNET = MODELS.FIXER;

describe("model-router: selectModels escalation paths", () => {
  // content_simple: Haiku -> Haiku -> Sonnet
  it("content_simple attempt 1 → Haiku fix, Haiku QA", () => {
    const result = selectModels("content_simple", 1, [".json"]);
    assert.equal(result.fixModel, HAIKU);
    assert.equal(result.qaModel, HAIKU);
  });

  it("content_simple attempt 2 → Haiku fix, Haiku QA", () => {
    const result = selectModels("content_simple", 2, [".json"]);
    assert.equal(result.fixModel, HAIKU);
    assert.equal(result.qaModel, HAIKU);
  });

  it("content_simple attempt 3 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("content_simple", 3, [".json"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  // content_complex: Haiku -> Sonnet -> Sonnet
  it("content_complex attempt 1 → Haiku fix, Haiku QA", () => {
    const result = selectModels("content_complex", 1, [".json"]);
    assert.equal(result.fixModel, HAIKU);
    assert.equal(result.qaModel, HAIKU);
  });

  it("content_complex attempt 2 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("content_complex", 2, [".json"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  it("content_complex attempt 3 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("content_complex", 3, [".json"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  // code_simple: Sonnet -> Sonnet -> Sonnet
  it("code_simple attempt 1 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("code_simple", 1, [".swift"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  it("code_simple attempt 2 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("code_simple", 2, [".swift"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  it("code_simple attempt 3 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("code_simple", 3, [".swift"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  // code_complex: Sonnet -> Sonnet -> Sonnet
  it("code_complex attempt 1 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("code_complex", 1, [".swift"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  it("code_complex attempt 2 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("code_complex", 2, [".swift"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });

  it("code_complex attempt 3 → Sonnet fix, Haiku QA", () => {
    const result = selectModels("code_complex", 3, [".swift"]);
    assert.equal(result.fixModel, SONNET);
    assert.equal(result.qaModel, HAIKU);
  });
});

describe("model-router: determineBugProfile classification", () => {
  it("content_error + high confidence → content_simple", () => {
    const result = determineBugProfile({
      classification: "content_error",
      confidence: 0.9,
      fileExtensions: [".json"],
    });
    assert.equal(result, "content_simple");
  });

  it("content_error + low confidence → content_complex", () => {
    const result = determineBugProfile({
      classification: "content_error",
      confidence: 0.6,
      fileExtensions: [".json"],
    });
    assert.equal(result, "content_complex");
  });

  it("translation_error + high confidence → content_simple", () => {
    const result = determineBugProfile({
      classification: "translation_error",
      confidence: 0.85,
      fileExtensions: [".json"],
    });
    assert.equal(result, "content_simple");
  });

  it("ui_bug + single file extension → code_simple", () => {
    const result = determineBugProfile({
      classification: "ui_bug",
      confidence: 0.9,
      fileExtensions: [".swift"],
    });
    assert.equal(result, "code_simple");
  });

  it("gameplay_bug + multiple file extensions → code_complex", () => {
    const result = determineBugProfile({
      classification: "gameplay_bug",
      confidence: 0.8,
      fileExtensions: [".swift", ".json", ".plist"],
    });
    assert.equal(result, "code_complex");
  });

  it("content_error at exactly 0.8 threshold → content_simple", () => {
    const result = determineBugProfile({
      classification: "content_error",
      confidence: 0.8,
      fileExtensions: [".json"],
    });
    assert.equal(result, "content_simple");
  });
});

describe("model-router: selectModels turn limits", () => {
  it("QA model is always <= fix model tier", () => {
    // For every profile and attempt, QA model tier should be <= fix model tier
    const profiles = ["content_simple", "content_complex", "code_simple", "code_complex"] as const;
    const modelTier: Record<string, number> = {
      [HAIKU]: 1,
      [SONNET]: 2,
    };

    for (const profile of profiles) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = selectModels(profile, attempt, [".swift"]);
        assert.ok(
          modelTier[result.qaModel] <= modelTier[result.fixModel],
          `${profile} attempt ${attempt}: QA model (${result.qaModel}) should be <= fix model (${result.fixModel})`,
        );
      }
    }
  });

  it("attempt number clamped to max 3", () => {
    // Attempt 99 should behave like attempt 3
    const result99 = selectModels("content_simple", 99, [".json"]);
    const result3 = selectModels("content_simple", 3, [".json"]);
    assert.equal(result99.fixModel, result3.fixModel);
    assert.equal(result99.qaModel, result3.qaModel);
  });
});
