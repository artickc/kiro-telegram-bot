/**
 * Kiro authentication control for /reauth: `kiro-cli logout` then an interactive
 * `kiro-cli login --use-device-flow`. The device flow prints a verification URL
 * + code to stdout (no browser redirect on the bot host), which we stream back
 * to Telegram so the user can complete it on their own device.
 */
import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { findImportableToken, installToken } from "./kiro-credentials.js";

const run = promisify(execFile);
const log = createLogger("auth");

// Strip ANSI colour/cursor escapes so the Telegram transcript stays readable.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface LoginResult {
  ok: boolean;
  code: number | null;
  /** True when the login was aborted via the supplied AbortSignal. */
  cancelled?: boolean;
  /** Human-readable failure reason, when known (shown in the chat). */
  error?: string;
}

export interface LoginOptions {
  /** Extra CLI flags (e.g. `--license pro`). `--use-device-flow` is added if absent. */
  extraArgs?: string[];
  /** Receives decoded stdout/stderr chunks as they arrive. */
  onOutput: (text: string) => void;
  /** Overall timeout before the login process is killed (default 5 min). */
  timeoutMs?: number;
  /** Abort to cancel the in-flight login — kills the process (Cancel button). */
  signal?: AbortSignal;
}

export interface IdcLoginOptions {
  /** IAM Identity Center start URL (e.g. https://my-org.awsapps.com/start). */
  startUrl: string;
  /** AWS region of the Identity Center (e.g. us-east-1). */
  region: string;
  /** Receives decoded output chunks as they arrive. */
  onOutput: (text: string) => void;
  /** Overall timeout before the login process is killed (default 5 min). */
  timeoutMs?: number;
  /** Abort to cancel the in-flight login — kills the process (Cancel button). */
  signal?: AbortSignal;
}

/** Minimal shape of the optional `node-pty` module we rely on. */
interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): IPty;
}

export class AuthService {
  constructor(private readonly kiroCliPath: string) {}

  /** Run `kiro-cli logout` (non-interactive). */
  async logout(): Promise<{ ok: boolean; out: string }> {
    try {
      const { stdout, stderr } = await run(this.kiroCliPath, ["logout"], {
        timeout: 30_000,
        encoding: "utf-8",
      });
      return { ok: true, out: clean(`${stdout}${stderr}`) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const out = clean(`${err.stdout ?? ""}${err.stderr ?? ""}`) || err.message || "logout failed";
      return { ok: false, out };
    }
  }

  /**
   * Best-effort removal of Kiro's cached auth token (`~/.aws/sso/cache/
   * kiro-auth-token.json`) — the file that carries the logged-in identity
   * (accessToken + refreshToken). Removing it after `logout` guarantees the
   * next `login` performs a genuine device-flow authentication instead of
   * silently reusing the previous account's cached/refreshable token.
   *
   * Surgical and safe: it touches ONLY Kiro's own token file, never the shared,
   * account-agnostic OIDC client registrations, and is a no-op if absent.
   */
  async clearTokenCache(): Promise<boolean> {
    const path = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");
    try {
      await rm(path, { force: true });
      log.info(`cleared cached auth token (${path})`);
      return true;
    } catch (e) {
      log.debug("clearTokenCache failed:", (e as Error).message);
      return false;
    }
  }

  /**
   * Import an existing Kiro login from this machine (the Kiro IDE / a previous
   * CLI login share the same AWS SSO device-token cache). Finds the freshest
   * usable token and copies it into the live cache path so `kiro-cli` is logged
   * in as that identity — no device flow needed. Returns `ok:false` with a hint
   * when no valid login is found (the user must sign in via Kiro IDE first).
   */
  async importFromKiro(): Promise<{ ok: boolean; error?: string }> {
    const found = await findImportableToken();
    if (!found) {
      return {
        ok: false,
        error:
          "No Kiro login found on this PC. Sign in with Kiro IDE (or run `kiro-cli login`) on this machine first, then try Import again.",
      };
    }
    try {
      await installToken(found.path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * to `onOutput` as it arrives (so the device code/URL reaches the user fast).
   * Resolves when the process exits, the timeout fires, or the signal aborts.
   */
  login(opts: LoginOptions): Promise<LoginResult> {
    const { extraArgs = [], onOutput, timeoutMs = 300_000, signal } = opts;
    return new Promise<LoginResult>((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, code: null, cancelled: true });
        return;
      }
      const args = ["login"];
      if (!extraArgs.includes("--use-device-flow")) args.push("--use-device-flow");
      args.push(...extraArgs);
      log.info(`spawning login: ${this.kiroCliPath} ${args.join(" ")}`);

      let proc;
      try {
        // stdin ignored: any interactive prompt gets EOF rather than hanging.
        proc = spawn(this.kiroCliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        onOutput(`error: ${(e as Error).message}`);
        resolve({ ok: false, code: null });
        return;
      }

      let cancelled = false;
      let settled = false;
      let hardKill: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        cancelled = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        // Escalate if the CLI ignores the polite signal.
        hardKill = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000);
      };

      const finish = (r: LoginResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };

      const feed = (b: Buffer): void => {
        const t = clean(b.toString("utf-8"));
        if (t) onOutput(t);
      };
      proc.stdout.on("data", feed);
      proc.stderr.on("data", feed);

      const timer = setTimeout(() => {
        onOutput("\n\u23F1\uFE0F Timed out waiting for login to complete.");
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });

      proc.on("error", (e: Error) => {
        onOutput(`error: ${e.message}`);
        finish({ ok: false, code: null, cancelled });
      });
      proc.on("exit", (code: number | null) => {
        finish({ ok: code === 0 && !cancelled, code, cancelled });
      });
    });
  }

