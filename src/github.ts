import type { CredStore } from "./login";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

type FetchFn = typeof fetch;

export async function requestDeviceCode(clientId: string, scope: string, fetchFn: FetchFn = fetch): Promise<DeviceCode> {
  const res = await fetchFn("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  const j = (await res.json()) as Record<string, any>;
  if (!j.device_code) throw new Error(j.error_description || j.error || "device code request failed");
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    interval: j.interval ?? 5,
    expiresIn: j.expires_in ?? 900,
  };
}

export type TokenPoll =
  | { status: "ok"; token: string }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "error"; message: string };

/** Pure interpreter of a GitHub access_token poll response (exported for tests). */
export function interpretTokenResponse(j: Record<string, any>): TokenPoll {
  if (j.access_token) return { status: "ok", token: String(j.access_token) };
  switch (j.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    default:
      return { status: "error", message: j.error_description || j.error || "unknown error" };
  }
}

export async function pollToken(
  clientId: string,
  dc: Pick<DeviceCode, "deviceCode" | "interval" | "expiresIn">,
  fetchFn: FetchFn = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  let interval = dc.interval;
  const deadline = Date.now() + dc.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: dc.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const r = interpretTokenResponse((await res.json()) as Record<string, any>);
    if (r.status === "ok") return r.token;
    if (r.status === "error") throw new Error(r.message);
    if (r.status === "slow_down") interval += 5;
  }
  throw new Error("код истёк — начни вход заново");
}

export async function fetchGithubUser(token: string, fetchFn: FetchFn = fetch): Promise<{ login: string; email: string }> {
  const res = await fetchFn("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "apehub-bot" },
  });
  const j = (await res.json()) as Record<string, any>;
  const login = j.login || "user";
  return { login, email: j.email || `${login}@users.noreply.github.com` };
}

export interface GithubFlowDeps {
  requestDeviceCode: typeof requestDeviceCode;
  pollToken: typeof pollToken;
  fetchGithubUser: typeof fetchGithubUser;
}

/**
 * GitHub login via OAuth device flow, driven from Telegram: start() returns the
 * code + URL to show the user, then polls in the background and stores the token
 * per-user (in the gateway's CredStore) when the user authorizes in a browser.
 */
export class GithubLogin {
  private pending = new Set<number>();

  constructor(
    private clientId: string | undefined,
    private scope: string,
    private store: CredStore,
    private notify: (topicId: number, text: string) => void,
    private deps: GithubFlowDeps = { requestDeviceCode, pollToken, fetchGithubUser },
  ) {}

  async start(topicId: number): Promise<string> {
    if (!this.clientId) {
      return "GitHub-вход не настроен администратором (нет OAuth App / GITHUB_CLIENT_ID).";
    }
    if (this.pending.has(topicId)) return "Вход в GitHub уже идёт — заверши его в браузере или подожди.";
    let dc: DeviceCode;
    try {
      dc = await this.deps.requestDeviceCode(this.clientId, this.scope);
    } catch (e) {
      return `⚠️ Не смог начать вход в GitHub: ${String((e as Error).message)}`;
    }
    this.pending.add(topicId);
    void this.run(topicId, dc);
    return `🔐 *GitHub-вход*\n1. Открой ${dc.verificationUri}\n2. Введи код: \`${dc.userCode}\`\n\nЖду авторизацию (до ${Math.round(dc.expiresIn / 60)} мин)…`;
  }

  private async run(topicId: number, dc: DeviceCode): Promise<void> {
    try {
      const token = await this.deps.pollToken(this.clientId!, dc);
      this.store.setGithub(token);
      const user = await this.deps.fetchGithubUser(token);
      this.store.setGithubUser(user);
      this.notify(topicId, `✅ GitHub подключён как *${user.login}*. Коммиты пойдут от твоего имени.`);
    } catch (e) {
      this.notify(topicId, `⚠️ GitHub-вход не завершён: ${String((e as Error).message)}`);
    } finally {
      this.pending.delete(topicId);
    }
  }
}
