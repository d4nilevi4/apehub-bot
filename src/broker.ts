import { spawn } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface JobResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export interface BrokerJob {
  id: number;
  kind: string;
  command: string;
  state: "queued" | "running";
}

export interface SubmitReq {
  command: string;
  kind?: string;
  timeoutSec?: number;
}

/** Runs one job; injectable so the queue logic can be tested without real processes. */
export type ExecFn = (command: string, opts: { timeoutSec: number }) => Promise<JobResult>;

interface QueueItem {
  job: BrokerJob;
  req: SubmitReq;
  resolve: (r: JobResult) => void;
  reject: (e: unknown) => void;
}

export interface BrokerOptions {
  /** Per-kind concurrency caps (e.g. { unity: 1 }). */
  caps?: Record<string, number>;
  defaultCap?: number;
  globalCap?: number;
  memoryMax?: string;
  cpuQuota?: string;
  exec?: ExecFn;
}

/**
 * The single sanctioned launcher for heavy/long jobs (Unity, Blender, builds).
 * A global concurrency cap plus per-kind caps (Unity = 1) protect the shared CPU;
 * jobs run in a resource-limited systemd-run scope. One shared instance = caps are
 * server-wide across all topics.
 * ponytail: soft enforcement (agents still have a shell in their sandbox); hard
 * enforcement (only the broker may spawn heavy procs) needs cgroup/uid work later.
 */
export class Broker {
  private seq = 0;
  private running = new Map<string, number>();
  private active = new Map<number, BrokerJob>();
  private queue: QueueItem[] = [];
  private caps: Record<string, number>;
  private defaultCap: number;
  private globalCap: number;
  private exec: ExecFn;

  constructor(opts: BrokerOptions = {}) {
    this.caps = opts.caps ?? { unity: 1 };
    this.defaultCap = opts.defaultCap ?? 2;
    this.globalCap = opts.globalCap ?? 3;
    this.exec = opts.exec ?? systemdRunExec(opts.memoryMax ?? "4G", opts.cpuQuota ?? "400%");
  }

  submit(req: SubmitReq): Promise<JobResult> {
    const job: BrokerJob = { id: ++this.seq, kind: req.kind || "default", command: req.command, state: "queued" };
    return new Promise<JobResult>((resolve, reject) => {
      this.queue.push({ job, req, resolve, reject });
      this.pump();
    });
  }

  list(): BrokerJob[] {
    return [...this.active.values(), ...this.queue.map((q) => q.job)];
  }

  private cap(kind: string): number {
    return this.caps[kind] ?? this.defaultCap;
  }

  private totalRunning(): number {
    let n = 0;
    for (const v of this.running.values()) n += v;
    return n;
  }

  private pump(): void {
    while (this.totalRunning() < this.globalCap) {
      const i = this.queue.findIndex((q) => (this.running.get(q.job.kind) ?? 0) < this.cap(q.job.kind));
      if (i < 0) break;
      void this.start(this.queue.splice(i, 1)[0]!);
    }
  }

  private async start(item: QueueItem): Promise<void> {
    const { job, req, resolve, reject } = item;
    job.state = "running";
    this.active.set(job.id, job);
    this.running.set(job.kind, (this.running.get(job.kind) ?? 0) + 1);
    try {
      resolve(await this.exec(req.command, { timeoutSec: req.timeoutSec ?? 1800 }));
    } catch (e) {
      reject(e);
    } finally {
      this.active.delete(job.id);
      this.running.set(job.kind, (this.running.get(job.kind) ?? 1) - 1);
      this.pump();
    }
  }
}

/** Default executor: a resource-limited, time-bounded systemd-run --user scope. */
function systemdRunExec(memoryMax: string, cpuQuota: string): ExecFn {
  return (command, { timeoutSec }) =>
    new Promise<JobResult>((resolve) => {
      const args = [
        "--user", "--pipe", "--collect", "--quiet",
        "-p", `MemoryMax=${memoryMax}`,
        "-p", `CPUQuota=${cpuQuota}`,
        "-p", `RuntimeMaxSec=${timeoutSec}`,
        "/bin/sh", "-lc", command,
      ];
      const child = spawn("systemd-run", args, {
        env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH ?? ""}` },
      });
      let out = "";
      const CAP = 8000;
      const add = (b: Buffer) => {
        if (out.length < CAP) out += b.toString();
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, (timeoutSec + 10) * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, output: out.slice(0, CAP), timedOut });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, output: `spawn error: ${String(e)}`, timedOut });
      });
    });
}

/** In-process MCP tool so agents submit heavy jobs through the broker (not ad-hoc). */
export function makeBrokerServer(broker: Broker) {
  return createSdkMcpServer({
    name: "broker",
    version: "1.0.0",
    tools: [
      tool(
        "run_heavy",
        "Queue a heavy or long command (Unity, Blender, big builds) to run in a resource-limited sandbox via the broker, and wait for its output. Unity jobs are capped to 1 at a time. Prefer this over running such commands directly.",
        {
          command: z.string().describe("Shell command to run"),
          kind: z.string().optional().describe("Job kind for concurrency caps, e.g. 'unity' or 'blender'"),
          timeoutSec: z.number().optional().describe("Max run time in seconds (default 1800)"),
        },
        async (a) => {
          const r = await broker.submit({ command: a.command, kind: a.kind, timeoutSec: a.timeoutSec });
          return {
            content: [{ type: "text" as const, text: `exit=${r.exitCode}${r.timedOut ? " (timeout)" : ""}\n${r.output || "(no output)"}` }],
          };
        },
      ),
    ],
  });
}
