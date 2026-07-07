import { describe, expect, test } from "bun:test"
import { JudgeService } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { OrbManager, SandboxClientFake } from "@rika/orb"
import { ArtifactStore, Database, McpApprovalStore, Migration, OrbStore, ProjectStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Artifact, Codec, Common, Event, Ids, Message, Orb, Remote } from "@rika/schema"
import { OrbMirror } from "@rika/server"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { Input, Orb as CliOrb, OrbShell, OrbTournament, Output, Sync } from "../src/index"

const threadId = Ids.ThreadId.make("thread_cli_orb")
const projectId = Ids.ProjectId.make("project_cli_orb")
const orbId = Ids.OrbId.make("orb_1")
const now = Common.TimestampMillis.make(1_970_000_000_000)
const usageRunningAt = Common.TimestampMillis.make(now + 60_000)
const usageSinceAt = Common.TimestampMillis.make(now + 120_000)
const usagePausedAt = Common.TimestampMillis.make(now + 180_000)
const usageResumedAt = Common.TimestampMillis.make(now + 240_000)
const usageReadAt = Common.TimestampMillis.make(now + 360_000)
const finalDiff: Remote.OrbChangesResponse = {
  base_commit: "abc123",
  head_commit: "def456",
  diff: "diff --git a/README.md b/README.md",
  dirty: true,
}

