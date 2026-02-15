import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  createToolRestrictionHook,
  createJsonValidationHook,
  createDiacriticsHook,
  buildHooksConfig,
} from "../lib/hooks.js";
import type {
  PreToolUseHookInput,
  PostToolUseHookInput,
  HookCallback,
} from "@anthropic-ai/claude-agent-sdk";

/** Minimal PreToolUse input factory matching SDK BaseHookInput + PreToolUseHookInput */
function makePreToolInput(toolName: string, filePath?: string): PreToolUseHookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/test-transcript",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: filePath !== undefined ? { file_path: filePath } : {},
    tool_use_id: "test-tool-use-001",
  };
}

/** Minimal PostToolUse input factory */
function makePostToolInput(toolName: string, filePath: string): PostToolUseHookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/test-transcript",
    cwd: "/tmp",
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_response: { content: "file written" },
    tool_use_id: "test-tool-use-002",
  };
}

/** Extract the first hook callback from a HookCallbackMatcher for direct testing */
function getCallback(matcher: { hooks: HookCallback[] }): HookCallback {
  return matcher.hooks[0];
}

/** Default options for hook callbacks */
const hookOptions = { signal: new AbortController().signal };

describe("createToolRestrictionHook", () => {
  it("blocks Write to .swift file", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/GameModel.swift");

    const result = await callback(input, "", hookOptions);

    assert.ok("hookSpecificOutput" in result);
    const output = (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
  });

  it("blocks Edit to .swift file", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Edit", "/path/GameView.swift");

    const result = await callback(input, "", hookOptions);

    assert.ok("hookSpecificOutput" in result);
    const output = (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
  });

  it("blocks Write to .pbxproj", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/project.pbxproj");

    const result = await callback(input, "", hookOptions);

    assert.ok("hookSpecificOutput" in result);
    const output = (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
  });

  it("blocks Write to .xib", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/LaunchScreen.xib");

    const result = await callback(input, "", hookOptions);

    assert.ok("hookSpecificOutput" in result);
    const output = (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
  });

  it("blocks Write to .storyboard", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/Main.storyboard");

    const result = await callback(input, "", hookOptions);

    assert.ok("hookSpecificOutput" in result);
    const output = (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
  });

  it("blocks Write to .xcworkspace", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/foo.xcworkspace");

    const result = await callback(input, "", hookOptions);

    assert.ok("hookSpecificOutput" in result);
    const output = (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
  });

  it("allows Write to .json file", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/USHistory.json");

    const result = await callback(input, "", hookOptions);

    assert.equal(Object.keys(result).length, 0, "Expected empty object for allowed file");
  });

  it("allows Write to .md file", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/README.md");

    const result = await callback(input, "", hookOptions);

    assert.equal(Object.keys(result).length, 0, "Expected empty object for allowed file");
  });

  it("allows Write to .ts file", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write", "/path/state.ts");

    const result = await callback(input, "", hookOptions);

    assert.equal(Object.keys(result).length, 0, "Expected empty object for allowed file");
  });

  it("returns empty when no file_path", async () => {
    const hook = createToolRestrictionHook();
    const callback = getCallback(hook);
    const input = makePreToolInput("Write");

    const result = await callback(input, "", hookOptions);

    assert.equal(Object.keys(result).length, 0, "Expected empty object when no file_path");
  });
});

describe("createJsonValidationHook", () => {
  it("logs on JSON write (no error)", async () => {
    const hook = createJsonValidationHook();
    const callback = getCallback(hook);
    const input = makePostToolInput("Write", "/path/state.json");

    const result = await callback(input, "", hookOptions);

    // PostToolUse hook should return empty object (no crash, just logs)
    assert.equal(Object.keys(result).length, 0, "Expected empty object for JSON validation hook");
  });
});

describe("buildHooksConfig", () => {
  it("returns PreToolUse and PostToolUse arrays", () => {
    const config = buildHooksConfig();

    assert.ok(config.PreToolUse, "PreToolUse should be defined");
    assert.ok(config.PostToolUse, "PostToolUse should be defined");
    assert.equal(config.PreToolUse!.length, 1, "PreToolUse should have 1 matcher");
    assert.equal(config.PostToolUse!.length, 2, "PostToolUse should have 2 matchers");
  });
});
