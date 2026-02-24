/**
 * Provider Adapter Interface
 * Every provider must implement this contract.
 */

import type { LLMRequest, LLMResponse, StreamEvent } from "./types.js";

export interface ProviderAdapter {
  readonly name: string;

  /** Send a request, block until model finishes, return full response. */
  complete(request: LLMRequest): Promise<LLMResponse>;

  /** Send a request, return an async iterator of stream events. */
  stream(request: LLMRequest): AsyncIterable<StreamEvent>;

  /** Release resources. Called by Client.close(). */
  close?(): Promise<void>;

  /** Validate configuration on startup. Called on registration. */
  initialize?(): Promise<void>;

  /** Query whether a particular tool choice mode is supported. */
  supportsToolChoice?(mode: string): boolean;
}

/** Middleware function for the client pipeline */
export type Middleware = (
  request: LLMRequest,
  next: (request: LLMRequest) => Promise<LLMResponse>
) => Promise<LLMResponse>;
