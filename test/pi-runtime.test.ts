import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createBossWatchAgent } from "../src/runtime/create-boss-watch-agent.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
  id: "mock-model",
  name: "Mock model",
  api: "openai-responses",
  provider: "mock",
  baseUrl: "http://127.0.0.1/unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 2_000,
} satisfies Model<"openai-responses">;

type DoneReason = "length" | "stop" | "toolUse" | "deferred";

class ScriptedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(message: AssistantMessage) {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      },
    );
    if (
      message.stopReason === "error" ||
      message.stopReason === "aborted" ||
      message.stopReason === "pending"
    ) {
      throw new Error("ScriptedStream only accepts completed assistant messages");
    }
    const reason = message.stopReason;
    queueMicrotask(() => this.push({ type: "done", reason, message }));
  }
}

function assistantMessage(content: AssistantMessage["content"], stopReason: DoneReason): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "mock",
    model: "mock-model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

describe("Pi runtime integration", () => {
  it("executes the read-only analyze tool through the Pi Agent loop", async () => {
    let requestCount = 0;
    const streamFn: StreamFn = () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new ScriptedStream(
          assistantMessage(
            [
              {
                type: "toolCall",
                id: "call-analyze-001",
                name: "analyze_conversation",
                arguments: {
                  conversationId: "conversation-demo-001",
                  candidateId: "candidate-demo-001",
                  recruiterId: "recruiter-demo-001",
                  messages: [
                    {
                      id: "message-demo-002",
                      actor: "recruiter",
                      text: "你好，可以先发一份简历给我吗？",
                      sentAt: "2026-08-14T01:01:00.000Z",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        );
      }

      return new ScriptedStream(
        assistantMessage([{ type: "text", text: "分析完成，等待人工确认。" }], "stop"),
      );
    };
    const agent = createBossWatchAgent({ model, streamFn });

    await agent.prompt("分析最新招聘方消息");

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role !== "toolResult") throw new Error("Expected a tool result");
    expect(toolResult.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(toolResult.content)).toContain("resume_request");
    expect(requestCount).toBe(2);
  });
});