describe("CLI orb commands", () => {
  test("list prints an orb table from OrbStore.list", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        return yield* CliOrb.executeCommand({ type: "orb", action: "list" })
      }).pipe(Effect.provide(makeLayer({ output }))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout).toEqual([
      "thread\tproject\tstatus\tlast_active_at",
      `${threadId}\t${projectId}\trunning\t${now}`,
    ])
  })

  test("usage prints project-filtered running minutes from stored intervals", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedUsageOrb()
        return yield* CliOrb.executeCommand({
          type: "orb",
          action: "usage",
          project_name: "demo",
          since: usageSinceAt,
        })
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            times: [now, now, usageRunningAt, usagePausedAt, usageResumedAt, usageReadAt],
          }),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout).toEqual([
      "thread\tproject\trunning_minutes\tintervals",
      "thread_cli_orb_usage\tdemo\t3\t2",
      "TOTAL\t\t3\t2",
    ])
  })

  test("tournament without yes aborts before provisioning in non-tty input", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const exitCode = await Effect.runPromise(
      CliOrb.executeCommand({
        type: "orb",
        action: "tournament",
        task: "ship it",
        branch_count: 3,
        sync_winner: false,
        keep_losers: false,
        yes: false,
      }).pipe(Effect.provide(makeLayer({ output, calls, inputIsTty: false }))),
    )

    expect(exitCode).toBe(1)
    expect(calls).toEqual([])
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(["about to provision 3 sandboxes", "aborted"])
  })

  test("tournament with yes judges orb diffs and cleans up losers", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const judgeInputs: Array<JudgeService.CompareInput> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
        })
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "tournament",
          task: "ship it",
          branch_count: 3,
          project_name: "demo",
          modes: ["smart", "deep2", "deep3"],
          rubric: "prefer tested diffs",
          sync_winner: true,
          keep_losers: false,
          yes: true,
        })
        const records = yield* OrbStore.list()
        const winner = records.find((record) => record.status === "running")
        const artifacts =
          winner === undefined ? [] : yield* ArtifactStore.list({ thread_id: winner.thread_id, kind: "verdict" })
        const finalDiffArtifacts = yield* Effect.forEach(records, (record) =>
          ArtifactStore.list({ thread_id: record.thread_id, kind: "orb-final-diff" }),
        )
        const workspaceArtifacts = yield* ArtifactStore.listAll({
          workspace_id: Ids.WorkspaceId.make("project:project_1"),
        })
        return { exitCode, records, artifacts, finalDiffArtifacts: finalDiffArtifacts.flat(), workspaceArtifacts }
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            calls,
            judgeInputs,
            tournamentDiffs: [
              {
                base_commit: "abc123",
                head_commit: "aaa111",
                diff: "diff --git a/a.txt b/a.txt\n+candidate one\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "bbb222",
                diff: "diff --git a/b.txt b/b.txt\n+candidate two\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "ccc333",
                diff: "diff --git a/c.txt b/c.txt\n+candidate three\n",
                dirty: true,
              },
            ],
            tournamentSummaries: ["summary one", "summary two", "summary three"],
          }),
        ),
      ),
    )

    expect(result.exitCode).toBe(0)
    expect(judgeInputs).toHaveLength(1)
    expect(judgeInputs[0]).toMatchObject({
      task: "ship it",
      content_kind: "diff",
      rubric: "prefer tested diffs",
    })
    expect(judgeInputs[0]?.candidates).toHaveLength(3)
    expect(judgeInputs[0]?.candidates[1]?.content).toContain("diff --git a/b.txt b/b.txt")
    expect(judgeInputs[0]?.candidates[1]?.content).toContain("## Candidate summary\nsummary two")
    expect(calls.filter((call) => call.startsWith("provision:"))).toHaveLength(3)
    expect(calls.filter((call) => call.startsWith("kill:"))).toHaveLength(2)
    expect(calls.filter((call) => call.startsWith("sync:"))).toHaveLength(1)
    expect(result.records.filter((record) => record.status === "killed")).toHaveLength(2)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]?.metadata).toMatchObject({ winner_id: "orb-2", candidate_count: 3 })
    expect(result.finalDiffArtifacts).toHaveLength(2)
    expect(result.workspaceArtifacts.map((artifact) => artifact.kind).toSorted()).toEqual([
      "orb-final-diff",
      "orb-final-diff",
      "verdict",
    ])
    expect(
      result.finalDiffArtifacts
        .map((artifact) => Schema.decodeUnknownSync(Remote.OrbChangesResponse)(artifact.content).diff)
        .toSorted(),
    ).toEqual(["diff --git a/a.txt b/a.txt\n+candidate one\n", "diff --git a/c.txt b/c.txt\n+candidate three\n"])
    expect(output.stderr).toContain("[orb 2/3] turn running...")
    expect(output.stdout[0]).toBe("Rank\tThread\tMode\tScore\tChanged Files\tStrengths")
    expect(output.stdout.at(-1)).toContain(".rika/worktrees/")
  })

  test("tournament cleans up losers when winner sync exits non-zero", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
        })
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "tournament",
          task: "ship it",
          branch_count: 2,
          project_name: "demo",
          sync_winner: true,
          keep_losers: false,
          yes: true,
        })
        const records = yield* OrbStore.list()
        const finalDiffArtifacts = yield* Effect.forEach(records, (record) =>
          ArtifactStore.list({ thread_id: record.thread_id, kind: "orb-final-diff" }),
        )
        return { exitCode, records, finalDiffArtifacts: finalDiffArtifacts.flat() }
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            calls,
            syncExitCode: 7,
            tournamentDiffs: [
              {
                base_commit: "abc123",
                head_commit: "aaa111",
                diff: "diff --git a/a.txt b/a.txt\n+candidate one\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "bbb222",
                diff: "diff --git a/b.txt b/b.txt\n+candidate two\n",
                dirty: true,
              },
            ],
            tournamentSummaries: ["summary one", "summary two"],
          }),
        ),
      ),
    )

    expect(result.exitCode).toBe(7)
    expect(result.records.filter((record) => record.status === "killed")).toHaveLength(1)
    expect(result.finalDiffArtifacts).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("kill:"))).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("sync:"))).toHaveLength(1)
  })

  test("tournament preserves the winner when sync fails through the error channel", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
        })
        const exit = yield* Effect.result(
          CliOrb.executeCommand({
            type: "orb",
            action: "tournament",
            task: "ship it",
            branch_count: 2,
            project_name: "demo",
            sync_winner: true,
            keep_losers: false,
            yes: true,
          }),
        )
        const records = yield* OrbStore.list()
        const finalDiffArtifacts = yield* Effect.forEach(records, (record) =>
          ArtifactStore.list({ thread_id: record.thread_id, kind: "orb-final-diff" }),
        )
        return { exit, records, finalDiffArtifacts: finalDiffArtifacts.flat() }
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            calls,
            syncFails: true,
            tournamentDiffs: [
              {
                base_commit: "abc123",
                head_commit: "aaa111",
                diff: "diff --git a/a.txt b/a.txt\n+candidate one\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "bbb222",
                diff: "diff --git a/b.txt b/b.txt\n+candidate two\n",
                dirty: true,
              },
            ],
            tournamentSummaries: ["summary one", "summary two"],
          }),
        ),
      ),
    )

    expect(result.exit._tag).toBe("Failure")
    expect(result.records.filter((record) => record.status === "running")).toHaveLength(1)
    expect(result.records.filter((record) => record.status === "killed")).toHaveLength(1)
    expect(result.finalDiffArtifacts).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("kill:"))).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("sync:"))).toHaveLength(1)
  })

  test("tournament cleans up provisioned orbs when judging fails", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
        })
        yield* CliOrb.executeCommand({
          type: "orb",
          action: "tournament",
          task: "ship it",
          branch_count: 2,
          project_name: "demo",
          sync_winner: false,
          keep_losers: false,
          yes: true,
        })
        return yield* OrbStore.list()
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            calls,
            judgeFails: true,
            tournamentDiffs: [
              {
                base_commit: "abc123",
                head_commit: "aaa111",
                diff: "diff --git a/a.txt b/a.txt\n+candidate one\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "bbb222",
                diff: "diff --git a/b.txt b/b.txt\n+candidate two\n",
                dirty: true,
              },
            ],
            tournamentSummaries: ["summary one", "summary two"],
          }),
        ),
      ),
    )

    expect(result._tag).toBe("Failure")
    expect(calls.filter((call) => call.startsWith("kill:"))).toHaveLength(2)
    expect(calls.filter((call) => call === "artifact.put")).toHaveLength(2)
    expect(calls.filter((call) => call.startsWith("sync:"))).toHaveLength(0)
  })

  test("tournament preserves the selected winner when loser cleanup fails", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
        })
        const exit = yield* Effect.result(
          CliOrb.executeCommand({
            type: "orb",
            action: "tournament",
            task: "ship it",
            branch_count: 2,
            project_name: "demo",
            sync_winner: false,
            keep_losers: false,
            yes: true,
          }),
        )
        const records = yield* OrbStore.list()
        return { exit, records }
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            calls,
            judgeWinnerIndex: 0,
            killFailsOnCall: 1,
            tournamentDiffs: [
              {
                base_commit: "abc123",
                head_commit: "aaa111",
                diff: "diff --git a/a.txt b/a.txt\n+candidate one\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "bbb222",
                diff: "diff --git a/b.txt b/b.txt\n+candidate two\n",
                dirty: true,
              },
            ],
            tournamentSummaries: ["summary one", "summary two"],
          }),
        ),
      ),
    )

    expect(result.exit._tag).toBe("Failure")
    expect(result.records.filter((record) => record.status === "running")).toHaveLength(1)
  })

  test("tournament excludes failed candidates from judging", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const judgeInputs: Array<JudgeService.CompareInput> = []

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
        })
        return yield* CliOrb.executeCommand({
          type: "orb",
          action: "tournament",
          task: "ship it",
          branch_count: 3,
          project_name: "demo",
          sync_winner: false,
          keep_losers: false,
          yes: true,
        })
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            calls,
            judgeInputs,
            tournamentFailedOrdinals: new Set([2]),
            tournamentDiffs: [
              {
                base_commit: "abc123",
                head_commit: "aaa111",
                diff: "diff --git a/a.txt b/a.txt\n+candidate one\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "bbb222",
                diff: "diff --git a/b.txt b/b.txt\n+candidate two\n",
                dirty: true,
              },
              {
                base_commit: "abc123",
                head_commit: "ccc333",
                diff: "diff --git a/c.txt b/c.txt\n+candidate three\n",
                dirty: true,
              },
            ],
            tournamentSummaries: ["summary one", "summary two", "summary three"],
          }),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(judgeInputs[0]?.candidates).toHaveLength(2)
    expect(judgeInputs[0]?.candidates.map((candidate) => candidate.content).join("\n")).not.toContain("candidate two")
    expect(calls).not.toContain("changes:2")
    expect(calls.filter((call) => call.startsWith("kill:"))).toHaveLength(2)
  })

  test("kill with force flushes, stores a final diff artifact, then kills", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls }))),
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(["flush", "changes", "artifact.put", `forceKill:${orbId}`])
    expect(result.stored?.status).toBe("killed")
    expect(output.stderr).toEqual([])
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toMatchObject({
      thread_id: threadId,
      kind: "orb-final-diff",
      title: "Orb final diff",
      content: finalDiff,
    })
    expect(JSON.stringify(result.artifacts[0]?.content)).not.toContain("orb-token")
  })

  test("kill with force stores final diff artifacts under the project workspace", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const workspaceId = Ids.WorkspaceId.make(`project:${projectId}`)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const artifacts = yield* ArtifactStore.listAll({ workspace_id: workspaceId, kind: "orb-final-diff" })
        return { exitCode, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, liveArtifactStore: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toMatchObject({
      thread_id: threadId,
      workspace_id: workspaceId,
      kind: "orb-final-diff",
      content: finalDiff,
    })
  })

  test("kill default no aborts without mutation", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: false,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, input: "\n", calls }))),
    )

    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([])
    expect(result.stored?.status).toBe("running")
    expect(result.artifacts).toEqual([])
    expect(output.stderr).toEqual([`Kill orb ${orbId} for thread ${threadId}? [y/N]`, "aborted"])
  })

  test("unreachable kill warns, skips artifact, and still marks killed", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, flushFails: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(["flush", `forceKill:${orbId}`])
    expect(result.stored?.status).toBe("killed")
    expect(result.artifacts).toEqual([])
    expect(output.stderr[0]).toContain("warning: skipped final orb diff")
  })

  test("artifact persistence failure warns and still kills", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, artifactPutFails: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(["flush", "changes", "artifact.put", `forceKill:${orbId}`])
    expect(result.stored?.status).toBe("killed")
    expect(result.artifacts).toEqual([])
    expect(output.stderr[0]).toContain("warning: skipped final orb diff")
  })

  test("orb changes API failure warns, skips artifact, and still kills", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const sandbox = SandboxClientFake.makeState()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, changesFails: true, sandbox, useLiveManager: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(["flush", "changes"])
    expect(sandbox.calls.kill).toEqual(["sandbox_cli_orb"])
    expect(result.stored?.status).toBe("killed")
    expect(result.artifacts).toEqual([])
    expect(output.stderr[0]).toContain("warning: skipped final orb diff")
    expect(output.stderr[0]).toContain("status 502")
  })

  test("sandbox kill failure still marks the orb killed locally", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const sandbox = SandboxClientFake.makeState({ killFailureMessage: "sandbox not found" })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, sandbox, useLiveManager: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(["flush", "changes", "artifact.put"])
    expect(sandbox.calls.kill).toEqual(["sandbox_cli_orb"])
    expect(result.stored?.status).toBe("killed")
    expect(result.artifacts).toHaveLength(1)
  })

  test("kill with force reaps a provisioning orb with a sandbox and frees the thread slot", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const sandbox = SandboxClientFake.makeState()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedProvisioningOrb("sandbox_cli_orb")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const retry = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_cli_orb_retry",
        })
        return { exitCode, stored, retry }
      }).pipe(Effect.provide(makeLayer({ output, calls, sandbox, useLiveManager: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stored?.status).toBe("killed")
    expect(result.retry.status).toBe("provisioning")
    expect(sandbox.calls.kill).toEqual(["sandbox_cli_orb"])
    expect(output.stderr[0]).toContain("warning: skipped final orb diff")
  })

  test("kill with force reaps a provisioning orb without a sandbox and frees the thread slot", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const sandbox = SandboxClientFake.makeState()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedProvisioningOrb(null)
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const retry = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_cli_orb_retry",
        })
        return { exitCode, stored, retry }
      }).pipe(Effect.provide(makeLayer({ output, calls, sandbox, useLiveManager: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stored?.status).toBe("killed")
    expect(result.retry.status).toBe("provisioning")
    expect(sandbox.calls.kill).toEqual([])
    expect(output.stderr[0]).toContain("warning: skipped final orb diff")
  })

  test("kill without force still rejects a provisioning orb", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const sandbox = SandboxClientFake.makeState()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedProvisioningOrb("sandbox_cli_orb")
        const exit = yield* Effect.result(
          CliOrb.executeCommand({
            type: "orb",
            action: "kill",
            thread_id: threadId,
            force: false,
          }),
        )
        const stored = yield* OrbStore.get(orbId)
        return { exit, stored }
      }).pipe(Effect.provide(makeLayer({ output, input: "yes\n", calls, sandbox, useLiveManager: true }))),
    )

    expect(result.exit._tag).toBe("Failure")
    if (result.exit._tag !== "Failure") throw new Error("expected kill failure")
    expect(result.exit.failure).toBeInstanceOf(OrbManager.OrbProvisionError)
    expect(result.stored?.status).toBe("provisioning")
    expect(sandbox.calls.kill).toEqual([])
    expect(output.stderr[0]).toBe(`Kill orb ${orbId} for thread ${threadId}? [y/N]`)
    expect(output.stderr[1]).toContain("warning: skipped final orb diff")
  })

  test("shell delegates to the orb shell service with the required thread id", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const shellThreads: Array<Ids.ThreadId> = []

    const exitCode = await Effect.runPromise(
      CliOrb.executeCommand({
        type: "orb",
        action: "shell",
        thread_id: threadId,
      }).pipe(Effect.provide(makeLayer({ output, shellThreads }))),
    )

    expect(exitCode).toBe(0)
    expect(shellThreads).toEqual([threadId])
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual([])
  })
})

