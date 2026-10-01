import { Database } from "bun:sqlite";
import type { EngineName } from "./config";

export type ProjectState = "idle" | "busy" | "archived";

export interface Project {
  topicId: number;
  name: string;
  engine: EngineName;
  cwd: string;
  sessionId: string | null;
  state: ProjectState;
  createdAt: number;
  updatedAt: number;
  /** Per-project model override (engine default when null). */
  model: string | null;
  /** Auto-compact (summarize + reseed) when the context window fills. */
  autocompact: boolean;
  /** Pending summary to prepend to the next message (set by compact). */
  seed: string | null;
  /** Actual model the engine reported on the last turn. */
  lastModel: string | null;
  /** Approx. context tokens occupied after the last turn (for /status, /context). */
  ctxUsed: number | null;
}

const COLUMNS: Record<string, string> = {
  model: "TEXT",
  autocompact: "INTEGER NOT NULL DEFAULT 1",
  seed: "TEXT",
  last_model: "TEXT",
  ctx_used: "INTEGER",
};

export class Db {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        topic_id   INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        engine     TEXT    NOT NULL,
        cwd        TEXT    NOT NULL,
        session_id TEXT,
        state      TEXT    NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model      TEXT,
        autocompact INTEGER NOT NULL DEFAULT 1,
        seed       TEXT,
        last_model TEXT,
        ctx_used   INTEGER
      );
    `);
    this.migrate();
  }

  /** Add any columns missing from an older DB (idempotent). */
  private migrate(): void {
    const have = new Set(
      (this.db.query(`PRAGMA table_info(projects)`).all() as { name: string }[]).map((r) => r.name),
    );
    for (const [col, def] of Object.entries(COLUMNS)) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${col} ${def}`);
    }
  }

  upsertProject(p: Project): void {
    this.db
      .query(
        `INSERT INTO projects (topic_id, name, engine, cwd, session_id, state, created_at, updated_at, model, autocompact, seed, last_model, ctx_used)
         VALUES ($t, $n, $e, $c, $s, $st, $ca, $ua, $m, $ac, $sd, $lm, $cu)
         ON CONFLICT(topic_id) DO UPDATE SET
           name=$n, engine=$e, cwd=$c, session_id=$s, state=$st, updated_at=$ua,
           model=$m, autocompact=$ac, seed=$sd, last_model=$lm, ctx_used=$cu`,
      )
      .run({
        $t: p.topicId, $n: p.name, $e: p.engine, $c: p.cwd, $s: p.sessionId,
        $st: p.state, $ca: p.createdAt, $ua: p.updatedAt, $m: p.model,
        $ac: p.autocompact ? 1 : 0, $sd: p.seed, $lm: p.lastModel, $cu: p.ctxUsed,
      });
  }

  getProject(topicId: number): Project | null {
    const r = this.db.query(`SELECT * FROM projects WHERE topic_id = $t`).get({ $t: topicId });
    return r ? rowToProject(r) : null;
  }

  listProjects(): Project[] {
    return (this.db.query(`SELECT * FROM projects ORDER BY updated_at DESC`).all() as unknown[]).map(
      rowToProject,
    );
  }

  private set(topicId: number, col: string, value: unknown): void {
    this.db
      .query(`UPDATE projects SET ${col} = $v, updated_at = $u WHERE topic_id = $t`)
      .run({ $v: value as never, $u: Date.now(), $t: topicId });
  }

  setSession(topicId: number, sessionId: string | null): void {
    this.set(topicId, "session_id", sessionId);
  }
  setState(topicId: number, state: ProjectState): void {
    this.set(topicId, "state", state);
  }
  setModel(topicId: number, model: string | null): void {
    this.set(topicId, "model", model);
  }
  setEngine(topicId: number, engine: EngineName): void {
    this.set(topicId, "engine", engine);
  }
  setAutocompact(topicId: number, on: boolean): void {
    this.set(topicId, "autocompact", on ? 1 : 0);
  }
  setSeed(topicId: number, seed: string | null): void {
    this.set(topicId, "seed", seed);
  }
  /** Record the model + context occupancy the engine reported for the last turn. */
  setUsage(topicId: number, lastModel: string | null, ctxUsed: number | null): void {
    this.db
      .query(`UPDATE projects SET last_model = $lm, ctx_used = $cu, updated_at = $u WHERE topic_id = $t`)
      .run({ $lm: lastModel, $cu: ctxUsed, $u: Date.now(), $t: topicId });
  }

  close(): void {
    this.db.close();
  }
}

function rowToProject(r: unknown): Project {
  const o = r as Record<string, unknown>;
  return {
    topicId: Number(o.topic_id),
    name: String(o.name),
    engine: String(o.engine) as EngineName,
    cwd: String(o.cwd),
    sessionId: (o.session_id as string | null) ?? null,
    state: String(o.state) as ProjectState,
    createdAt: Number(o.created_at),
    updatedAt: Number(o.updated_at),
    model: (o.model as string | null) ?? null,
    autocompact: Number(o.autocompact ?? 1) !== 0,
    seed: (o.seed as string | null) ?? null,
    lastModel: (o.last_model as string | null) ?? null,
    ctxUsed: o.ctx_used == null ? null : Number(o.ctx_used),
  };
}
