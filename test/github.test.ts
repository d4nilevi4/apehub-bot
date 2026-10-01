import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { GithubLogin, interpretTokenResponse, pollToken, requestDeviceCode } from "../src/github";
import { CredStore } from "../src/login";

test("interpretTokenResponse maps the poll states", () => {
  expect(interpretTokenResponse({ access_token: "ghu_x" })).toEqual({ status: "ok", token: "ghu_x" });
  expect(interpretTokenResponse({ error: "authorization_pending" }).status).toBe("pending");
  expect(interpretTokenResponse({ error: "slow_down" }).status).toBe("slow_down");
  expect(interpretTokenResponse({ error: "access_denied", error_description: "no" })).toEqual({
    status: "error",
    message: "no",
  });
});

test("requestDeviceCode parses the device/code response", async () => {
  const fakeFetch = (async () => ({
    json: async () => ({
      device_code: "dc",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 5,
      expires_in: 900,
    }),
  })) as unknown as typeof fetch;
  const dc = await requestDeviceCode("cid", "repo", fakeFetch);
  expect(dc).toMatchObject({ deviceCode: "dc", userCode: "ABCD-1234", interval: 5 });
});

test("pollToken polls through 'pending' then returns the token", async () => {
  let n = 0;
  const fakeFetch = (async () => ({
    json: async () => (n++ === 0 ? { error: "authorization_pending" } : { access_token: "ghu_ok" }),
  })) as unknown as typeof fetch;
  const token = await pollToken("cid", { deviceCode: "dc", interval: 0, expiresIn: 60 }, fakeFetch, async () => {});
  expect(token).toBe("ghu_ok");
});

test("GithubLogin.start explains when unconfigured", async () => {
  const store = new CredStore(mkdtempSync(join(tmpdir(), "gh-")));
  const gh = new GithubLogin(undefined, "repo", store, () => {});
  expect(await gh.start(0)).toContain("не настроен");
});

test("GithubLogin.start returns code+URL and stores the token in the background", async () => {
  const store = new CredStore(mkdtempSync(join(tmpdir(), "gh-")));
  const notes: string[] = [];
  const gh = new GithubLogin("cid", "repo", store, (_t, m) => notes.push(m), {
    requestDeviceCode: async () => ({
      deviceCode: "dc",
      userCode: "WXYZ-9999",
      verificationUri: "https://github.com/login/device",
      interval: 0,
      expiresIn: 60,
    }),
    pollToken: async () => "ghu_token",
    fetchGithubUser: async () => ({ login: "octocat", email: "octo@x" }),
  });
  const msg = await gh.start(5);
  expect(msg).toContain("WXYZ-9999");
  expect(msg).toContain("github.com/login/device");
  await new Promise((r) => setTimeout(r, 10)); // let the background poll finish
  expect(store.getGithubUser()?.login).toBe("octocat");
  expect(notes.some((m) => m.includes("octocat"))).toBe(true);
});
