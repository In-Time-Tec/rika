import { expect, test } from "vitest"
import { Scene } from "./scene"

const isolated = (diagnostics: string) => expect(diagnostics).not.toContain('"rika.model.backend.kind":"provider"')

test(
  "steers text into the active execution",
  () =>
    Scene.runWarm({
      workspace: { "fixture.txt": "scene fixture" },
      script: [
        Scene.model.turn([Scene.model.toolCall("read", { path: "fixture.txt" }, "active-steer-read")], 1_000),
        Scene.model.text("ACTIVE_STEER_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Read the fixture slowly.\r"),
        Scene.action.writeAfter("Read the fixture slowly.", "Focus on the exact fixture text.\u0013", 100),
        Scene.action.writeAfter("ACTIVE_STEER_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("ACTIVE_STEER_COMPLETE")
      expect(result.diagnostics).toContain('"rika.resident.command.tag":"Steer"')
      isolated(result.diagnostics)
    }),
  45_000,
)

test(
  "removes a selected queued prompt by steering it into the active execution",
  () =>
    Scene.runWarm({
      workspace: { "fixture.txt": "scene fixture" },
      script: [
        Scene.model.turn([Scene.model.toolCall("read", { path: "fixture.txt" }, "queued-steer-read")], 1_500),
        Scene.model.text("QUEUED_STEER_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Keep this execution active.\r"),
        Scene.action.writeAfter("Keep this execution active.", "Use the queued steering instruction.\r", 100),
        Scene.action.writeAfter("Use the queued steering instruction.", "\u001b[A\r", 100),
        Scene.action.writeAfter("STEER_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("STEER_COMPLETE")
      expect(result.output.match(/Use the queued steering instruction\./g)?.length ?? 0).toBeGreaterThan(0)
      expect(result.diagnostics).toContain('"rika.resident.command.tag":"SteerQueued"')
      isolated(result.diagnostics)
    }),
  45_000,
)

test(
  "cancels active work without publishing its delayed response",
  () =>
    Scene.run({
      script: [Scene.model.text("LATE_CANCELLED_RESPONSE", 5_000)],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Begin cancellable work.\r"),
        Scene.action.writeAfter("Begin cancellable work.", "\u0003", 100),
        Scene.action.writeAfter("⊘", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("⊘")
      expect(result.output).not.toContain("LATE_CANCELLED_RESPONSE")
      expect(result.diagnostics).toContain('"rika.resident.command.tag":"Cancel"')
      isolated(result.diagnostics)
    }),
  45_000,
)

test(
  "interrupts active work and promotes the durably admitted replacement",
  () =>
    Scene.runWarm({
      script: [
        Scene.model.text("LATE_INTERRUPTED_RESPONSE", 5_000),
        Scene.model.text("REPLACEMENT_COMPLETE"),
        Scene.model.text("REPLACEMENT_COMPLETE"),
        Scene.model.text("REPLACEMENT_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Begin interruptible work.\r"),
        Scene.action.writeAfter("Begin interruptible work.", "Run the replacement prompt.\u001b[13;5u", 100),
        Scene.action.writeAfter("REPLACEMENT_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Run the replacement prompt.")
      expect(result.output).toContain("REPLACEMENT_COMPLETE")
      expect(result.output).not.toContain("LATE_INTERRUPTED_RESPONSE")
      isolated(result.diagnostics)
    }),
  45_000,
)

test(
  "promotes queued turns in admission order after cancellation",
  () =>
    Scene.runWarm({
      script: [
        Scene.model.text("LATE_QUEUE_HEAD", 5_000),
        Scene.model.text("FIRST_QUEUED_COMPLETE"),
        Scene.model.text("SECOND_QUEUED_COMPLETE"),
        Scene.model.text("SECOND_QUEUED_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Hold the queue head.\r"),
        Scene.action.writeAfter("Hold the queue head.", "First queued prompt.\r", 100),
        Scene.action.writeAfter("First queued prompt.", "Second queued prompt.\r", 100),
        Scene.action.writeAfter("Second queued prompt.", "\u0003", 100),
        Scene.action.writeAfter("SECOND_QUEUED_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("SECOND_QUEUED_COMPLETE")
      expect(result.output.indexOf("First queued prompt.")).toBeLessThan(result.output.indexOf("Second queued prompt."))
      expect(result.output).not.toContain("LATE_QUEUE_HEAD")
      isolated(result.diagnostics)
    }),
  45_000,
)

for (const decision of [
  { name: "allow once", keys: "\r", result: "SHELL_ALLOWED", terminal: "approved" },
  { name: "always allow", keys: "\u001b[C\r", result: "SHELL_ALWAYS", terminal: "approved" },
  { name: "deny", keys: "\u001b[C\u001b[C\r", result: "SHELL_DENIED", terminal: "denied" },
] as const) {
  test(
    `resolves a durable permission wait with ${decision.name}`,
    () =>
      Scene.run({
        workspaceSettings: { permissions: { shell: "ask" } },
        actions: [
          Scene.action.writeAfter("Welcome to Rika", `$ printf ${decision.result}\r`),
          Scene.action.writeAfter("Allow once", decision.keys, 100),
          Scene.action.restartAfter(decision.terminal),
          Scene.action.writeAfter("Welcome to Rika", "\u0003", 500),
        ],
      }).then((result) => {
        expect(result.output).toContain(decision.terminal)
        expect(result.diagnostics).toContain('"rika.resident.command.tag":"ResolvePermission"')
        isolated(result.diagnostics)
      }),
    45_000,
  )
}

test(
  "resolves a durable tool-approval wait with always allow",
  () =>
    Scene.run({
      workspace: { "approval.txt": "TOOL_APPROVAL_CONTENT" },
      environment: { RIKA_TEST_APPROVAL_TOOLS: "read" },
      script: [
        Scene.model.turn([Scene.model.toolCall("read", { path: "approval.txt" }, "approval-read")]),
        Scene.model.text("TOOL_APPROVAL_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Read the approval fixture.\r"),
        Scene.action.writeAfter("Allow once", "\u001b[C\r", 100),
        Scene.action.writeAfter("TOOL_APPROVAL_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("TOOL_APPROVAL_COMPLETE")
      expect(result.diagnostics).toContain('"rika.resident.command.tag":"ResolvePermission"')
      isolated(result.diagnostics)
    }),
  45_000,
)

test(
  "reconnects to an active execution without duplicating its completion",
  () =>
    Scene.runWarm({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("bash", { command: "printf RECONNECT_TOOL_COMPLETE" }, "reconnect-tool"),
        ]),
        Scene.model.text("RECONNECTED_COMPLETE", 1_000),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Keep running across reconnect.\r"),
        Scene.action.restartAfter("RECONNECT_TOOL_COMPLETE", "threads", "continue", "--last"),
        Scene.action.writeAfter("RECONNECTED_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("RECONNECT_TOOL_COMPLETE")
      expect(result.output).toContain("RECONNECTED_COMPLETE")
      expect(result.diagnostics.match(/resident\.connection\.accepted/g)?.length ?? 0).toBe(2)
      expect(result.diagnostics.match(/"rika\.event\.type":"execution\.completed"/g)?.length ?? 0).toBe(1)
      isolated(result.diagnostics)
    }),
  45_000,
)

test(
  "restarts the client and resumes an unresolved tool-approval wait",
  () =>
    Scene.run({
      workspace: { "restart-approval.txt": "RESTART_APPROVAL_CONTENT" },
      environment: { RIKA_TEST_APPROVAL_TOOLS: "read" },
      script: [
        Scene.model.turn([Scene.model.toolCall("read", { path: "restart-approval.txt" }, "restart-read")]),
        Scene.model.text("RESTARTED_WAIT_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Read the restart approval fixture.\r"),
        Scene.action.restartAfter("Allow once", "threads", "continue", "--last"),
        Scene.action.writeAfter("Allow once", "\r", 100),
        Scene.action.writeAfter("RESTARTED_WAIT_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("RESTARTED_WAIT_COMPLETE")
      expect(result.diagnostics.match(/resident\.connection\.accepted/g)?.length ?? 0).toBe(2)
      expect(result.diagnostics).toContain('"rika.resident.command.tag":"ResolvePermission"')
      isolated(result.diagnostics)
    }),
  90_000,
)

test(
  "reports interrupt-and-send replacement failure instead of pretending success",
  () =>
    Scene.runWarm({
      script: [Scene.model.text("LATE_FAILED_REPLACEMENT", 5_000)],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Start before failed replacement.\r"),
        Scene.action.writeAfter(
          "Start before failed replacement.",
          "Replacement must report failure.\u001b[13;5u",
          100,
        ),
        Scene.action.writeAfter("Execution failed", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Execution failed")
      expect(result.output).toContain("TestModel script exhausted")
      expect(result.output).not.toContain("LATE_FAILED_REPLACEMENT")
      isolated(result.diagnostics)
    }),
  45_000,
)
