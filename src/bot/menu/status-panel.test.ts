/** Regression tests for the pinned status panel text (issue #1: context %). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api } from "grammy";
import { StatusPanel } from "./status-panel.js";

function panelFor(ctx: number | undefined, extra: Record<string, unknown> = {}): StatusPanel {
  const rt = {
    projectName: "demo",
    cwd: "/work/demo",
    sessionId: "abcdef1234567890",
    contextInfo: () => (ctx === undefined ? undefined : { contextUsagePercentage: ctx }),
    isBusy: true,
    queueLength: 0,
    isWatching: false,
    taskProgress: undefined,
    ...extra,
  };
  const registry = {
    get: () => rt,
    controller: () => ({ count: () => 1 }),
    subagentSummaryForChat: () => undefined,
  };
  const settings = { get: () => ({ agent: "dev", model: "claude-sonnet", reasoning: "high" }) };
  return new StatusPanel({} as Api, settings as never, registry as never);
}

describe("StatusPanel.render", () => {
  test("shows the session's context usage (rounded) next to project and session", () => {
    const text = panelFor(42.6).render(1);
    assert.match(text, /^\u{1F4C1} demo \| \u{1F9F5} abcdef12 \| \u{1F4CA} 43% context$/mu);
    assert.match(text, /^\u{1F916} dev \| \u{1F9E0} High \| \u{1F9E9} claude-sonnet$/mu);
  });

  test("omits the context field until Kiro has reported it", () => {
    const text = panelFor(undefined).render(1);
    assert.match(text, /^\u{1F4C1} demo \| \u{1F9F5} abcdef12$/mu);
    assert.doesNotMatch(text, /context/);
  });

  test("leads with the live progress bar and activity", () => {
    const lines = panelFor(10, { taskProgress: 50, queueLength: 2 }).render(1).split("\n");
    assert.match(lines[0] ?? "", /50%$/);
    assert.equal(lines[1], "\u23F3 Working | \u{1F4E5} 2 queued");
  });
});