const makeLayer = (input: {
  readonly output: Output.MemoryOutput
  readonly input?: string
  readonly calls?: Array<string>
  readonly flushFails?: boolean
  readonly artifactPutFails?: boolean
  readonly changesFails?: boolean
  readonly killFails?: boolean
  readonly sandbox?: SandboxClientFake.State
  readonly useLiveManager?: boolean
  readonly shellThreads?: Array<Ids.ThreadId>
  readonly times?: ReadonlyArray<Common.TimestampMillis>
  readonly inputIsTty?: boolean
  readonly judgeInputs?: Array<JudgeService.CompareInput>
  readonly tournamentDiffs?: ReadonlyArray<Remote.OrbChangesResponse>
  readonly tournamentSummaries?: ReadonlyArray<string>
  readonly tournamentFailedOrdinals?: ReadonlySet<number>
  readonly syncExitCode?: number
  readonly judgeFails?: boolean
  readonly syncFails?: boolean
  readonly judgeWinnerIndex?: number
  readonly killFailsOnCall?: number
  readonly liveArtifactStore?: boolean
}) => {
  const calls = input.calls ?? []
  const tournamentState = {
    threadByIndex: new Map<number, Ids.ThreadId>(),
    modeByIndex: new Map<number, string>(),
  }
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-cli-orb-test",
    data_dir: "/workspace/rika-cli-orb-test/.rika",
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = input.times === undefined ? Time.fixedLayer(now) : timeSequenceLayer(input.times)
  const idLayer = IdGenerator.sequenceLayer(1)
  const artifactLayer =
    input.liveArtifactStore === true
      ? ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
      : artifactStoreLayer(calls, input.artifactPutFails === true)
  const projectLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    idLayer,
    artifactLayer,
    projectLayer,
    OrbStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer), Layer.provideMerge(idLayer)),
    McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer)),
  )
  const clientFactory: CliOrb.ClientFactory = (endpointUrl) =>
    input.tournamentDiffs === undefined
      ? Client.make({
          requestJson: () =>
            Effect.sync(() => {
              calls.push("changes")
            }).pipe(
              Effect.andThen(
                input.changesFails === true
                  ? Effect.fail(
                      new Client.SdkError({
                        message: "Rika API request failed with status 502",
                        operation: "requestJson",
                        status: 502,
                      }),
                    )
                  : Effect.succeed(finalDiff),
              ),
            ),
          streamJson: () => Stream.empty,
        })
      : tournamentClient(
          endpointUrl,
          input.tournamentDiffs,
          input.tournamentSummaries ?? [],
          input.tournamentFailedOrdinals ?? new Set(),
          calls,
          tournamentState,
        )

  const outputLayer = Output.memoryLayer(input.output)
  const inputLayer = Input.memoryLayer(input.input ?? "", input.inputIsTty ?? true)
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const sandboxLayer = SandboxClientFake.layer(input.sandbox ?? SandboxClientFake.makeState())
  const managerLayer =
    input.useLiveManager === true
      ? OrbManager.layerWithSystem(makeOrbManagerSystem()).pipe(
          Layer.provideMerge(storageLayer),
          Layer.provideMerge(sandboxLayer),
          Layer.provideMerge(diagnosticsLayer),
          Layer.provideMerge(redactorLayer),
        )
      : orbManagerLayer(calls, input.killFails === true, input.killFailsOnCall).pipe(Layer.provideMerge(storageLayer))
  const mirrorLayer = orbMirrorLayer(calls, input.flushFails === true)
  const judgeLayer = fakeJudgeLayer(input.judgeInputs ?? [], input.judgeFails === true, input.judgeWinnerIndex)
  const syncLayer = fakeSyncLayer(calls, input.output, input.syncExitCode ?? 0, input.syncFails === true)
  const tournamentLayer = OrbTournament.layerWithClientFactory(clientFactory).pipe(
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(outputLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(judgeLayer),
    Layer.provideMerge(syncLayer),
  )
  const shellLayer = OrbShell.testLayer({
    shell: (id) =>
      Effect.sync(() => {
        input.shellThreads?.push(id)
        return 0
      }),
  })
  const commandLayer = CliOrb.layerWithClientFactory(clientFactory).pipe(
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(outputLayer),
    Layer.provideMerge(inputLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(mirrorLayer),
    Layer.provideMerge(judgeLayer),
    Layer.provideMerge(syncLayer),
    Layer.provideMerge(tournamentLayer),
    Layer.provideMerge(shellLayer),
  )
  return Layer.mergeAll(
    storageLayer,
    outputLayer,
    inputLayer,
    managerLayer,
    mirrorLayer,
    judgeLayer,
    syncLayer,
    tournamentLayer,
    shellLayer,
    commandLayer,
    redactorLayer,
    diagnosticsLayer,
    sandboxLayer,
  )
}

const ThreadCreateBody = Schema.Struct({
  thread_id: Schema.optional(Ids.ThreadId),
  project_id: Schema.optional(Ids.ProjectId),
})

const TurnStartBody = Schema.Struct({
  thread_id: Ids.ThreadId,
  mode: Schema.optional(Schema.String),
})

const tournamentClient = (
  endpointUrl: string,
  diffs: ReadonlyArray<Remote.OrbChangesResponse>,
  summaries: ReadonlyArray<string>,
  failedOrdinals: ReadonlySet<number>,
  calls: Array<string>,
  state: {
    readonly threadByIndex: Map<number, Ids.ThreadId>
    readonly modeByIndex: Map<number, string>
  },
): Client.Interface => {
  const index = endpointIndex(endpointUrl)
  return Client.make({
    requestJson: (request) =>
      Effect.sync(() => {
        if (request.path === "/v1/threads") {
          calls.push(`thread:${index}`)
          const body = Schema.decodeUnknownSync(ThreadCreateBody)(request.body)
          const candidateThreadId = body.thread_id ?? Ids.ThreadId.make(`thread_orb_tournament_${index}`)
          state.threadByIndex.set(index, candidateThreadId)
          return threadSummary(candidateThreadId, body.project_id ?? projectId)
        }
        if (request.path === "/v1/turns") {
          const body = Schema.decodeUnknownSync(TurnStartBody)(request.body)
          calls.push(`turn:${index}:${body.mode ?? "smart"}`)
          state.threadByIndex.set(index, body.thread_id)
          state.modeByIndex.set(index, body.mode ?? "smart")
          return { thread_id: body.thread_id, accepted: true }
        }
        if (request.path === "/v1/orb/changes") {
          calls.push(`changes:${index}`)
          return diffs[index - 1] ?? diffs[0] ?? finalDiff
        }
        throw new Error(`unexpected request ${request.path}`)
      }).pipe(Effect.mapError((cause) => new Client.SdkError({ message: String(cause), operation: "requestJson" }))),
    streamJson: () => {
      calls.push(`stream:${index}`)
      const candidateThreadId = state.threadByIndex.get(index) ?? Ids.ThreadId.make(`thread_orb_tournament_${index}`)
      const turnId = Ids.TurnId.make(`turn_orb_tournament_${index}`)
      const terminal = failedOrdinals.has(index)
        ? turnFailed(candidateThreadId, turnId, 3, "remote failed")
        : turnCompleted(candidateThreadId, turnId, 3)
      return Stream.fromIterable(
        [
          turnStarted(candidateThreadId, turnId, 1),
          messageAdded(candidateThreadId, turnId, 2, summaries[index - 1] ?? ""),
          terminal,
        ].map((event) => Codec.encode(Event.Event)(event)),
      )
    },
  })
}

const endpointIndex = (endpointUrl: string) => {
  const match = /orb-(\d+)\.cli\.test/.exec(endpointUrl)
  return match === null ? 1 : Number(match[1])
}

const threadSummary = (summaryThreadId: Ids.ThreadId, summaryProjectId: Ids.ProjectId): Remote.ThreadSummary => ({
  thread_id: summaryThreadId,
  workspace_id: Ids.WorkspaceId.make(`project:${summaryProjectId}`),
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  created_at: now,
  updated_at: now,
})

const turnStarted = (eventThreadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`event_${eventThreadId}_${sequence}`),
  thread_id: eventThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "turn.started",
  created_at: now,
  data: {},
})

