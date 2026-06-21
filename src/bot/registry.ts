/**
 * Tracks one ChatController per Telegram chat (each controlling one or more
 * sessions). `get(chatId)` returns the chat's foreground SessionRuntime so the
 * existing handlers keep operating on "the current session".
 *
 * It also owns **subagent attribution**: Kiro reports a single, process-global
 * subagent list (with no parent session id on the wire), so we attribute new
 * subagents to the chat whose turn is currently running (most-recent first).
 * That mapping drives both subagent *visibility* (routed to the owner's
 * foreground runtime) and *permission* routing (a subagent's permission request
 * is asked of its parent chat).
 */
import type { Api } from "grammy";
import type { AcpClient } from "../acp/client.js";
import type { PendingStage, SubagentInfo } from "../acp/types.js";
import type { SettingsStore } from "../app/settings-store.js";
import type { AppConfig } from "../config.js";
import { subagentSummary } from "../render/subagent.js";
import type { SessionStore } from "../sessions/store.js";
import { ChatController } from "./chat-controller.js";
import type { SessionRuntime } from "./session-runtime.js";

export interface SessionDescription {
  /** Chat that owns the session (controlled session or subagent parent). */
  chatId?: number;
  /** True when this is a session the chat directly controls. */
  controlled: boolean;
  /** True when this is a subagent of a controlled turn. */
  subagent: boolean;
  projectName?: string;
  subagentName?: string;
}

export class RuntimeRegistry {
  private readonly controllers = new Map<number, ChatController>();
  private refresher: ((chatId: number) => void) | undefined;
  /** Chat ids with a running turn, most-recently-started last. */
  private readonly activeChats: number[] = [];
  /** Subagent sessionId -> owner chat id. */
  private readonly subagentParents = new Map<string, number>();

  constructor(
    private readonly api: Api,
    private readonly acp: AcpClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    private readonly store: SessionStore,
  ) {
    this.acp.on("subagents", (subagents, pending) => this.onSubagents(subagents, pending));
  }

  setRefresher(fn: (chatId: number) => void): void {
    this.refresher = fn;
  }

  controller(chatId: number): ChatController {
    let c = this.controllers.get(chatId);
    if (!c) {
      c = new ChatController(
        this.api,
        chatId,
        this.acp,
        this.cfg,
        this.settings,
        this.store,
        (id) => this.refresher?.(id),
        (busy) => this.noteActivity(chatId, busy),
      );
      this.controllers.set(chatId, c);
    }
    return c;
  }

  /** The chat's foreground runtime (backward-compatible with existing handlers). */
  get(chatId: number): SessionRuntime {
    return this.controller(chatId).foreground();
  }

  disposeAll(): void {
    for (const c of this.controllers.values()) c.dispose();
    this.controllers.clear();
  }

  /** Find the chat that currently controls a given session id. */
  findChatBySession(sessionId: string): number | undefined {
    for (const [chatId, c] of this.controllers) {
      if (c.findBySession(sessionId)) return chatId;
    }
    return undefined;
  }

  isControlledSession(sessionId: string): boolean {
    return this.findChatBySession(sessionId) !== undefined;
  }

  /**
   * The chat a session belongs to for permission/routing purposes: a directly
   * controlled session, otherwise the parent chat of a subagent.
   */
  ownerChatForSession(sessionId: string): number | undefined {
    return this.findChatBySession(sessionId) ?? this.subagentParents.get(sessionId);
  }

  /** Describe a session so a permission prompt can label it correctly. */
  describeSession(sessionId: string): SessionDescription {
    const controlledChat = this.findChatBySession(sessionId);
    if (controlledChat !== undefined) {
      const project = this.controller(controlledChat)
        .list()
        .find((s) => s.sessionId === sessionId)?.projectName;
      return { chatId: controlledChat, controlled: true, subagent: false, projectName: project };
    }
    const parent = this.subagentParents.get(sessionId);
    const info = this.acp.subagentById(sessionId);
    if (parent !== undefined || info) {
      return {
        chatId: parent,
        controlled: false,
        subagent: true,
        subagentName: info?.sessionName || info?.agentName || sessionId.slice(0, 8),
      };
    }
    return { controlled: false, subagent: false };
  }

  /** Subagent summary line for a chat's status panel, or undefined. */
  subagentSummaryForChat(chatId: number): string | undefined {
    const mine = this.acp.currentSubagents().filter((s) => this.subagentParents.get(s.sessionId) === chatId);
    if (mine.length === 0) return undefined;
    return subagentSummary(mine, this.acp.currentPendingStages());
  }

  // ── subagent attribution ─────────────────────────────────────────────────

  private noteActivity(chatId: number, busy: boolean): void {
    const i = this.activeChats.indexOf(chatId);
    if (i !== -1) this.activeChats.splice(i, 1);
    if (busy) this.activeChats.push(chatId);
  }

  /** The chat most likely to own freshly-spawned subagents. */
  private currentOwner(): number | undefined {
    return this.activeChats.at(-1);
  }

  private onSubagents(subagents: SubagentInfo[], pending: PendingStage[]): void {
    const owner = this.currentOwner();
    // Record parents for any subagent we haven't attributed yet.
    if (owner !== undefined) {
      for (const s of subagents) {
        if (!this.subagentParents.has(s.sessionId)) this.subagentParents.set(s.sessionId, owner);
      }
    }
    // Group by attributed chat and route visibility to each owner's foreground.
    const byChat = new Map<number, SubagentInfo[]>();
    for (const s of subagents) {
      const chatId = this.subagentParents.get(s.sessionId);
      if (chatId === undefined) continue;
      const arr = byChat.get(chatId);
      if (arr) arr.push(s);
      else byChat.set(chatId, [s]);
    }
    for (const [chatId, list] of byChat) {
      try {
        this.controller(chatId).foreground().renderSubagents(list, pending);
      } catch {
        /* non-fatal */
      }
      this.refresher?.(chatId);
    }
    // Prune mappings for subagents no longer present (they're terminated and
    // won't issue further permission requests) so the map stays bounded.
    const live = new Set(subagents.map((s) => s.sessionId));
    for (const sid of this.subagentParents.keys()) {
      if (!live.has(sid)) this.subagentParents.delete(sid);
    }
  }
}
