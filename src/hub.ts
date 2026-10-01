import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * The shared skills/plugins hub: a git clone of the team marketplace on the server
 * (config.hubDir, e.g. /opt/apehub-hub). Every session loads these plugins, so the
 * marketplace is available to every user's bot at once. Read-only here — updates land
 * via `git pull` out of band.
 */

export interface LocalPlugin {
  type: "local";
  path: string;
}

export interface HubSkill {
  plugin: string;
  name: string;
  description: string;
}

/** Plugin roots under <hubDir>/plugins, for the Agent SDK `plugins` option. */
export function listHubPlugins(hubDir: string): LocalPlugin[] {
  const base = `${hubDir}/plugins`;
  if (!existsSync(base)) return [];
  return dirs(base).map((name) => ({ type: "local" as const, path: `${base}/${name}` }));
}

/** Skills discovered in the hub, parsed from each SKILL.md frontmatter (for /skills). */
export function listHubSkills(hubDir: string): HubSkill[] {
  const base = `${hubDir}/plugins`;
  if (!existsSync(base)) return [];
  const out: HubSkill[] = [];
  for (const plugin of dirs(base)) {
    const skillsDir = `${base}/${plugin}/skills`;
    if (!existsSync(skillsDir)) continue;
    for (const skill of dirs(skillsDir)) {
      const md = `${skillsDir}/${skill}/SKILL.md`;
      if (!existsSync(md)) continue;
      const fm = parseFrontmatter(readFileSync(md, "utf8"));
      out.push({ plugin, name: fm.name || skill, description: fm.description || "" });
    }
  }
  return out;
}

function dirs(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Minimal frontmatter reader: just the `name` and `description` keys. */
function parseFrontmatter(src: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as "name" | "description"] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
