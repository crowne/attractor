/**
 * Coding Agent Loop – Public API
 */

export {
  // Session
  createSession,
  processInput,
  injectSteering,
  queueFollowup,
  type CreateSessionOptions,
  type AgentResponse,
} from "./session.js";

export {
  // Types
  SessionState,
  TurnKind,
  EventKind,
  EventEmitter,
  DEFAULT_SESSION_CONFIG,
  TRUNCATION_LIMITS,
  type Session,
  type SessionConfig,
  type Turn,
  type UserTurn,
  type AssistantTurn,
  type ToolResultsTurn,
  type SystemTurn,
  type SteeringTurn,
  type ToolCall,
  type ToolResult,
  type ToolHandler,
  type RegisteredTool,
  type ProviderProfile,
  type SystemPromptContext,
  type SessionEvent,
  type EventListener,
  type TruncationConfig,
} from "./types.js";

export {
  // Execution Environment
  LocalExecutionEnvironment,
  type ExecutionEnvironment,
  type ExecResult,
  type DirEntry,
  type GrepOptions,
} from "./execution-env.js";

export {
  // Tools
  getCoreTools,
} from "./tools.js";

export {
  // Provider Profiles
  AnthropicProfile,
  OpenAIProfile,
  GeminiProfile,
  createProfile,
  discoverProjectDocs,
} from "./profiles.js";

export {
  // Loop Detection
  detectLoop,
  type LoopDetectionResult,
} from "./loop-detection.js";

export {
  // Truncation
  truncateOutput,
} from "./truncation.js";
