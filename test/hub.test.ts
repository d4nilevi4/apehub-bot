import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { listHubPlugins, listHubSkills } from "../src/hub";

/** A temp hub: two plugins, one skill each. */
function makeHub(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-"));
  const gdd = join(dir, "plugins", "gamedesign", "skills", "gdd");
  mkdirSync(gdd, { recursive: true });
  writeFileSync(join(gdd, "SKILL.md"), "---\nname: gdd\ndescription: Write a GDD\n---\n\nbody");
  const spec = join(dir, "plugins", "docs", "skills", "spec");
  mkdirSync(spec, { recursive: true });
  writeFileSync(join(spec, "SKILL.md"), '---\nname: spec\ndescription: "Write a spec"\n---\n');
  return dir;
}

test("listHubPlugins returns a local plugin per plugin dir", () => {
  const plugins = listHubPlugins(makeHub());
  expect(plugins.map((p) => p.path.split("/").pop())).toEqual(["docs", "gamedesign"]);
  expect(plugins.every((p) => p.type === "local")).toBe(true);
});

test("listHubSkills parses name + description from frontmatter", () => {
  expect(listHubSkills(makeHub())).toEqual([
    { plugin: "docs", name: "spec", description: "Write a spec" },
    { plugin: "gamedesign", name: "gdd", description: "Write a GDD" },
  ]);
});

test("a missing hub yields empty lists", () => {
  expect(listHubPlugins("/no/such/hub")).toEqual([]);
  expect(listHubSkills("/no/such/hub")).toEqual([]);
});
