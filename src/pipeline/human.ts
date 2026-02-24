/**
 * Human-in-the-Loop System
 *
 * Provides the Interviewer interface for pipeline nodes
 * that need human input (hexagon/wait-for-human).
 */

import * as readline from "node:readline";

// ── Question / Answer ──────────────────────────────────────────────────

export interface Question {
  id: string;
  text: string;
  /** Available choices (for multi-choice questions) */
  choices?: QuestionChoice[];
  /** Default answer */
  default_value?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

export interface QuestionChoice {
  label: string;
  value: string;
  /** Keyboard accelerator key */
  accelerator?: string;
}

export interface Answer {
  question_id: string;
  value: string;
  /** Was this auto-approved? */
  auto_approved: boolean;
  timestamp: number;
}

// ── Interviewer Interface ──────────────────────────────────────────────

export interface Interviewer {
  /**
   * Ask a question and get an answer.
   */
  ask(question: Question): Promise<Answer>;

  /**
   * Present multiple questions at once.
   */
  askAll(questions: Question[]): Promise<Answer[]>;

  /**
   * Close the interviewer and release resources.
   */
  close(): Promise<void>;
}

// ── Auto-Approve Interviewer ───────────────────────────────────────────

/**
 * Always returns the default value or first choice.
 * Used for fully automated pipelines.
 */
export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    const value =
      question.default_value ??
      question.choices?.[0]?.value ??
      "approved";

    return {
      question_id: question.id,
      value,
      auto_approved: true,
      timestamp: Date.now(),
    };
  }

  async askAll(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map((q) => this.ask(q)));
  }

  async close(): Promise<void> {
    // no-op
  }
}

// ── Console Interviewer ────────────────────────────────────────────────

/**
 * Asks questions via stdin/stdout.
 */
export class ConsoleInterviewer implements Interviewer {
  private rl: readline.Interface | null = null;

  private getRL(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  async ask(question: Question): Promise<Answer> {
    const rl = this.getRL();

    let prompt = `\n${question.text}`;

    if (question.choices && question.choices.length > 0) {
      prompt += "\n";
      for (const choice of question.choices) {
        const accel = choice.accelerator ? `(${choice.accelerator}) ` : "";
        prompt += `  ${accel}${choice.label}\n`;
      }
    }

    if (question.default_value) {
      prompt += `[default: ${question.default_value}] `;
    }

    prompt += "> ";

    const response = await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer.trim());
      });
    });

    // Check accelerator keys
    let value = response || question.default_value || "";
    if (question.choices) {
      const byAccel = question.choices.find(
        (c) =>
          c.accelerator?.toLowerCase() === response.toLowerCase()
      );
      if (byAccel) {
        value = byAccel.value;
      }
      const byLabel = question.choices.find(
        (c) => c.label.toLowerCase() === response.toLowerCase()
      );
      if (byLabel) {
        value = byLabel.value;
      }
    }

    return {
      question_id: question.id,
      value,
      auto_approved: false,
      timestamp: Date.now(),
    };
  }

  async askAll(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const q of questions) {
      answers.push(await this.ask(q));
    }
    return answers;
  }

  async close(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ── Callback Interviewer ───────────────────────────────────────────────

/**
 * Delegates to a user-provided callback function.
 */
export class CallbackInterviewer implements Interviewer {
  constructor(
    private callback: (question: Question) => Promise<string>
  ) {}

  async ask(question: Question): Promise<Answer> {
    const value = await this.callback(question);
    return {
      question_id: question.id,
      value,
      auto_approved: false,
      timestamp: Date.now(),
    };
  }

  async askAll(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map((q) => this.ask(q)));
  }

  async close(): Promise<void> {
    // no-op
  }
}

// ── Queue Interviewer ──────────────────────────────────────────────────

/**
 * Returns answers from a pre-loaded queue. Useful for testing.
 */
export class QueueInterviewer implements Interviewer {
  private queue: string[];

  constructor(answers: string[]) {
    this.queue = [...answers];
  }

  async ask(question: Question): Promise<Answer> {
    const value =
      this.queue.shift() ?? question.default_value ?? "approved";

    return {
      question_id: question.id,
      value,
      auto_approved: this.queue.length > 0 ? false : true,
      timestamp: Date.now(),
    };
  }

  async askAll(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map((q) => this.ask(q)));
  }

  async close(): Promise<void> {
    // no-op
  }
}
