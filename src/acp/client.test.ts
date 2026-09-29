/** Regression tests for session metadata captured from Kiro notifications
 *  (issue #1: context-usage % shown in the status panel). No process is spawned. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AcpClient } from "./client.js";

/** Feed a raw ACP notification through the client's router. */
function notify(acp: AcpClient, method: string, params: unknown): void {
  (acp as unknown as { routeNotification(m: string, p: unknown): void }).routeNotification(method, params);
}

describe("AcpClient _kiro.dev/metadata", () => {
  test("captures contextUsagePercentage per session", () => {
    const acp = new AcpClient({ kiroCliPath: "kiro-cli", workspace: ".", trustAllTools: true });
    notify(acp, "_kiro.dev/metadata", { sessionId: "s1", contextUsagePercentage: 42.4 });
    notify(acp, "_kiro.dev/metadata", { sessionId: "s2", contextUsagePercentage: 7 });
    assert.equal(acp.metadataFor("s1")?.contextUsagePercentage, 42.4);
    assert.equal(acp.metadataFor("s2")?.contextUsagePercentage, 7);
  });

  test("a partial update keeps the last known context usage", () => {
    const acp = new AcpClient({ kiroCliPath: "kiro-cli", workspace: ".", trustAllTools: true });
    notify(acp, "_kiro.dev/metadata", { sessionId: "s1", contextUsagePercentage: 61 });
    notify(acp, "_kiro.dev/metadata", { sessionId: "s1", effort: "high" });
    assert.deepEqual(acp.metadataFor("s1"), { contextUsagePercentage: 61, effort: "high", credits: undefined });
  });

  test("ignores metadata without a session and unknown sessions", () => {
    const acp = new AcpClient({ kiroCliPath: "kiro-cli", workspace: ".", trustAllTools: true });
    notify(acp, "_kiro.dev/metadata", { contextUsagePercentage: 99 });
    assert.equal(acp.metadataFor(undefined), undefined);
    assert.equal(acp.metadataFor("nope"), undefined);
  });
});
