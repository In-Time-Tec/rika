import { describe, expect, test } from "bun:test"
import { SelfExtension } from "@rika/plugin"
import { Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Extensions, Output } from "../src/index"

const artifactId = Ids.ArtifactId.make("artifact_cli_extension")

const change = (enabled: boolean): SelfExtension.ExtensionChange => ({
  kind: "plugin",
  action: enabled ? "enable-plugin" : "create-plugin",
  name: "notify",
  workspace_id: Ids.WorkspaceId.make("workspace_cli_extension"),
  enabled,
  artifact_id: artifactId,
  files: [{ path: ".rika/plugins/notify.ts.disabled", before: null, after: "plugin" }],
  trust: {
    model: "explicit-local",
    enabled,
    reason: enabled ? "verified" : "disabled until verified",
    verification: enabled ? { status: "passed", command: "bun test", exit_code: 0 } : { status: "skipped" },
  },
})

const makeLayer = (output: Output.MemoryOutput, enableResult = change(true)) =>
  Extensions.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(
      Layer.succeed(
        SelfExtension.Service,
        SelfExtension.Service.of({
          createSkill: () =>
            Effect.succeed({
              kind: "skill",
              action: "create-skill",
              name: "deploy-helper",
              workspace_id: Ids.WorkspaceId.make("workspace_cli_extension"),
              enabled: true,
              artifact_id: artifactId,
              files: [{ path: ".agents/skills/deploy-helper/SKILL.md", before: null, after: "skill" }],
              trust: {
                model: "explicit-local",
                enabled: true,
                reason: "skill instructions",
                verification: { status: "skipped" },
              },
            }),
          createPlugin: () => Effect.succeed(change(false)),
          enablePlugin: () => Effect.succeed(enableResult),
          disablePlugin: () => Effect.succeed({ ...change(false), action: "disable-plugin" }),
          rollbackPlugin: () => Effect.succeed({ ...change(false), action: "rollback-plugin" }),
        }),
      ),
    ),
  )

describe("CLI extension commands", () => {
  test("prints self-extension changes as machine-readable JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const code = await Effect.runPromise(
      Extensions.executeCommand({
        type: "extensions",
        action: "create-plugin",
        name: "notify",
        description: "Notify user",
        thread_id: Ids.ThreadId.make("thread_cli_extension"),
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(code).toBe(0)
    expect(JSON.parse(output.stdout[0] ?? "{}")).toMatchObject({
      kind: "plugin",
      action: "create-plugin",
      name: "notify",
      enabled: false,
    })
  })

  test("returns non-zero when plugin verification fails", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const failed = {
      ...change(true),
      enabled: false,
      trust: {
        ...change(true).trust,
        enabled: false,
        verification: { status: "failed" as const, command: "bun test", exit_code: 1 },
      },
    }

    const code = await Effect.runPromise(
      Extensions.executeCommand({
        type: "extensions",
        action: "enable-plugin",
        name: "notify",
        verification_command: "bun test",
      }).pipe(Effect.provide(makeLayer(output, failed))),
    )

    expect(code).toBe(1)
    expect(JSON.parse(output.stdout[0] ?? "{}")).toMatchObject({
      action: "enable-plugin",
      enabled: false,
      trust: { verification: { status: "failed" } },
    })
  })
})