const messageAdded = (
  eventThreadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  sequence: number,
  content: string,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_${eventThreadId}_${sequence}`),
  thread_id: eventThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "message.added",
  created_at: now,
  data: {
    message: Message.assistant({
      id: Ids.MessageId.make(`message_${eventThreadId}_${sequence}`),
      thread_id: eventThreadId,
      turn_id: turnId,
      content: [Message.text(content)],
      created_at: now,
    }),
  },
})

const turnCompleted = (eventThreadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event_${eventThreadId}_${sequence}`),
  thread_id: eventThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "turn.completed",
  created_at: now,
  data: {},
})

const turnFailed = (
  eventThreadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  sequence: number,
  message: string,
): Event.TurnFailed => ({
  id: Ids.EventId.make(`event_${eventThreadId}_${sequence}`),
  thread_id: eventThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "turn.failed",
  created_at: now,
  data: { error: { kind: "unknown", message } },
})

const fakeJudgeLayer = (inputs: Array<JudgeService.CompareInput>, fails: boolean, winnerIndex?: number) =>
  JudgeService.fakeLayer((input) =>
    Effect.sync(() => {
      inputs.push(input)
    }).pipe(
      Effect.andThen(
        fails
          ? Effect.fail(new JudgeService.JudgeError({ message: "judge unavailable", operation: "compare" }))
          : Effect.sync(() => fakeVerdict(input, winnerIndex)),
      ),
    ),
  )

