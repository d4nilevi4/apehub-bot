import { expect, test } from "bun:test";
import { weeekRequest } from "../src/weeek";

function fakeFetch(res: { ok: boolean; status: number; body: string }, spy?: (url: string, opts: any) => void) {
  return (async (url: string, opts: any) => {
    spy?.(url, opts);
    return { ok: res.ok, status: res.status, text: async () => res.body };
  }) as unknown as typeof fetch;
}

test("weeekRequest sends Bearer auth to the right URL and parses JSON", async () => {
  let seen: { url: string; opts: any } | undefined;
  const j = await weeekRequest(
    "https://api.weeek.net/public/v1",
    "tok",
    "GET",
    "/tm/projects",
    undefined,
    fakeFetch({ ok: true, status: 200, body: JSON.stringify({ projects: [{ id: 1 }] }) }, (url, opts) => (seen = { url, opts })),
  );
  expect(j.projects[0].id).toBe(1);
  expect(seen!.url).toBe("https://api.weeek.net/public/v1/tm/projects");
  expect(seen!.opts.headers.Authorization).toBe("Bearer tok");
});

test("weeekRequest throws with the API error body on non-2xx", async () => {
  await expect(
    weeekRequest("b", "tok", "GET", "/tm/tasks", undefined, fakeFetch({ ok: false, status: 401, body: '{"message":"unauthorized"}' })),
  ).rejects.toThrow("Weeek 401");
});

test("weeekRequest serializes a POST body", async () => {
  let sentBody: string | undefined;
  await weeekRequest("b", "tok", "POST", "/tm/tasks", { title: "x" }, fakeFetch({ ok: true, status: 200, body: "{}" }, (_u, o) => (sentBody = o.body)));
  expect(JSON.parse(sentBody!).title).toBe("x");
});
