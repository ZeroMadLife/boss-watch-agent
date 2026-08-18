import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ActionDecision, type BossAction, decideAction } from "../policy/action-policy.js";
import { analyzeConversationTool } from "../tools/analyze-conversation-tool.js";

/**
 * The effect class is deliberately separate from the Pi tool implementation.
 * A Skill description is not a permission grant; this metadata is checked by
 * the business registry before a tool becomes visible to the Agent.
 */
export type BossToolEffect = "read_only" | "local_record" | "proposal" | "external_side_effect";

export type AtomicOperation =
  | "capture_one_conversation"
  | "capture_one_job_description"
  | "capture_one_interview_note"
  | "analyze_one_conversation"
  | "draft_one_reply"
  | "record_one_evidence"
  | "propose_one_status_change"
  | "sync_one_application_projection"
  | "send_one_message";

export interface BossToolDefinition {
  tool: AgentTool;
  action: BossAction;
  effect: BossToolEffect;
  operation: AtomicOperation;
}

export interface BossToolDescriptor {
  name: string;
  action: BossAction;
  effect: BossToolEffect;
  operation: AtomicOperation;
}

export class BossToolRegistry {
  readonly #definitions = new Map<string, BossToolDefinition>();

  constructor(definitions: readonly BossToolDefinition[]) {
    for (const definition of definitions) {
      const name = definition.tool.name.trim();
      if (!name) throw new Error("tool_name_required");
      if (this.#definitions.has(name)) throw new Error(`duplicate_tool_name:${name}`);

      const policy = decideAction(definition.action);
      if (definition.effect === "external_side_effect" && policy.decision !== "require_approval") {
        throw new Error(`external_tool_must_require_approval:${name}`);
      }
      if (policy.decision === "require_approval" && definition.effect !== "external_side_effect") {
        throw new Error(`approval_tool_must_be_external:${name}`);
      }
      this.#definitions.set(name, definition);
    }
  }

  list(): BossToolDescriptor[] {
    return [...this.#definitions.values()].map((definition) => ({
      name: definition.tool.name,
      action: definition.action,
      effect: definition.effect,
      operation: definition.operation,
    }));
  }

  toPiTools(): AgentTool[] {
    return [...this.#definitions.values()].map((definition) => definition.tool);
  }

  get(name: string): BossToolDefinition | undefined {
    return this.#definitions.get(name);
  }

  decide(name: string): ActionDecision {
    const definition = this.#definitions.get(name);
    return decideAction(definition?.action ?? name);
  }
}

export function createDefaultToolRegistry(): BossToolRegistry {
  return new BossToolRegistry([
    {
      tool: analyzeConversationTool,
      action: "analyze_conversation",
      effect: "read_only",
      operation: "analyze_one_conversation",
    },
  ]);
}