const fakeVerdict = (input: JudgeService.CompareInput, winnerIndex?: number): JudgeService.Verdict => {
  const winner = input.candidates[winnerIndex ?? 1] ?? input.candidates[0]
  if (winner === undefined) throw new Error("fake judge requires candidates")
  return {
    winner_id: winner.id,
    ranking: input.candidates
      .map((candidate) => ({
        candidate_id: candidate.id,
        median_score: candidate.id === winner.id ? 10 : 7,
        first_place_votes: candidate.id === winner.id ? 1 : 0,
      }))
      .toSorted((left, right) => right.median_score - left.median_score),
    judges: [
      {
        winner_id: winner.id,
        rationale: "second candidate wins",
        scores: input.candidates.map((candidate) => ({
          candidate_id: candidate.id,
          score: candidate.id === winner.id ? 10 : 7,
          strengths: candidate.id === winner.id ? "best diff" : "reasonable diff",
          weaknesses: "none",
        })),
      },
    ],
    rationale: "second candidate wins",
  }
}

const fakeSyncLayer = (calls: Array<string>, output: Output.MemoryOutput, exitCode: number, fails: boolean) =>
  Layer.succeed(
    Sync.Service,
    Sync.Service.of({
      executeCommand: (command) =>
        Effect.sync(() => {
          calls.push(`sync:${command.thread_id}`)
          output.stdout.push(`/workspace/rika-cli-orb-test/.rika/worktrees/${command.thread_id}`)
          return exitCode
        }).pipe(
          Effect.andThen((code) =>
            fails ? Effect.fail(new Sync.SyncError({ message: "sync failed", exit_code: 1 })) : Effect.succeed(code),
          ),
        ),
    }),
  )

