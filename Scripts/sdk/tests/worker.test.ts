import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  isSDKPipelineIssue,
  sanitizeText,
  validateBugReport,
  formatIssueBody,
  extractRejectionReason,
} from "../lib/worker-utils.js";

// ---------- isSDKPipelineIssue ----------

describe("isSDKPipelineIssue", () => {
  it("true for content-error label", () => {
    assert.equal(isSDKPipelineIssue([{ name: "content-error" }]), true);
  });

  it("true for translation-error label", () => {
    assert.equal(isSDKPipelineIssue([{ name: "translation-error" }]), true);
  });

  it("true when mixed with other labels", () => {
    assert.equal(
      isSDKPipelineIssue([
        { name: "from-app" },
        { name: "content-error" },
        { name: "needs-triage" },
      ]),
      true,
    );
  });

  it("false for code-fix-eligible", () => {
    assert.equal(
      isSDKPipelineIssue([{ name: "code-fix-eligible" }, { name: "from-app" }]),
      false,
    );
  });

  it("false for empty labels", () => {
    assert.equal(isSDKPipelineIssue([]), false);
  });

  it("false for unrelated labels", () => {
    assert.equal(
      isSDKPipelineIssue([{ name: "bug" }, { name: "high-severity" }]),
      false,
    );
  });
});

// ---------- sanitizeText ----------

describe("sanitizeText", () => {
  it("strips HTML tags", () => {
    assert.equal(sanitizeText("Hello <b>world</b>"), "Hello world");
  });

  it("strips HTML entities", () => {
    assert.equal(sanitizeText("Hello &amp; world"), "Hello   world");
  });

  it("trims whitespace", () => {
    assert.equal(sanitizeText("  hello  "), "hello");
  });

  it("handles script tags", () => {
    assert.equal(
      sanitizeText("<script>alert('xss')</script>Bug"),
      "alert('xss')Bug",
    );
  });

  it("passes through clean text", () => {
    assert.equal(sanitizeText("Simple bug report"), "Simple bug report");
  });
});

// ---------- validateBugReport ----------

describe("validateBugReport", () => {
  it("valid minimal report", () => {
    const result = validateBugReport({ description: "A valid bug report" });
    assert.equal(result.valid, true);
  });

  it("valid full report", () => {
    const result = validateBugReport({
      description: "Bug with details here",
      category: "UI",
      email: "a@b.com",
      deviceInfo: { model: "iPhone" },
    });
    assert.equal(result.valid, true);
  });

  it("rejects null body", () => {
    const result = validateBugReport(null);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "body"));
    }
  });

  it("rejects missing description", () => {
    const result = validateBugReport({ category: "UI" });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "description"));
    }
  });

  it("rejects description under 10 chars", () => {
    const result = validateBugReport({ description: "short" });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "description"));
    }
  });

  it("rejects description over 5000 chars", () => {
    const result = validateBugReport({ description: "x".repeat(5001) });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "description"));
    }
  });

  it("rejects non-string category", () => {
    const result = validateBugReport({
      description: "valid bug report text",
      category: 123,
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "category"));
    }
  });

  it("rejects oversized screenshot", () => {
    const result = validateBugReport({
      description: "valid bug report text",
      screenshot: "x".repeat(5 * 1024 * 1024 + 1),
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "screenshot"));
    }
  });

  it("rejects invalid email", () => {
    const result = validateBugReport({
      description: "valid bug report text",
      email: "notanemail",
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "email"));
    }
  });

  it("accepts empty string email", () => {
    const result = validateBugReport({
      description: "valid bug report text",
      email: "",
    });
    assert.equal(result.valid, true);
  });

  it("sanitizes description HTML in valid report", () => {
    const result = validateBugReport({
      description: "<b>Bold</b> bug report text",
    });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.report.description, "Bold bug report text");
    }
  });
});

// ---------- extractRejectionReason ----------

describe("extractRejectionReason", () => {
  it("extracts reason: format", () => {
    assert.equal(
      extractRejectionReason("/reject reason: Wrong fix applied"),
      "Wrong fix applied",
    );
  });

  it("extracts plain format", () => {
    assert.equal(
      extractRejectionReason("/reject The fix is wrong"),
      "The fix is wrong",
    );
  });

  it("returns default for bare /reject", () => {
    assert.equal(extractRejectionReason("/reject"), "No reason provided");
  });

  it("case insensitive", () => {
    assert.equal(extractRejectionReason("/REJECT reason: Bad"), "Bad");
  });
});

// ---------- formatIssueBody ----------

describe("formatIssueBody", () => {
  it("includes confirmation ID and description", () => {
    const body = formatIssueBody({ description: "Bug text" }, "BUG-ABC123");
    assert.ok(body.includes("BUG-ABC123"), "body should contain confirmation ID");
    assert.ok(body.includes("Bug text"), "body should contain description");
  });

  it("includes device info table when provided", () => {
    const body = formatIssueBody(
      {
        description: "Bug text",
        deviceInfo: { model: "iPhone 15", osVersion: "18.2" },
      },
      "BUG-XYZ",
    );
    assert.ok(body.includes("iPhone 15"), "body should contain device model");
    assert.ok(body.includes("18.2"), "body should contain OS version");
  });
});
