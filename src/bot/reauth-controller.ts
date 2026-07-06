/**
 * ReauthController — drives the whole `/reauth` flow on a SINGLE status message:
 * pick login method → logout → device-flow login → agent restart. Instead of
 * echoing every spinner frame the CLI emits, it shows one self-animated loader
 * line plus inline controls (a method picker up front, Cancel while running,
 * Retry / Restart agent on failure).
 *
 * Kiro CLI can authenticate several ways, so the user chooses first instead of
 * always defaulting to one provider:
 *   • Builder ID (free)            → `--license free`
 *   • Google / GitHub (social)     → `--license free --social <provider>`
 *   • IAM Identity Center (pro)    → `--license pro --identity-provider <url> --region <region>`
 * Every method runs through `--use-device-flow` so approval happens on the
 * user's own device (no browser redirect on the bot host).
 *
 * State is kept per chat so the button callbacks (which arrive on a separate
 * update) can cancel the in-flight login or re-run the flow on the same message.
 */
import { type Api, InlineKeyboard } from "grammy";
import type { AcpClient } from "../acp/client.js";
import { AuthService } from "../app/auth-service.js";
import { UNSUPPORTED_LOGIN_HELP } from "../app/kiro-credentials.js";
import type { AccountInfo } from "../app/usage.js";
import { createLogger } from "../logger.js";
import { parseDeviceFlow } from "../render/device-flow.js";

const log = createLogger("reauth");

/** A 7-segment bar we cycle ourselves — one line, throttled, "infinite" loader. */
const LOADER = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
const ANIM_MS = 2500;
const LOGIN_TIMEOUT_MS = 300_000;

/** Login methods exposed in the picker. */
export type LoginMethod = "builder" | "google" | "github" | "idc" | "import" | "org";

/** CLI flags for a chosen method (`--use-device-flow` is added by AuthService). */
function methodArgs(method: LoginMethod, idc?: { url: string; region: string }): string[] {
  switch (method) {
    case "builder":
      return ["--license", "free"];
    case "google":
      return ["--license", "free", "--social", "google"];
    case "github":
      return ["--license", "free", "--social", "github"];
    case "idc":
      return ["--license", "pro", "--identity-provider", idc!.url, "--region", idc!.region];
    case "import":
      return []; // no device flow — reuses the existing on-disk login
    case "org":
      return []; // guided: user runs `kiro-cli login` on the host, we verify
  }
}

const METHOD_LABEL: Record<LoginMethod, string> = {
  builder: "Builder ID",
  google: "Google",
  github: "GitHub",
  idc: "IAM Identity Center",
  import: "Import from Kiro IDE",
  org: "Your organization",
};

