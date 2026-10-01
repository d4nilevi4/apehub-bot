import { expect, test } from "bun:test";
import { Broker, type ExecFn } from "../src/broker";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exec that tracks peak concurrency and resolves after a short delay. */
function trackingExec() {
  const state = { cur: 0, peak: 0 };
  const exec: ExecFn = async (command) => {
    state.cur++;
    state.peak = Math.max(state.peak, state.cur);
    await tick(15);
    state.cur--;
    return { exitCode: 0, output: `ran ${command}`, timedOut: false };
  };
  return { exec, state };
}

test("submit resolves with the exec result", async () => {
  const b = new Broker({ exec: async (c) => ({ exitCode: 0, output: `ran ${c}`, timedOut: false }) });
  expect((await b.submit({ command: "x" })).output).toBe("ran x");
});

test("unity cap = 1 serializes unity jobs", async () => {
  const { exec, state } = trackingExec();
  const b = new Broker({ exec, caps: { unity: 1 }, globalCap: 5 });
  await Promise.all([
    b.submit({ command: "u1", kind: "unity" }),
    b.submit({ command: "u2", kind: "unity" }),
    b.submit({ command: "u3", kind: "unity" }),
  ]);
  expect(state.peak).toBe(1);
});

test("global cap bounds total concurrency across kinds", async () => {
  const { exec, state } = trackingExec();
  const b = new Broker({ exec, globalCap: 2, defaultCap: 10 });
  await Promise.all([
    b.submit({ command: "a" }),
    b.submit({ command: "b" }),
    b.submit({ command: "c" }),
    b.submit({ command: "d" }),
  ]);
  expect(state.peak).toBe(2);
});

test("list reports queued and running jobs", async () => {
  const { exec } = trackingExec();
  const b = new Broker({ exec, globalCap: 1 });
  const p = Promise.all([b.submit({ command: "a" }), b.submit({ command: "b" })]);
  await tick(2); // a running, b queued
  const jobs = b.list();
  expect(jobs).toHaveLength(2);
  expect(jobs.some((j) => j.state === "running")).toBe(true);
  expect(jobs.some((j) => j.state === "queued")).toBe(true);
  await p;
});
