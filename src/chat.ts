import {
  configure,
  createRegistry,
  defineExtension,
  section,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import { createBindingModels } from "./binding-provider.ts";
import { DeliverScheduledInstruction } from "./schedule.ts";
import { conversationSearchExtension, searchHistoryTool } from "./search.ts";
import { getWeatherTool, scheduleTool } from "./tools.ts";

/**
 * Default chat model: Workers AI through the Worker's own `AI` binding, so inference
 * needs no third-party credential. Ids keep the catalog's `workers-ai/@cf/...` form;
 * the binding transport maps them to the gateway's `@cf/...` ids at dispatch, and the
 * `{CLOUDFLARE_GATEWAY_ID}` placeholder is filled from Worker vars. Gemma 4 is verified
 * on this account with tools and streaming; gpt-oss is left out because its reasoning
 * traces need compat the gateway compat route does not carry here.
 */
const BINDING_MODEL = {
  provider: "cloudflare-ai-gateway",
  modelId: "workers-ai/@cf/google/gemma-4-26b-a4b-it",
};

/** Application-owned, platform-independent agent composition. `env.AI` is the Worker's own inference binding. */
export function createChatHarnessOptions(env: Env): HarnessOptions {
  const chatExtension = defineExtension({
    name: "chat",
    tasks: [DeliverScheduledInstruction],
    tools: [getWeatherTool, scheduleTool, searchHistoryTool],
    sections: [
      section(
        "preamble",
        () =>
          "You are a concise assistant. User messages may begin with a display name in brackets; treat it as speaker attribution.",
        { tag: false },
      ),
      section(
        "clock",
        // Minute precision: finer values would append a system-prompt delta on every request.
        () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`,
        { tag: false },
      ),
    ],
  });
  const registry = createRegistry();
  registry.install(chatExtension);
  registry.install(conversationSearchExtension);
  const defaultAgent = {
    model: BINDING_MODEL,
    thinkingLevel: "off" as const,
    tools: [getWeatherTool, scheduleTool, searchHistoryTool],
  };

  return {
    models: createBindingModels(env),
    registry,
    settings: { extensions: [chatExtension] },
    conversationCreated: (tx, conversation) =>
      conversation.owner === undefined && conversation.parent === undefined
        ? configure(tx, conversation.id, defaultAgent)
        : undefined,
  };
}
