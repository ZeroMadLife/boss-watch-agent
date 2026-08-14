import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { decideAction } from "../policy/action-policy.js";
import { analyzeConversationTool } from "../tools/analyze-conversation-tool.js";

const systemPrompt = [
  "You are Boss Watch Agent in observation-only mode.",
  "Use analyze_conversation for captured recruiter messages.",
  "Never invent evidence and never send messages, resumes, or follow-ups.",
  "Every external side effect requires a separate human approval flow.",
].join(" ");

export interface BossWatchAgentOptions {
  model: Model<Api>;
  streamFn: StreamFn;
}

export function createBossWatchAgent({ model, streamFn }: BossWatchAgentOptions): Agent {
  return new Agent({
    streamFn,
    toolExecution: "sequential",
    initialState: {
      model,
      systemPrompt,
      tools: [analyzeConversationTool],
    },
    beforeToolCall: async ({ toolCall }) => {
      const decision = decideAction(toolCall.name);
      if (decision.decision === "allow") return undefined;
      return {
        block: true,
        terminate: true,
        reason:
          decision.decision === "require_approval"
            ? "This action requires a human approval token."
            : "Unknown action denied by policy.",
      };
    },
  });
}
