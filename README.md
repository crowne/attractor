# Attractor

A DOT-defined pipeline runner for multi-stage AI coding workflows.

Implements three integrated layers:

1. **Unified LLM Client** — Multi-provider SDK supporting Anthropic, OpenAI, and Gemini
2. **Coding Agent Loop** — Agentic tool-use loop with file editing, shell access, and search
3. **Pipeline Engine** — DAG-based workflow orchestration using Graphviz DOT syntax

Based on the [Attractor specification](https://github.com/strongdm/attractor).

## Quick Start

```bash
npm install
npm run build
```

### Run a Pipeline

```typescript
import { Attractor } from "attractor";

const attractor = await Attractor.create({
  dotSource: `
    digraph pipeline {
      start [shape=ellipse, label="Start"]
      implement [shape=box, label="Implement feature", prompt="Add a hello world endpoint"]
      review [shape=diamond, label="Review"]
      done [shape=doublecircle, label="Done"]

      start -> implement -> review
      review -> implement [label="needs_work"]
      review -> done [label="approved"]
    }
  `,
  provider: "anthropic",
  model: "claude-opus-4-20250514",
});

const result = await attractor.run();
console.log(result.state, result.results.length, "nodes executed");
```

### Run a Single Agent Session

```typescript
import { Attractor } from "attractor";

const attractor = await Attractor.create({
  dotSource: "digraph { start [shape=ellipse] }",
  provider: "anthropic",
});

const response = await attractor.runAgent("Create a REST API with Express.js");
console.log(response);
```

### Use the LLM Client Directly

```typescript
import { Client, generate } from "attractor";

const client = Client.fromEnv(); // reads ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
const result = await generate({
  model: "claude-opus-4-20250514",
  prompt: "Explain monads in one paragraph",
  client,
});
console.log(result.text);
```

## Architecture

```
┌─────────────────────────────────────────────┐
│            Pipeline Engine (L3)             │
│  DOT parser → Graph → Validator → Engine    │
│  Node handlers, stylesheet, conditions      │
├─────────────────────────────────────────────┤
│           Coding Agent Loop (L2)            │
│  Session → LLM call → Tool exec → Loop     │
│  Provider profiles, steering, loop detect   │
├─────────────────────────────────────────────┤
│          Unified LLM Client (L1)            │
│  Anthropic · OpenAI · Gemini adapters       │
│  Streaming, retries, middleware, catalog    │
└─────────────────────────────────────────────┘
```

## Pipeline DOT Syntax

Nodes are typed by shape:

| Shape | Meaning | Handler |
|-------|---------|---------|
| `ellipse` | Start node | Pass-through |
| `box` | LLM/codergen task | Runs agent session |
| `diamond` | Conditional branch | Evaluates outcome |
| `hexagon` | Wait for human | Prompts user |
| `component` | Parallel fan-out | Runs branches concurrently |
| `tripleoctagon` | Fan-in / join | Waits for all branches |
| `doublecircle` | Exit / terminal | Ends pipeline |
| `plain` | Tool invocation | Runs specific tool |

### Edge Selection (5-step priority)

1. Explicit condition match (`condition` attribute)
2. Label matches `preferred_label`
3. Label matches `outcome`
4. Priority ordering (`priority` attribute)
5. Default/unlabeled edge

### Model Stylesheet

```css
* { model: "claude-sonnet-4-20250514"; temperature: 0; }
.fast { model: "claude-haiku-4-20250514"; }
#review { model: "claude-opus-4-20250514"; reasoning_effort: "high"; }
```

## Environment Variables

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT) |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Google (Gemini) |

## Project Structure

```
src/
├── llm/                  # Layer 1: Unified LLM Client
│   ├── types.ts          # Data model (Message, Request, Response, etc.)
│   ├── catalog.ts        # Model catalog
│   ├── adapter.ts        # Provider adapter interface
│   ├── providers/        # Provider implementations
│   │   ├── anthropic.ts  # Anthropic Messages API
│   │   ├── openai.ts     # OpenAI Responses API
│   │   └── gemini.ts     # Google Gemini API
│   ├── client.ts         # Client with routing & middleware
│   └── generate.ts       # High-level API (generate, stream, generate_object)
├── agent/                # Layer 2: Coding Agent Loop
│   ├── types.ts          # Session, Turn, Event types
│   ├── session.ts        # Core agentic loop
│   ├── execution-env.ts  # Execution environment abstraction
│   ├── tools.ts          # Core tools (read/write/edit/shell/grep/glob)
│   ├── profiles.ts       # Provider-specific profiles
│   ├── loop-detection.ts # Loop detection via Jaccard similarity
│   └── truncation.ts     # Output truncation
├── pipeline/             # Layer 3: Pipeline Engine
│   ├── dot-parser.ts     # DOT language parser
│   ├── types.ts          # Graph model types
│   ├── graph-builder.ts  # DOT AST → PipelineGraph
│   ├── validator.ts      # Graph validation & linting
│   ├── engine.ts         # Execution engine
│   ├── handlers.ts       # Node handlers (codergen, conditional, etc.)
│   ├── conditions.ts     # Condition expression evaluator
│   ├── stylesheet.ts     # CSS-like model stylesheet
│   └── human.ts          # Human-in-the-loop system
└── index.ts              # Entry point & public API
```

## License

Apache-2.0