const artifactStoreLayer = (calls: Array<string>, putFails: boolean) => {
  const rows = new Map<Ids.ArtifactId, Artifact.Artifact>()
  return Layer.succeed(
    ArtifactStore.Service,
    ArtifactStore.Service.of({
      put: (artifact) =>
        Effect.sync(() => calls.push("artifact.put")).pipe(
          Effect.andThen(
            putFails
              ? Effect.fail(
                  new ArtifactStore.ArtifactStoreError({
                    message: "artifact store unavailable",
                    operation: "put",
                    artifact_id: artifact.id,
                  }),
                )
              : Effect.sync(() => {
                  rows.set(artifact.id, artifact)
                  return artifact
                }),
          ),
        ),
      get: (artifactId) => Effect.succeed(Option.fromNullishOr(rows.get(artifactId))),
      list: (input) =>
        Effect.succeed(
          [...rows.values()]
            .filter((artifact) => artifact.thread_id === input.thread_id)
            .filter((artifact) => input.kind === undefined || artifact.kind === input.kind)
            .toSorted((left, right) => right.created_at - left.created_at)
            .slice(0, input.limit ?? 100),
        ),
      listAll: (input = {}) =>
        Effect.succeed(
          [...rows.values()]
            .filter((artifact) => input.workspace_id === undefined || artifact.workspace_id === input.workspace_id)
            .filter((artifact) => input.kind === undefined || artifact.kind === input.kind)
            .toSorted((left, right) => right.created_at - left.created_at)
            .slice(0, input.limit ?? 100),
        ),
    }),
  )
}

