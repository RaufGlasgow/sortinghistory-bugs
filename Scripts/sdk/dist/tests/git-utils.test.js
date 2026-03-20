/**
 * PV2-6.2: Git Utils Tests
 *
 * Tests safeGitAdd() exclusion patterns using a real temporary git repo.
 * Matches the temp-dir test pattern from session.test.ts and state.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { safeGitAdd } from "../lib/git-utils.js";
let tempDir;
beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-utils-test-"));
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: "pipe" });
    // Create initial commit so git status works properly
    fs.writeFileSync(path.join(tempDir, ".gitkeep"), "", "utf-8");
    execSync("git add .gitkeep", { cwd: tempDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: tempDir, stdio: "pipe" });
});
afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});
describe("git-utils: safeGitAdd", () => {
    it("allowed files (.swift, .json) are staged", () => {
        fs.writeFileSync(path.join(tempDir, "Test.swift"), "// swift", "utf-8");
        fs.writeFileSync(path.join(tempDir, "data.json"), "{}", "utf-8");
        const result = safeGitAdd(tempDir);
        assert.ok(result.staged.includes("Test.swift"), "Test.swift should be staged");
        assert.ok(result.staged.includes("data.json"), "data.json should be staged");
        assert.equal(result.excluded.length, 0);
    });
    it("excluded files (DerivedData/, .DS_Store) are blocked", () => {
        // Create DerivedData file
        const derivedDir = path.join(tempDir, "DerivedData");
        fs.mkdirSync(derivedDir, { recursive: true });
        fs.writeFileSync(path.join(derivedDir, "foo.o"), "binary", "utf-8");
        // Create .DS_Store
        fs.writeFileSync(path.join(tempDir, ".DS_Store"), "", "utf-8");
        const result = safeGitAdd(tempDir);
        assert.equal(result.staged.length, 0);
        assert.ok(result.excluded.length >= 2, "Should have at least 2 excluded files");
        const excludedFiles = result.excluded.map((e) => e.file);
        const hasDerived = excludedFiles.some((f) => f.includes("DerivedData"));
        const hasDSStore = excludedFiles.some((f) => f.includes(".DS_Store"));
        assert.ok(hasDerived, "DerivedData file should be excluded");
        assert.ok(hasDSStore, ".DS_Store should be excluded");
    });
    it("mixed allowed + excluded → only allowed staged", () => {
        // Allowed
        fs.writeFileSync(path.join(tempDir, "View.swift"), "// view", "utf-8");
        // Excluded (disallowed extension)
        fs.writeFileSync(path.join(tempDir, "build.yml"), "steps:", "utf-8");
        const result = safeGitAdd(tempDir);
        assert.ok(result.staged.includes("View.swift"), "View.swift should be staged");
        assert.equal(result.staged.length, 1, "Only 1 file should be staged");
        const excludedFiles = result.excluded.map((e) => e.file);
        assert.ok(excludedFiles.includes("build.yml"), "build.yml should be excluded");
    });
    it("no changed files → no error, nothing staged", () => {
        // Repo has no changes (only the initial commit)
        const result = safeGitAdd(tempDir);
        assert.equal(result.staged.length, 0);
        assert.equal(result.excluded.length, 0);
    });
});
