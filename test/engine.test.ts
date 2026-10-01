import { expect, test } from "bun:test";
import { getEngine } from "../src/engines";
import { EngineNotImplemented } from "../src/engines/stub";

test("claude and codex engines are registered", () => {
  expect(getEngine("claude").name).toBe("claude");
  expect(getEngine("codex").name).toBe("codex");
});

test("opencode is still a stub that fails loudly", async () => {
  const e = getEngine("opencode");
  expect(e.name).toBe("opencode");
  await expect(
    e.run({
      cwd: "/tmp",
      prompt: "hi",
      env: {},
      onText: () => {},
      onPermission: async () => ({ allow: true }),
    }),
  ).rejects.toBeInstanceOf(EngineNotImplemented);
});