const orbManagerLayer = (
  calls: Array<string>,
  killFails: boolean,
  killFailsOnCall: number | undefined,
): Layer.Layer<OrbManager.Service, never, OrbStore.Service> =>
  Layer.effect(
    OrbManager.Service,
    Effect.map(OrbStore.Service, (orbs) => {
      let provisionCount = 0
      let killCount = 0
      return OrbManager.Service.of({
        provisionForThread: (input) =>
          Effect.gen(function* () {
            provisionCount += 1
            calls.push(`provision:${provisionCount}:${input.thread_id}`)
            const created = yield* orbs
              .create({
                thread_id: input.thread_id,
                project_id: input.project_id,
                sandbox_id: `sandbox_cli_orb_${provisionCount}`,
                base_commit: "abc123",
                endpoint_url: `https://orb-${provisionCount}.cli.test`,
                token: `orb-token-${provisionCount}`,
              })
              .pipe(Effect.mapError(toOrbProvisionError("provision", Ids.OrbId.make(`orb_${provisionCount}`))))
            return yield* orbs
              .setStatus(created.orb_id, "running")
              .pipe(Effect.mapError(toOrbProvisionError("provision", created.orb_id)))
          }),
        pause: (id) => orbs.setStatus(id, "paused").pipe(Effect.mapError(toOrbProvisionError("pause", id))),
        resume: (id) => orbs.setStatus(id, "running").pipe(Effect.mapError(toOrbProvisionError("resume", id))),
        kill: (id) =>
          Effect.sync(() => {
            killCount += 1
            calls.push(`kill:${id}`)
            return killCount
          }).pipe(
            Effect.andThen((currentKillCount) =>
              killFails || killFailsOnCall === currentKillCount
                ? Effect.fail(
                    new OrbManager.OrbProvisionError({
                      message: "sandbox provider denied kill",
                      step: "kill",
                      orb_id: id,
                    }),
                  )
                : orbs.setStatus(id, "killed").pipe(Effect.mapError(toOrbProvisionError("kill", id))),
            ),
          ),
        forceKill: (id) =>
          Effect.sync(() => {
            calls.push(`forceKill:${id}`)
          }).pipe(
            Effect.andThen(orbs.setStatus(id, "killed").pipe(Effect.mapError(toOrbProvisionError("forceKill", id)))),
          ),
      })
    }),
  )

