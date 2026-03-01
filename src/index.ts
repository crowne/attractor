/**
 * Attractor
 *
 * A DOT-defined pipeline runner for multi-stage AI coding workflows.
 * Integrates three layers:
 *   1. Unified LLM Client — multi-provider LLM SDK
 *   2. Coding Agent Loop — agentic tool-use loop
 *   3. Pipeline Engine — DAG-based workflow orchestration
 *
 * @example
 * ```ts
 * import { Attractor } from "attractor";
 *
 * const attractor = await Attractor.create({
 *   dotFile: "./pipeline.dot",
 *   provider: "anthropic",
 *   model: "claude-opus-4-20250514",
 * });
 *
 * const result = await attractor.run();
 * console.log(result.state, result.results);
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Layer 1: Unified LLM Client ───────────────────────────────────────

import { Client } from "./llm/client.js";
import type { LLMRequest, LLMResponse } from "./llm/types.js";

// ── Layer 2: Coding Agent Loop ─────────────────────────────────────────

import {
  createSession,
  processInput,
  type CreateSessionOptions,
} from "./agent/session.js";
import type { Session, ProviderProfile } from "./agent/types.js";
import {
  createProfile,
  discoverProjectDocs,
} from "./agent/profiles.js";
import {
  LocalExecutionEnvironment,
  type ExecutionEnvironment,
} from "./agent/execution-env.js";

// ── Layer 3: Pipeline Engine ───────────────────────────────────────────

import {
  runPipeline,
  type PipelineRunConfig,
  type PipelineRunResult,
} from "./pipeline/engine.js";
import type { CodergenBackend } from "./pipeline/handlers.js";
import type { Interviewer } from "./pipeline/human.js";
import { AutoApproveInterviewer, ConsoleInterviewer } from "./pipeline/human.js";
import type { PipelineEvent } from "./pipeline/types.js";
import { PipelineEventKind } from "./pipeline/types.js";

// ── Attractor Config ───────────────────────────────────────────────────

export interface AttractorConfig {
  /** Path to DOT pipeline file, or DOT source string */
  dotFile?: string;
  dotSource?: string;

  /** CSS-like model stylesheet file or source */
  stylesheetFile?: string;
  stylesheetSource?: string;

  /** LLM provider: "anthropic" | "openai" | "gemini" */
  provider?: string;
  /** Model identifier */
  model?: string;

  /** Working directory */
  workingDir?: string;

  /** Human interaction mode */
  interactionMode?: "auto" | "console" | "callback";
  /** Callback for human-in-the-loop (when mode is "callback") */
  onQuestion?: (question: any) => Promise<string>;

  /** Event listener */
  onEvent?: (event: PipelineEvent) => void;

  /** Initial context variables */
  variables?: Record<string, unknown>;

  /** Whether to abort on first error */
  abortOnError?: boolean;

  /** Pre-configured LLM client */
  llmClient?: Client;
}

// ── Attractor Class ────────────────────────────────────────────────────

export class Attractor {
  private config: AttractorConfig;
  private client: Client;
  private profile: ProviderProfile;
  private env: ExecutionEnvironment;
  private interviewer: Interviewer;
  private dotSource: string;
  private stylesheetSource?: string;

  private constructor(
    config: AttractorConfig,
    client: Client,
    profile: ProviderProfile,
    env: ExecutionEnvironment,
    interviewer: Interviewer,
    dotSource: string,
    stylesheetSource?: string
  ) {
    this.config = config;
    this.client = client;
    this.profile = profile;
    this.env = env;
    this.interviewer = interviewer;
    this.dotSource = dotSource;
    this.stylesheetSource = stylesheetSource;
  }

