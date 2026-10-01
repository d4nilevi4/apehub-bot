import type { Engine, EngineName } from "../engine";
import { ClaudeEngine } from "./claude";
import { CodexEngine } from "./codex";
import { makeStubEngine } from "./stub";

const engines: Record<EngineName, Engine> = {
  claude: new ClaudeEngine(),
  codex: new CodexEngine(),
  opencode: makeStubEngine("opencode"),
};

export function getEngine(name: EngineName): Engine {
  const e = engines[name];
  if (!e) throw new Error(`unknown engine: ${name}`);
  return e;
}
