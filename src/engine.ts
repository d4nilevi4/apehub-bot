import type { EngineName } from "./config";

export type { EngineName };

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export type PermissionDecision =
  | { allow: true; updatedInput?: Record<string, unknown> }
  | { allow: false; message: string };

export interface RunOptions {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  env: Record<string, string>;
  model?: string;
  systemPromptAppend?: string;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  signal?: AbortSignal;
  /** Called for each assistant text block as it streams. */
  onText: (text: string) => void | Promise<void>;
  /** Called when the harness wants to run a tool that is not pre-approved. */
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface RunResult {
  /** Session id to persist for the next (resumed) turn. */
  sessionId: string;
  /** Final result text (fallback if nothing was streamed). */
  text: string;
  isError: boolean;
  /** Actual model the engine used this turn, if reported. */
  model?: string;
  /** Approx. context tokens occupied (prompt side) after this turn, if reported. */
  ctxUsed?: number;
}

export interface EngineCapabilities {
  /** Suggested models for the /switchmodel picker (typed names also pass through). */
  models: string[];
  /** Approx. context window in tokens for a given model (for /context %). */
  contextWindow(model?: string): number | undefined;
}

export interface Engine {
  readonly name: EngineName;
  readonly capabilities: EngineCapabilities;
  run(opts: RunOptions): Promise<RunResult>;
}