const orbMirrorLayer = (calls: Array<string>, flushFails: boolean) =>
  Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: () => Effect.void,
      flush: () =>
        Effect.sync(() => calls.push("flush")).pipe(
          Effect.andThen(
            flushFails
              ? Effect.fail(new Client.SdkError({ message: "orb unreachable", operation: "streamJson" }))
              : Effect.void,
          ),
        ),
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )

const seedOrb = (status: Extract<Orb.OrbStatus, "running" | "paused">) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: threadId,
      project_id: projectId,
      sandbox_id: "sandbox_cli_orb",
      base_commit: "abc123",
      endpoint_url: "https://orb.cli.test",
      token: "orb-token",
    })
    return yield* OrbStore.setStatus(created.orb_id, status)
  })

const seedProvisioningOrb = (sandboxId: string | null) =>
  OrbStore.create({
    thread_id: threadId,
    project_id: projectId,
    ...(sandboxId === null ? {} : { sandbox_id: sandboxId }),
  })

const seedUsageOrb = () =>
  Effect.gen(function* () {
    const project = yield* ProjectStore.create({
      name: "demo",
      repo_origin: "https://github.com/example/demo.git",
    })
    const created = yield* OrbStore.create({
      thread_id: Ids.ThreadId.make("thread_cli_orb_usage"),
      project_id: project.project_id,
      sandbox_id: "sandbox_cli_orb",
      base_commit: "abc123",
      endpoint_url: "https://orb.cli.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    yield* OrbStore.setStatus(created.orb_id, "paused")
    return yield* OrbStore.setStatus(created.orb_id, "running")
  })

const timeSequenceLayer = (times: ReadonlyArray<Common.TimestampMillis>) => {
  let index = 0
  return Layer.succeed(
    Time.Service,
    Time.Service.of({
      nowMillis: Effect.sync(() => {
        const value = times[Math.min(index, times.length - 1)] ?? now
        index += 1
        return value
      }),
    }),
  )
}

const makeOrbManagerSystem = (): OrbManager.System => ({
  makeTempPath: Effect.never,
  createGitBundle: () => Effect.never,
  currentBranch: () => Effect.never,
  randomToken: Effect.succeed("server-token"),
  health: () => Effect.void,
  sleep: () => Effect.void,
})

const toOrbProvisionError = (step: string, id: Ids.OrbId) => (error: unknown) =>
  new OrbManager.OrbProvisionError({
    message: error instanceof Error ? error.message : String(error),
    step,
    orb_id: id,
  })