  /**
   * Create and initialize an Attractor instance.
   */
  static async create(config: AttractorConfig): Promise<Attractor> {
    // Resolve DOT source
    let dotSource: string;
    if (config.dotSource) {
      dotSource = config.dotSource;
    } else if (config.dotFile) {
      const dotPath = path.resolve(config.workingDir ?? process.cwd(), config.dotFile);
      dotSource = fs.readFileSync(dotPath, "utf-8");
    } else {
      throw new Error("Either dotFile or dotSource must be provided");
    }

    // Resolve stylesheet
    let stylesheetSource: string | undefined;
    if (config.stylesheetSource) {
      stylesheetSource = config.stylesheetSource;
    } else if (config.stylesheetFile) {
      const stylePath = path.resolve(
        config.workingDir ?? process.cwd(),
        config.stylesheetFile
      );
      if (fs.existsSync(stylePath)) {
        stylesheetSource = fs.readFileSync(stylePath, "utf-8");
      }
    }

    // Create LLM client
    const client = config.llmClient ?? Client.fromEnv();

    // Create provider profile
    const provider = config.provider ?? detectProvider(client);
    const profile = createProfile(provider, config.model);

    // Create execution environment
    const env = new LocalExecutionEnvironment(
      config.workingDir ?? process.cwd()
    );
    await env.initialize();

    // Create interviewer
    let interviewer: Interviewer;
    switch (config.interactionMode) {
      case "console":
        interviewer = new ConsoleInterviewer();
        break;
      case "callback":
        if (!config.onQuestion) {
          throw new Error(
            "onQuestion callback required for callback interaction mode"
          );
        }
        const { CallbackInterviewer } = await import("./pipeline/human.js");
        interviewer = new CallbackInterviewer(config.onQuestion);
        break;
      case "auto":
      default:
        interviewer = new AutoApproveInterviewer();
    }

    return new Attractor(
      config,
      client,
      profile,
      env,
      interviewer,
      dotSource,
      stylesheetSource
    );
  }

  /**
   * Run the pipeline.
   */
  async run(): Promise<PipelineRunResult> {
    // Create codergen backend that wraps the agent loop
    const codergen = this.createCodergenBackend();

    const result = await runPipeline({
      dot_source: this.dotSource,
      stylesheet_source: this.stylesheetSource,
      codergen,
      interviewer: this.interviewer,
      initial_variables: this.config.variables,
      on_event: this.config.onEvent,
      abort_on_error: this.config.abortOnError,
    });

    return result;
  }

  /**
   * Run a single agent session (without pipeline).
   */
  async runAgent(prompt: string): Promise<string> {
    const session = createSession({
      provider_profile: this.profile,
      execution_env: this.env,
      llm_client: this.client,
    });

    // Forward agent session events through onEvent if configured
    if (this.config.onEvent) {
      const onEvent = this.config.onEvent;
      session.events.onAny((event) => {
        onEvent({
          kind: PipelineEventKind.AGENT_EVENT,
          pipeline_id: "",
          node_id: "agent",
          timestamp: event.timestamp,
          data: {
            agent_event_kind: event.kind,
            session_id: event.session_id,
            ...event.data,
          },
        });
      });
    }

    const response = await processInput(session, prompt);
    return response.text;
  }

  /**
   * Get the underlying LLM client.
   */
  getClient(): Client {
    return this.client;
  }

  /**
   * Get the execution environment.
   */
  getExecutionEnv(): ExecutionEnvironment {
    return this.env;
  }

  /**
   * Cleanup resources.
   */
  async close(): Promise<void> {
    await this.env.cleanup();
    await this.interviewer.close();
    await this.client.close();
  }

  // ── Private ──────────────────────────────────────────────────────────

  private createCodergenBackend(): CodergenBackend {
    const onEvent = this.config.onEvent;

    return {
      execute: async (opts) => {
        // Create a session for this node
        const profile = opts.model
          ? createProfile(this.profile.provider, opts.model)
          : this.profile;

        const session = createSession({
          provider_profile: profile,
          execution_env: this.env,
          llm_client: this.client,
        });

        // Forward agent session events through the pipeline onEvent callback
        if (onEvent) {
          session.events.onAny((event) => {
            onEvent({
              kind: PipelineEventKind.AGENT_EVENT,
              pipeline_id: "",
              node_id: opts.node_id,
              timestamp: event.timestamp,
              data: {
                agent_event_kind: event.kind,
                session_id: event.session_id,
                ...event.data,
              },
            });
          });
        }

        // Build prompt with goal
        let prompt = opts.prompt;
        if (opts.goal) {
          prompt += `\n\n## Goal\n${opts.goal}\n\nYou MUST achieve this goal. If you cannot, explain why.`;
        }

        try {
          const response = await processInput(session, prompt);

          return {
            output: response.text,
            outcome:
              response.reason === "complete" ? "success" : response.reason,
          };
        } catch (err: any) {
          return {
            output: err.message,
            outcome: "error",
          };
        }
      },
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function detectProvider(client: Client): string {
  // Check which providers are registered
  // Default to anthropic
  return "anthropic";
}

// ── Re-exports ─────────────────────────────────────────────────────────

// Layer 1: LLM
export * from "./llm/index.js";

// Layer 2: Agent
export * from "./agent/index.js";

// Layer 3: Pipeline
export * from "./pipeline/index.js";