/** Pull a start URL + region out of the user's free-text IDC reply. */
function parseIdcInput(text: string): { url: string; region: string } | undefined {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const url = tokens.find((t) => /^https?:\/\//i.test(t));
  const region = tokens.find((t) => /^[a-z]{2}-[a-z]+-\d+$/i.test(t));
  if (!url || !region) return undefined;
  return { url, region };
}

type Phase =
  | "choosing"
  | "idc_input"
  | "manual_org"
  | "logout"
  | "login"
  | "restarting"
  | "done"
  | "failed_login"
  | "failed_restart"
  | "cancelled";
const ACTIVE: ReadonlySet<Phase> = new Set<Phase>(["logout", "login", "restarting"]);

/** Human label for the logged-in identity, for the success message. */
function accountLabel(a: AccountInfo | undefined): string | undefined {
  if (!a) return undefined;
  return a.email || a.startUrl || a.accountType;
}

interface ReauthSession {
  chatId: number;
  messageId: number;
  phase: Phase;
  extra: string[];
  abort?: AbortController;
  anim?: NodeJS.Timeout;
  frame: number;
  url?: string;
  code?: string;
  errorMsg?: string;
  accountLabel?: string;
  lastText?: string;
  /** Chosen login method, for the success message and IDC follow-up. */
  method?: LoginMethod;
  /** IAM Identity Center start URL + region (only set for the `idc` method). */
  idc?: { url: string; region: string };
}

export class ReauthController {
  private readonly auth: AuthService;
  private readonly sessions = new Map<number, ReauthSession>();

  constructor(
    private readonly api: Api,
    private readonly acp: AcpClient,
    kiroCliPath: string,
    /** Resolves the current account (kiro-cli whoami) to confirm the identity. */
    private readonly getAccount?: () => Promise<AccountInfo | undefined>,
    /** Confirms kiro-cli actually accepted the login (whoami != null). */
    private readonly verifyLogin?: () => Promise<boolean>,
  ) {
    this.auth = new AuthService(kiroCliPath);
  }

  /** True while a reauth flow is actively running for a chat. */
  isBusy(chatId: number): boolean {
    const s = this.sessions.get(chatId);
    return !!s && ACTIVE.has(s.phase);
  }

  /** True while ANY chat is mid-reauth. Logout/login and the restart all touch
   *  the single shared agent and global credentials, so only one may run. */
  private anyActive(): boolean {
    for (const s of this.sessions.values()) if (ACTIVE.has(s.phase)) return true;
    return false;
  }

  /** Show the login-method picker on a fresh (or reused) status message. */
  async chooseMethod(chatId: number, existingMessageId?: number): Promise<void> {
    if (this.isBusy(chatId)) return;
    let messageId = existingMessageId;
    if (messageId === undefined) {
      const m = await this.api.sendMessage(chatId, "\u{1F510} Re-authenticate Kiro\u2026").catch(() => undefined);
      if (!m) return;
      messageId = m.message_id;
    }
    const s: ReauthSession = { chatId, messageId, phase: "choosing", extra: [], frame: 0 };
    this.sessions.set(chatId, s);
    await this.render(s);
  }

  /** Handle a method choice from the picker. IDC needs a URL + region first. */
  async pickMethod(chatId: number, messageId: number, method: LoginMethod): Promise<void> {
    const s = this.sessions.get(chatId);
    if (!s || s.phase !== "choosing") return; // stale/expired picker
    s.messageId = messageId;
    s.method = method;
    if (method === "idc") {
      s.phase = "idc_input";
      s.errorMsg = undefined;
      s.lastText = undefined;
      await this.render(s);
      return;
    }
    if (method === "org") {
      // Organization sign-in runs through a browser (app.kiro.dev), which the
      // bot can't drive headlessly — guide the user to run it on the host, then
      // verify + restart. Works for any login they complete on the machine.
      s.phase = "manual_org";
      s.errorMsg = undefined;
      s.lastText = undefined;
      await this.render(s);
      return;
    }
    await this.begin(chatId, methodArgs(method), messageId, method);
  }

  /** True while showing the guided "run kiro-cli login on the host" screen. */
  awaitingManualOrg(chatId: number): boolean {
    return this.sessions.get(chatId)?.phase === "manual_org";
  }

  /**
   * "I've logged in" tap for the guided organization flow: verify kiro-cli now
   * has a usable login (whoami), then restart the agent to adopt it. Re-prompts
   * (without failing) when the login isn't there yet.
   */
  async checkManualLogin(chatId: number, messageId: number): Promise<void> {
    const s = this.sessions.get(chatId);
    if (!s || s.phase !== "manual_org") return;
    s.messageId = messageId;
    if (this.anyActive() || this.acp.hasInflightPrompt()) {
      s.errorMsg = "Kiro is busy right now \u2014 try again in a moment.";
      return void this.render(s);
    }
    const ok = this.verifyLogin ? await this.verifyLogin().catch(() => false) : true;
    if (!ok) {
      s.errorMsg = "kiro-cli still reports no login. Finish `kiro-cli login` on the host, then tap again.";
      return void this.render(s);
    }
    s.phase = "restarting";
    s.errorMsg = undefined;
    this.startAnim(s);
    await this.render(s);
    try {
      await this.acp.restart();
      s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
      s.phase = "done";
    } catch (e) {
      s.phase = "failed_restart";
      s.errorMsg = (e as Error).message;
    }
    this.stopAnim(s);
    await this.render(s);
  }

  /** True while waiting for the user to type their IDC start URL + region. */
  awaitingIdcInput(chatId: number): boolean {
    return this.sessions.get(chatId)?.phase === "idc_input";
  }

  /** Consume the IDC start URL + region text and kick off the login. */
  async submitIdcInput(chatId: number, text: string): Promise<void> {
    const s = this.sessions.get(chatId);
    if (!s || s.phase !== "idc_input") return;
    const parsed = parseIdcInput(text);
    if (!parsed) {
      s.errorMsg = "Couldn't read a start URL and region. Example: https://my-org.awsapps.com/start us-east-1";
      s.lastText = undefined;
      await this.render(s);
      return;
    }
    await this.begin(chatId, [], s.messageId, "idc", parsed);
  }

  /** Cancel an in-progress picker / IDC prompt (before any logout happened). */
  async cancelChoice(chatId: number, messageId: number): Promise<void> {
    const s = this.sessions.get(chatId);
    if (s && (s.phase === "choosing" || s.phase === "idc_input")) this.sessions.delete(chatId);
    await this.api.editMessageText(chatId, messageId, "\u{1F510} Re-authentication cancelled.").catch(() => {});
  }

  /** Start (or restart) the flow. Reuses `existingMessageId` for the Retry button. */
  async begin(
    chatId: number,
    extra: string[],
    existingMessageId?: number,
    method?: LoginMethod,
    idc?: { url: string; region: string },
  ): Promise<void> {
    if (this.isBusy(chatId)) return;
    if (this.anyActive()) {
      await this.api
        .sendMessage(chatId, "\u{1F510} A re-authentication is already in progress in another chat — try again shortly.")
        .catch(() => {});
      return;
    }
    if (this.acp.hasInflightPrompt()) {
      await this.api
        .sendMessage(chatId, "\u23F3 Kiro is busy running a turn — try /reauth when idle (or /cancel first).")
        .catch(() => {});
      return;
    }
    let messageId = existingMessageId;
    if (messageId === undefined) {
      const m = await this.api.sendMessage(chatId, "\u{1F510} Re-authenticating Kiro\u2026").catch(() => undefined);
      if (!m) return;
      messageId = m.message_id;
    }
    const s: ReauthSession = { chatId, messageId, phase: "logout", extra, frame: 0, method, idc };
    this.sessions.set(chatId, s);
    void this.run(s);
  }

  /** Abort the in-flight login/logout for a chat. Returns false if idle. */
  cancel(chatId: number): boolean {
    const s = this.sessions.get(chatId);
    if (!s || !ACTIVE.has(s.phase)) return false;
    s.abort?.abort();
    return true;
  }

  /** Re-run the whole flow on the existing status message (Retry button). */
  async retry(chatId: number, messageId: number): Promise<void> {
    const prev = this.sessions.get(chatId);
    await this.begin(chatId, prev?.extra ?? [], messageId, prev?.method, prev?.idc);
  }

  /** Just restart the agent again (Restart-agent button after a restart failure). */
  async restartAgent(chatId: number, messageId: number): Promise<void> {
    if (this.isBusy(chatId) || this.anyActive()) return;
    const s: ReauthSession = this.sessions.get(chatId) ?? { chatId, messageId, phase: "restarting", extra: [], frame: 0 };
    s.messageId = messageId;
    s.phase = "restarting";
    s.errorMsg = undefined;
    this.sessions.set(chatId, s);
    this.startAnim(s);
    await this.render(s);
    try {
      await this.acp.restart();
      s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
      s.phase = "done";
    } catch (e) {
      s.phase = "failed_restart";
      s.errorMsg = (e as Error).message;
    }
    this.stopAnim(s);
    await this.render(s);
  }

  // ── flow ───────────────────────────────────────────────────────────────────

  private async run(s: ReauthSession): Promise<void> {
    s.abort = new AbortController();
    s.accountLabel = undefined;
    // The ACP agent is shared; while it runs it keeps refreshing and rewriting
    // the cached token, which would silently restore the OLD identity right
    // after we log out. So we take it down FIRST and only bring it back once a
    // fresh login has written new credentials.
    let agentDown = false;
    try {
      // Import path: reuse the Kiro login already on this machine (Kiro IDE /
      // a prior CLI login share the SSO token cache). No logout, no device flow
      // — we must NOT clear the token cache here, that's the source we import.
      if (s.method === "import") {
        s.phase = "login";
        this.startAnim(s);
        await this.render(s);
        await this.acp.stopAndWait();
        agentDown = true;
        const res = await this.auth.importFromKiro();
        if (!res.ok) {
          s.phase = "failed_login";
          s.errorMsg = res.error ?? "No importable Kiro login found.";
          return;
        }
        s.phase = "restarting";
        await this.render(s);
        try {
          await this.acp.restart();
          agentDown = false;
          // Verify kiro-cli actually accepts the imported token — a Microsoft /
          // organization (external_idp) login copied from Kiro IDE decodes to an
          // email but kiro-cli refuses it ("not logged in"), so don't claim success.
          const ok = this.verifyLogin ? await this.verifyLogin().catch(() => false) : true;
          if (!ok) {
            s.phase = "failed_login";
            s.errorMsg = UNSUPPORTED_LOGIN_HELP;
            return;
          }
          s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
          s.phase = "done";
        } catch (e) {
          s.phase = "failed_restart";
          s.errorMsg = (e as Error).message;
        }
        return;
      }

      s.phase = "logout";
      this.startAnim(s);
      await this.render(s);

      await this.acp.stopAndWait(); // release the held session before logout
      agentDown = true;
      await this.auth.logout();
      await this.auth.clearTokenCache(); // ensure login can't reuse a cached token
      if (s.abort.signal.aborted) {
        s.phase = "cancelled";
        return;
      }

      s.phase = "login";
      s.url = undefined;
      s.code = undefined;
      await this.render(s);
      let raw = "";
      const onOutput = (t: string): void => {
        raw += t;
        this.ingest(s, raw);
      };
      const result =
        s.method === "idc" && s.idc
          ? await this.auth.loginIdc({
              startUrl: s.idc.url,
              region: s.idc.region,
              timeoutMs: LOGIN_TIMEOUT_MS,
              signal: s.abort.signal,
              onOutput,
            })
          : await this.auth.login({
              extraArgs: s.extra,
              timeoutMs: LOGIN_TIMEOUT_MS,
              signal: s.abort.signal,
              onOutput,
            });
      if (result.cancelled || s.abort.signal.aborted) {
        s.phase = "cancelled";
        return;
      }
      if (!result.ok) {
        s.phase = "failed_login";
        s.errorMsg = result.error ?? `Login did not complete (exit ${result.code ?? "?"}).`;
        return;
      }

      s.phase = "restarting";
      await this.render(s);
      try {
        await this.acp.restart(); // fresh agent picks up the new credentials
        agentDown = false;
        s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
        s.phase = "done";
      } catch (e) {
        s.phase = "failed_restart";
        s.errorMsg = (e as Error).message;
      }
    } catch (e) {
      log.warn("reauth flow failed:", (e as Error).message);
      s.phase = "failed_login";
      s.errorMsg = (e as Error).message;
    } finally {
      s.abort = undefined;
      this.stopAnim(s);
      // If we took the agent down but never brought it back (cancel / login
      // failure), restart it so the bot isn't left without a live agent. A
      // failed_restart already tried — leave its button instead.
      if (agentDown && (s.phase === "cancelled" || s.phase === "failed_login")) {
        await this.acp.restart().catch((e) => log.warn("post-reauth agent restart failed:", (e as Error).message));
      }
      await this.render(s);
    }
  }

  /** Pull stable URL/code out of the streaming output; re-render when they change. */
  private ingest(s: ReauthSession, raw: string): void {
    const p = parseDeviceFlow(raw);
    let changed = false;
    if (p.url && p.url !== s.url) {
      s.url = p.url;
      changed = true;
    }
    if (p.code && p.code !== s.code) {
      s.code = p.code;
      changed = true;
    }
    if (changed) void this.render(s);
  }

  private startAnim(s: ReauthSession): void {
    if (s.anim) return;
    s.anim = setInterval(() => {
      s.frame++;
      void this.render(s);
    }, ANIM_MS);
  }

  private stopAnim(s: ReauthSession): void {
    if (s.anim) {
      clearInterval(s.anim);
      s.anim = undefined;
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────────

  private text(s: ReauthSession): string {
    const loader = LOADER[s.frame % LOADER.length] ?? "";
    switch (s.phase) {
      case "choosing":
        return (
          "\u{1F510} Re-authenticate Kiro\nChoose how you want to log in:\n\n" +
          "\u{1F3E2} Company / Microsoft (Entra) account \u2192 \u201CYour organization\u201D.\n" +
          "\u{1F194} AWS IAM Identity Center (start URL) \u2192 its own button.\n" +
          "\u{1F193} Personal \u2192 Builder ID, Google or GitHub."
        );
      case "manual_org":
        return (
          "\u{1F3E2} Sign in with your organization\n\n" +
          "Organization sign-in opens in a browser, so run it on the machine hosting this bot:\n\n" +
          "1\uFE0F\u20E3 Open a terminal there.\n" +
          "2\uFE0F\u20E3 Run:  kiro-cli login\n" +
          "3\uFE0F\u20E3 Choose \u201CYour organization\u201D and finish signing in.\n\n" +
          "Then tap \u2705 below \u2014 I'll pick up the login and restart the agent." +
          (s.errorMsg ? `\n\n\u26A0\uFE0F ${s.errorMsg}` : "")
        );
      case "idc_input":
        return (
          "\u{1F3E2} AWS IAM Identity Center (Pro)\n\n" +
          "Send your start URL and Region in one message, separated by a space:\n" +
          "https://my-org.awsapps.com/start us-east-1\n\n" +
          "\u2139\uFE0F If your organization doesn't use AWS IAM Identity Center (no start URL), " +
          "go Back and choose \u201CImport from Kiro IDE\u201D instead." +
          (s.errorMsg ? `\n\n\u26A0\uFE0F ${s.errorMsg}` : "")
        );
      case "logout":
        return `\u{1F510} Re-authenticating Kiro\u2026\n\u{1F6AA} Logging out\u2026  ${loader}`;
      case "login": {
        if (s.method === "import") {
          const loaderI = LOADER[s.frame % LOADER.length] ?? "";
          return `\u{1F4E5} Importing your Kiro IDE login\u2026  ${loaderI}`;
        }
        const provider = s.method ? ` \u00B7 ${METHOD_LABEL[s.method]}` : "";
        const lines = [`\u{1F511} Kiro login (device flow)${provider}`, ""];
        if (s.url) lines.push(`\u{1F517} Open this link to approve:\n${s.url}`, "");
        if (s.code) lines.push(`\u{1F522} Verification code: ${s.code}`, "");
        if (!s.url && !s.code) lines.push("Starting device-flow login\u2026", "");
        else lines.push("Confirm it in the browser, then this updates automatically.", "");
        lines.push(`${loader} Waiting for approval\u2026`);
        return lines.join("\n");
      }
      case "restarting":
        return `\u2705 Logged in.\n\u{1F504} Restarting the Kiro agent\u2026  ${loader}`;
      case "done":
        return (
          `\u2705 Re-authenticated${s.accountLabel ? ` as ${s.accountLabel}` : ""} and agent restarted.\n` +
          "Your session re-binds on the next message." +
          (s.accountLabel ? "" : "\n(Tip: /usage shows the active account.)")
        );
      case "cancelled":
        return "\u{1F6D1} Login cancelled \u2014 you're logged out. Tap Retry, or Change method to pick another.";
      case "failed_login":
        return (
          `\u274C ${s.errorMsg ?? "Login failed."}\n` +
          "Tap Retry to try the same method again, or Change method to pick another."
        );
      case "failed_restart":
        return `\u26A0\uFE0F Logged in, but the agent restart failed: ${s.errorMsg ?? "unknown error"}.`;
      default:
        return "";
    }
  }

  private keyboard(s: ReauthSession): InlineKeyboard | undefined {
    switch (s.phase) {
      case "choosing":
        return new InlineKeyboard()
          .text("\u{1F3E2} Your organization", "reauth:method:org")
          .row()
          .text("\u{1F193} Builder ID (free)", "reauth:method:builder")
          .row()
          .text("\u{1F310} Google", "reauth:method:google")
          .text("\u{1F431} GitHub", "reauth:method:github")
          .row()
          .text("\u{1F194} IAM Identity Center", "reauth:method:idc")
          .text("\u{1F4E5} Import IDE", "reauth:method:import")
          .row()
          .text("\u274C Cancel", "reauth:choose-cancel");
      case "idc_input":
        return new InlineKeyboard()
          .text("\u2B05 Back", "reauth:choose-back")
          .text("\u274C Cancel", "reauth:choose-cancel");
      case "manual_org":
        return new InlineKeyboard()
          .text("\u2705 I've logged in \u2014 check", "reauth:org-check")
          .row()
          .text("\u2B05 Back", "reauth:choose-back")
          .text("\u274C Cancel", "reauth:choose-cancel");
      case "logout":
      case "login":
        return new InlineKeyboard().text("\u274C Cancel", "reauth:cancel");
      case "cancelled":
      case "failed_login":
        return new InlineKeyboard()
          .text("\u{1F501} Retry", "reauth:retry")
          .text("\u{1F504} Change method", "reauth:choose-back");
      case "failed_restart":
        return new InlineKeyboard()
          .text("\u{1F504} Restart agent", "reauth:restart")
          .text("\u{1F501} Retry login", "reauth:retry");
      default:
        return undefined;
    }
  }

  private async render(s: ReauthSession): Promise<void> {
    const text = this.text(s);
    if (text === s.lastText) return; // unchanged → skip ("message is not modified")
    s.lastText = text;
    await this.api
      .editMessageText(s.chatId, s.messageId, text, {
        reply_markup: this.keyboard(s),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {});
  }
}
