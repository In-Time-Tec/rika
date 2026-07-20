import { expect, test } from "vitest"
import { Scene } from "./scene"

const shellAsk = { permissions: { shell: "ask" } }

test(
  "allows an explicit shell permission with Enter and updates only that card",
  () =>
    Scene.run({
      workspaceSettings: shellAsk,
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "$printf '\\101\\114\\114\\117\\127\\105\\104'\r"),
        Scene.action.writeAfter("Run shell command", "\r"),
        Scene.action.writeAfter("ALLOWED", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Run shell command")
      expect(result.output).toContain("Allow once")
      expect(result.output).toContain("Always")
      expect(result.output).toContain("Deny")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "moves backward twice to always and confirms the selected permission choice",
  () =>
    Scene.run({
      workspaceSettings: shellAsk,
      actions: [
        Scene.action.writeAfter(
          "Welcome to Rika",
          "$printf '\\101\\114\\127\\101\\131\\123\\137\\123\\105\\114\\105\\103\\124\\105\\104'\r",
        ),
        Scene.action.writeAfter("› Allow once", "\u001b[1;1D", 500),
        Scene.action.writeAfter("›", "\u001b[1;1D", 500),
        Scene.action.writeAfter("›", "\r"),
        Scene.action.writeAfter("ALWAYS_SELECTED", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("ALWAYS_SELECTED")
    }),
  45_000,
)

test(
  "wraps left from allow to deny without executing the command",
  () =>
    Scene.run({
      workspaceSettings: shellAsk,
      inspectPaths: ["denied.txt"],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "$printf SHOULD_NOT_RUN > denied.txt\r"),
        Scene.action.writeAfter("› Allow once", "\u001b[1;1D", 500),
        Scene.action.writeAfter("›", "\r"),
        Scene.action.writeAfter("denied", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("denied")
      expect(result.inspectedPaths["denied.txt"]).toBe(false)
    }),
  45_000,
)

test(
  "ordinary successful tool events render a tool card without permission choices",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("bash", { command: "printf TOOL_OK" }, "ordinary-tool")]),
        Scene.model.text("ORDINARY_COMPLETE"),
        Scene.model.object({ title: "Ordinary tool" }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run an ordinary tool.\r"),
        Scene.action.writeAfter("ORDINARY", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("TOOL_OK")
      expect(result.output).not.toContain("Always")
    }),
  45_000,
)

test(
  "tool failures stay failed tool cards and never become permission prompts",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("read", { path: "missing-permission-scene.txt" }, "failed-tool")]),
        Scene.model.text("FAILURE_OBSERVED"),
        Scene.model.object({ title: "Tool failure" }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Read a missing file.\r"),
        Scene.action.writeAfter("FAILURE_OBSERVED", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("FAILURE_OBSERVED")
      expect(result.output).not.toContain("Always")
    }),
  45_000,
)

test(
  "allows a durable tool approval and resumes the scripted model",
  () =>
    Scene.run({
      toolApprovals: ["bash"],
      script: [
        Scene.model.turn([Scene.model.toolCall("bash", { command: "printf APPROVED_TOOL" }, "approved")]),
        Scene.model.text("APPROVAL_COMPLETE"),
        Scene.model.object({ title: "Tool approval" }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Use an approved tool.\r"),
        Scene.action.writeAfter("› Allow once", "\r"),
        Scene.action.writeAfter("APPROVAL_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("APPROVED_TOOL")
      expect(result.output).toContain("Allow once")
    }),
  45_000,
)

test(
  "denies a durable tool approval and lets the model handle the refusal",
  () =>
    Scene.run({
      toolApprovals: ["bash"],
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            { command: "printf \\106\\117\\122\\102\\111\\104\\104\\105\\116\\137\\124\\117\\117\\114" },
            "denied",
          ),
        ]),
        Scene.model.text("DENIAL_HANDLED"),
        Scene.model.object({ title: "Tool denial" }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Refuse the tool.\r"),
        Scene.action.writeAfter("› Allow once", "\u001b[D\r"),
        Scene.action.writeAfter("HANDLED", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("denied")
      expect(result.output).not.toContain("FORBIDDEN_TOOL")
    }),
  45_000,
)

test(
  "reconnects to one durable tool approval without duplicating its card",
  () =>
    Scene.run({
      toolApprovals: ["bash"],
      script: [
        Scene.model.turn([Scene.model.toolCall("bash", { command: "printf AFTER_RECONNECT" }, "reconnect")]),
        Scene.model.text("RECONNECTED_COMPLETE"),
        Scene.model.object({ title: "Reconnect approval" }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Reconnect during approval.\r"),
        Scene.action.reconnectAfter("› Allow once"),
        Scene.action.writeAfter("› Allow once", "\r"),
        Scene.action.writeAfter("AFTER_RECONNECT", ""),
        Scene.action.writeAfter("RECONNECTED_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("AFTER_RECONNECT")
      expect(
        result.diagnostics.match(
          /"message":"execution.event.received"[^\n]+"rika.event.type":"tool.approval.requested"/g,
        ) ?? [],
      ).toHaveLength(1)
    }),
  45_000,
)

test(
  "cancels while a durable approval is pending without running the tool",
  () =>
    Scene.run({
      toolApprovals: ["bash"],
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            { command: "printf \\114\\101\\124\\105\\137\\122\\105\\123\\125\\114\\124" },
            "cancelled",
          ),
        ]),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Cancel the approval.\r"),
        Scene.action.writeAfter("› Allow once", "\u0003"),
        Scene.action.writeAfter("cancelled", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("cancelled")
      expect(result.output).not.toContain("LATE_RESULT")
    }),
  45_000,
)

test(
  "ignores a stale cancelled permission ID when a new shell request arrives",
  () =>
    Scene.run({
      workspaceSettings: shellAsk,
      inspectPaths: ["stale.txt"],
      script: [
        Scene.model.text("STALE_READY"),
        Scene.model.object({ title: "Stale permission IDs" }),
        Scene.model.text("FRESH_TURN_READY"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Prepare stale permission IDs.\r"),
        Scene.action.writeAfter("STALE_READY", "$printf STALE_RESULT > stale.txt\r"),
        Scene.action.writeAfter("› Allow once", "\u0003"),
        Scene.action.writeAfter("Shell command denied", "Start a fresh turn.\r"),
        Scene.action.writeAfter(
          "FRESH_TURN_READY",
          "$printf '\\106\\122\\105\\123\\110\\137\\122\\105\\123\\125\\114\\124'\r",
        ),
        Scene.action.writeAfter("\\106\\122\\105\\123\\110", "\r"),
        Scene.action.writeAfter("FRESH_RESULT", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("FRESH_RESULT")
      expect(result.inspectedPaths["stale.txt"]).toBe(false)
    }),
  45_000,
)