  /**
   * IAM Identity Center (Pro) login. Unlike the Builder ID device flow, this
   * CLI path is *interactive*: it always prompts ("Enter Start URL", "Enter
   * Region", and — when the account has several — an Identity Center profile
   * picker) and refuses to run without a real terminal. So we drive it inside a
   * pseudo-terminal (the optional `node-pty` module), answering each prompt with
   * the start URL / region the user supplied and accepting the default profile.
   * The device verification URL + code still stream out via `onOutput`.
   */
  loginIdc(opts: IdcLoginOptions): Promise<LoginResult> {
    const { startUrl, region, onOutput, timeoutMs = 300_000, signal } = opts;
    return new Promise<LoginResult>((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, code: null, cancelled: true });
        return;
      }
      void (async () => {
        // Load the optional native PTY lazily via a variable specifier so a
        // missing module is a graceful runtime error, not an install/type break.
        let pty: PtyModule;
        try {
          const specifier = "@homebridge/node-pty-prebuilt-multiarch";
          const mod = (await import(specifier)) as unknown as PtyModule & { default?: PtyModule };
          pty = typeof mod.spawn === "function" ? mod : (mod.default as PtyModule);
          if (!pty || typeof pty.spawn !== "function") throw new Error("invalid pty module");
        } catch {
          resolve({
            ok: false,
            code: null,
            error:
              "IAM Identity Center login needs the PTY module. Run `npm install` in the bot folder, then try again.",
          });
          return;
        }

        // Pass the start URL + region as flags so the interactive prompts come
        // PREFILLED — we then just press Enter to accept them. Typing the values
        // ourselves makes the terminal echo them, which doubles the captured
        // input (e.g. "us-east-1us-east-1" → bad OIDC endpoint). Q_FAKE_IS_REMOTE
        // forces the CLI to PRINT the verification URL instead of opening a
        // browser on the bot host, so it streams to Telegram.
        const args = [
          "login",
          "--license",
          "pro",
          "--identity-provider",
          startUrl,
          "--region",
          region,
          "--use-device-flow",
        ];
        log.info(`spawning IDC login (pty): ${this.kiroCliPath} ${args.join(" ")}`);

        let term: IPty;
        try {
          term = pty.spawn(this.kiroCliPath, args, {
            name: "xterm-color",
            cols: 120,
            rows: 30,
            env: { ...process.env, Q_FAKE_IS_REMOTE: "1" },
          });
        } catch (e) {
          resolve({ ok: false, code: null, error: (e as Error).message });
          return;
        }

        let buf = "";
        let sentUrl = false;
        let sentRegion = false;
        let sentProfile = false;
        let cancelled = false;
        let settled = false;

        const onAbort = (): void => {
          cancelled = true;
          try {
            term.kill();
          } catch {
            /* ignore */
          }
        };

        const finish = (r: LoginResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          try {
            term.kill();
          } catch {
            /* ignore */
          }
          resolve(r);
        };

        const timer = setTimeout(() => {
          onOutput("\n\u23F1\uFE0F Timed out waiting for login to complete.");
          try {
            term.kill();
          } catch {
            /* ignore */
          }
        }, timeoutMs);

        signal?.addEventListener("abort", onAbort, { once: true });

        term.onData((d: string) => {
          const t = clean(d);
          if (t) onOutput(t);
          buf += t;
          // Each prompt is PREFILLED (from the flags); just press Enter to accept
          // it. We answer each exactly once, in order.
          if (!sentUrl && /start url/i.test(buf)) {
            sentUrl = true;
            term.write("\r");
          } else if (sentUrl && !sentRegion && /enter region/i.test(buf)) {
            sentRegion = true;
            term.write("\r");
          } else if (sentRegion && !sentProfile && /select an iam identity center profile/i.test(buf)) {
            sentProfile = true;
            term.write("\r"); // accept the default (first) profile
          }
        });

        term.onExit(({ exitCode }) => finish({ ok: exitCode === 0 && !cancelled, code: exitCode, cancelled }));
      })();
    });
  }
}

function clean(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}
