import { expect, test } from "bun:test";
import { Bridge } from "../src/bridge";
import { FakeApi } from "./helpers";

test("permission: allow resolves and edits the message", async () => {
  const api = new FakeApi();
  const b = new Bridge(api, -100, 1000);
  const pending = b.requestPermission(5, { toolName: "Bash", input: { command: "ls" } });
  const data = api.lastButtonData()!;
  expect(data).toMatch(/^perm:.+:allow$/);
  expect(b.handlePermissionCallback(data)).toBe(true);
  expect(await pending).toEqual({ allow: true });
  expect(api.edits).toHaveLength(1);
});

test("permission: deny resolves with a message", async () => {
  const api = new FakeApi();
  const b = new Bridge(api, -100, 1000);
  const pending = b.requestPermission(5, { toolName: "Bash", input: { command: "rm" } });
  const denyData = api.lastButtonData()!.replace(":allow", ":deny");
  expect(b.handlePermissionCallback(denyData)).toBe(true);
  const d = await pending;
  expect(d.allow).toBe(false);
  if (!d.allow) expect(d.message).toContain("denied");
});

test("permission: non-perm callbacks and stale ids are reported correctly", () => {
  const api = new FakeApi();
  const b = new Bridge(api, -100, 1000);
  expect(b.handlePermissionCallback("something:else")).toBe(false);
  expect(b.handlePermissionCallback("perm:nope:allow")).toBe(true); // matched shape, already gone
});

test("ask_user: resolves on the next reply, once", async () => {
  const api = new FakeApi();
  const b = new Bridge(api, -100, 1000);
  const answer = b.askUser(5, "What colour?");
  expect(api.sent.at(-1)?.text).toContain("What colour?");
  expect(b.hasPendingAsk(5)).toBe(true);
  expect(b.resolveAsk(5, "blue")).toBe(true);
  expect(await answer).toBe("blue");
  expect(b.resolveAsk(5, "again")).toBe(false);
});

test("ask_user: times out with a sentinel", async () => {
  const api = new FakeApi();
  const b = new Bridge(api, -100, 10);
  expect(await b.askUser(5, "q")).toContain("no answer");
});
