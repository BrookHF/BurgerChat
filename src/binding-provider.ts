import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
  Api,
  ApiKeyAuth,
  AuthContext,
  FetchFunction,
  Model,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { cloudflareStreams } from "@earendil-works/pi-ai/providers/cloudflare-stream";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/**
 * Inference without a third-party token. A Worker talks to its own account's AI Gateway
 * through the AI binding's fetch passthrough (`env.AI.fetch()`), which serves the gateway's
 * provider passthrough at `https://workers-binding.ai/ai-gateway/gateways/{gateway}/compat/...`.
 * Binding calls are pre-authenticated in-account: the only headers needed are the binding
 * sentinel plus `Authorization: null` / `x-api-key: null`, which keep SDK placeholder auth
 * headers from reaching the gateway (it reads a request-supplied auth header as a
 * bring-your-own provider key). Verified on this account with tools and streaming for
 * `@cf/google/gemma-4-26b-a4b-it` and `@cf/openai/gpt-oss-20b`.
 */
const BINDING_BASE_URL =
  "https://workers-binding.ai/ai-gateway/gateways/{CLOUDFLARE_GATEWAY_ID}/compat/v1";

/** Worker var naming the gateway; defaults to the account's default gateway. */
const GATEWAY_VAR = "CLOUDFLARE_GATEWAY_ID";

function bindingAuth(env: Env): ApiKeyAuth {
  return {
    name: "Cloudflare AI binding",
    login: async () => {
      throw new Error("The AI binding needs no login: it comes from the Worker's ai binding.");
    },
    resolve: async ({ ctx, signal }) => {
      signal.throwIfAborted();
      const gatewayId = (await ctx.env(GATEWAY_VAR)) ?? "default";
      signal.throwIfAborted();
      return {
        auth: {
          headers: {
            "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
            Authorization: null,
            "x-api-key": null,
          },
        },
        env: { [GATEWAY_VAR]: gatewayId },
        source: "worker binding",
      };
    },
  };
}

/** Catalog model -> binding route and the gateway's native `@cf/...` id. */
function bindingModel(model: Model<"openai-completions">): Model<"openai-completions"> {
  return { ...model, id: model.id.replace(/^workers-ai\//, ""), baseUrl: BINDING_BASE_URL };
}

function bindingStreams(streams: ProviderStreams, fetch: FetchFunction): ProviderStreams {
  return {
    stream: (model, context, options) =>
      streams.stream(bindingModel(model as Model<"openai-completions">), context, {
        ...options,
        fetch,
      }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(bindingModel(model as Model<"openai-completions">), context, {
        ...options,
        fetch,
      }),
  };
}

/** Gateway catalog entries this transport can serve: the `workers-ai/@cf/...` completions models. */
const GATEWAY_COMPLETION_MODELS = (
  Object.values(CLOUDFLARE_AI_GATEWAY_MODELS) as Model<Api>[]
).filter(
  (model): model is Model<"openai-completions"> =>
    model.api === "openai-completions" && model.id.startsWith("workers-ai/"),
);

/** Provider that runs `openai-completions` models over the AI binding passthrough. */
export function cloudflareBindingProvider(env: Env) {
  const api = cloudflareStreams(openAICompletionsApi());
  return createProvider<"openai-completions">({
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway (Worker binding)",
    auth: { apiKey: bindingAuth(env) },
    // The catalog keeps HTTPS urls; the binding transport replaces them at dispatch.
    models: GATEWAY_COMPLETION_MODELS,
    api: { "openai-completions": bindingStreams(api, createAiBindingFetch(env.AI)) },
  });
}

/**
 * The model catalog for the harness. Binding inference needs no secret; the OpenAI provider
 * stays registered so an `OPENAI_API_KEY` secret (when set) can serve the `openai/*` models
 * used by history search.
 */
export function createBindingModels(env: Env) {
  // Workers have no process.env: ambient auth reads Worker vars and secrets through `env`.
  const authContext: AuthContext = {
    env: async (name: string) => {
      const value: unknown = env[name as keyof Env];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    fileExists: async () => false,
  };
  const models = createModels({ authContext });
  models.setProvider(cloudflareBindingProvider(env));
  models.setProvider(openaiProvider());
  return models;
}
