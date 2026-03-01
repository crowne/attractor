/**
 * Pipeline Module – Public API
 */

// DOT Parser
export {
  parseDot,
  DotParseError,
  type DotGraph,
  type DotNode,
  type DotEdge,
  type DotSubgraph,
} from "./dot-parser.js";

// Graph Builder
export { buildPipelineGraph } from "./graph-builder.js";

// Types
export {
  NodeShape,
  RunState,
  PipelineEventKind,
  DEFAULT_BACKOFF,
  type PipelineGraph,
  type PipelineNode,
  type PipelineEdge,
  type PipelineContext,
  type NodeResult,
  type RunStatus,
  type PipelineEvent,
  type BackoffConfig,
} from "./types.js";

// Validator
export {
  validatePipeline,
  hasErrors,
  formatDiagnostics,
  Severity,
  type Diagnostic,
} from "./validator.js";

// Execution Engine
export {
  runPipeline,
  type PipelineRunConfig,
  type PipelineRunResult,
} from "./engine.js";

// Conditions
export { evaluateCondition } from "./conditions.js";

// Stylesheet
export {
  parseStylesheet,
  computeNodeStyle,
  type StyleRule,
  type StyleSelector,
  type ComputedStyle,
} from "./stylesheet.js";

// Node Handlers
export {
  registerHandler,
  getHandler,
  type NodeHandler,
  type NodeHandlerContext,
  type CodergenBackend,
} from "./handlers.js";

// Human-in-the-Loop
export {
  AutoApproveInterviewer,
  ConsoleInterviewer,
  CallbackInterviewer,
  QueueInterviewer,
  type Interviewer,
  type Question,
  type QuestionChoice,
  type Answer,
} from "./human.js";

// Verbose Logger
export {
  createVerboseLogger,
  type VerboseLoggerOptions,
} from "./verbose-logger.js";
