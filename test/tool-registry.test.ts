import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  type BossToolDefinition,
  BossToolRegistry,
  createDefaultToolRegistry,
} from "../src/runtime/tool-registry.js";
import { analyzeConversationTool } from "../src/tools/analyze-conversation-tool.js";

describe("BossToolRegistry", () => {
  it("exposes only explicitly registered tools with atomic capability metadata", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.list()).toEqual([
      {
        name: "analyze_conversation",
        action: "analyze_conversation",
        effect: "read_only",
        operation: "analyze_one_conversation",
      },
    ]);
    expect(registry.toPiTools()).toEqual([analyzeConversationTool]);
  });

  it("denies unknown tools and maps registered side effects to approval", () => {
    const sendTool = {
      ...analyzeConversationTool,
      name: "send_message",
      description: "Test-only external side effect",
    } as unknown as AgentTool;
    const sendDefinition: BossToolDefinition = {
      tool: sendTool,
      action: "send_message",
      effect: "external_side_effect",
      operation: "send_one_message",
    };
    const registry = new BossToolRegistry([
      {
        tool: analyzeConversationTool,
        action: "analyze_conversation",
        effect: "read_only",
        operation: "analyze_one_conversation",
      },
      sendDefinition,
    ]);

    expect(registry.decide("send_message")).toEqual({
      decision: "require_approval",
      reason: "external_side_effect",
    });
    expect(registry.decide("open_arbitrary_url")).toEqual({
      decision: "deny",
      reason: "unknown_action",
    });
  });

  it("rejects duplicate tool names before the agent is constructed", () => {
    expect(
      () =>
        new BossToolRegistry([
          {
            tool: analyzeConversationTool,
            action: "analyze_conversation",
            effect: "read_only",
            operation: "analyze_one_conversation",
          },
          {
            tool: analyzeConversationTool,
            action: "analyze_conversation",
            effect: "read_only",
            operation: "analyze_one_conversation",
          },
        ]),
    ).toThrow("duplicate_tool_name:analyze_conversation");
  });

  it("rejects an approval action disguised as a read-only tool", () => {
    const sendTool = {
      ...analyzeConversationTool,
      name: "send_message",
    } as unknown as AgentTool;

    expect(
      () =>
        new BossToolRegistry([
          {
            tool: sendTool,
            action: "send_message",
            effect: "read_only",
            operation: "send_one_message",
          },
        ]),
    ).toThrow("approval_tool_must_be_external:send_message");
  });
});
