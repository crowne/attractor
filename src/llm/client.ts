/**
 * Unified LLM Client
 * Core client that routes requests to provider adapters.
 */

import type { ProviderAdapter, Middleware } from "./adapter.js";
import {
  type LLMRequest,
  type LLMResponse,
  type StreamEvent,
  ConfigurationError,
} from "./types.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { OpenAIAdapter } from "./providers/openai.js";
import { GeminiAdapter } from "./providers/gemini.js";
import { OllamaAdapter } from "./providers/ollama.js";

export interface ClientConfig {
  providers?: Record<string, ProviderAdapter>;
  default_provider?: string;
  middleware?: Middleware[];
}

export class Client {
  private providers: Map<string, ProviderAdapter> = new Map();
  private defaultProvider?: string;
  private middleware: Middleware[];

  constructor(config: ClientConfig = {}) {
    this.middleware = config.middleware ?? [];

    if (config.providers) {
      for (const [name, adapter] of Object.entries(config.providers)) {
        this.providers.set(name, adapter);
      }
    }

    this.defaultProvider = config.default_provider;

    // If no default, use the first registered
    if (!this.defaultProvider && this.providers.size > 0) {
      this.defaultProvider = this.providers.keys().next().value;
    }
  }

  /**
   * Create a Client from environment variables.
   * Only providers with keys present are registered.
   */
  static fromEnv(): Client {
    const providers: Record<string, ProviderAdapter> = {};

    const anthropicKey =
      process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      providers.anthropic = new AnthropicAdapter({
        api_key: anthropicKey,
        base_url: process.env.ANTHROPIC_BASE_URL,
      });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      providers.openai = new OpenAIAdapter({
        api_key: openaiKey,
        base_url: process.env.OPENAI_BASE_URL,
        org_id: process.env.OPENAI_ORG_ID,
        project_id: process.env.OPENAI_PROJECT_ID,
      });
    }

    const geminiKey =
      process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (geminiKey) {
      providers.gemini = new GeminiAdapter({
        api_key: geminiKey,
        base_url: process.env.GEMINI_BASE_URL,
      });
    }

    // Ollama: register if OLLAMA_HOST or OLLAMA_BASE_URL is set,
    // or if none of the cloud providers are configured (local-first fallback)
    const ollamaHost =
      process.env.OLLAMA_HOST ?? process.env.OLLAMA_BASE_URL;
    if (ollamaHost || Object.keys(providers).length === 0) {
      providers.ollama = new OllamaAdapter({
        base_url: ollamaHost,
        api_key: process.env.OLLAMA_API_KEY,
        default_model: process.env.OLLAMA_MODEL,
      });
    }

    return new Client({ providers });
  }

  /** Register a provider adapter */
  register(name: string, adapter: ProviderAdapter): void {
    this.providers.set(name, adapter);
    if (!this.defaultProvider) {
      this.defaultProvider = name;
    }
  }

  /** Get a registered provider adapter */
  getProvider(name: string): ProviderAdapter | undefined {
    return this.providers.get(name);
  }

  /** List registered provider names */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Resolve the provider for a request */
  private resolveProvider(request: LLMRequest): ProviderAdapter {
    const providerName = request.provider ?? this.defaultProvider;
    if (!providerName) {
      throw new ConfigurationError(
        "No provider specified and no default provider configured"
      );
    }

    const adapter = this.providers.get(providerName);
    if (!adapter) {
      throw new ConfigurationError(
        `Provider '${providerName}' is not registered. Available: ${this.listProviders().join(", ")}`
      );
    }

    return adapter;
  }

  /** Send a request and block until complete */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const adapter = this.resolveProvider(request);

    // Build middleware chain
    const chain = this.middleware.reduceRight<
      (req: LLMRequest) => Promise<LLMResponse>
    >(
      (next, mw) => (req) => mw(req, next),
      (req) => adapter.complete(req)
    );

    return chain(request);
  }

  /** Send a request and return streaming events */
  async *stream(
    request: LLMRequest
  ): AsyncIterable<StreamEvent> {
    const adapter = this.resolveProvider(request);
    yield* adapter.stream(request);
  }

  /** Close all providers and release resources */
  async close(): Promise<void> {
    for (const adapter of this.providers.values()) {
      if (adapter.close) {
        await adapter.close();
      }
    }
  }
}

// ── Module-level default client ──────────────────────────────────────

let defaultClient: Client | undefined;

export function setDefaultClient(client: Client): void {
  defaultClient = client;
}

export function getDefaultClient(): Client {
  if (!defaultClient) {
    defaultClient = Client.fromEnv();
  }
  return defaultClient;
}
