/** Types for discovered Kiro CLI sessions on disk. */

export interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  /** PID holding the .lock file, if any. */
  lockPid?: number;
  /** True when lockPid refers to a live process => running on this PC. */
  active: boolean;
  /** Size of the .jsonl history in bytes (proxy for conversation length). */
  historyBytes: number;
}

export type HistoryRole = "user" | "assistant" | "tool" | "system";

export interface HistoryEntry {
  role: HistoryRole;
  text: string;
  /** Optional tool name for tool entries. */
  tool?: string;
  timestamp?: number;
}

/** One ordered piece of a transcript turn: prose, or a tool the agent invoked. */
export type TranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; /** One-line summary of the tool input. */ preview?: string };

/** A conversation turn in a full session transcript (used by /export). Every
 *  consecutive agent message between two user prompts folds into ONE turn. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  parts: TranscriptPart[];
  /** Epoch ms, when the log recorded one (Kiro stamps user prompts). */
  timestamp?: number;
}
