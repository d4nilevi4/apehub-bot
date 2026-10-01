import type { Engine, EngineName, RunOptions, RunResult } from "../engine";

export class EngineNotImplemented extends Error {}

/** opencode / codex: fixed per project, wired later. Fails loudly if selected now. */
export function makeStubEngine(name: EngineName): Engine {
  return {
    name,
    capabilities: { models: [], contextWindow: () => undefined },
    async run(_opts: RunOptions): Promise<RunResult> {
      throw new EngineNotImplemented(`engine '${name}' is not implemented yet`);
    },
  };
}
