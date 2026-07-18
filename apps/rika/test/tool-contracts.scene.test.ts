import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "renders successful and typed-failure tool outcomes without a provider backend",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("create_file", { path: "contract.txt", content: "bounded" }, "create-contract"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("create_file", { path: "contract.txt", content: "duplicate" }, "duplicate-contract"),
        ]),
        Scene.model.text("TOOL_CONTRACT_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Exercise tool outcomes.\r"),
        Scene.action.writeAfter("TOOL_CONTRACT_COMPLETE", "\u0003", 1_000),
        Scene.action.writeAfterDelay("\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("Created")
      expect(result.output).toContain("✕ Created contract.txt +2")
      expect(result.output).toContain("TOOL_CONTRACT_COMPLETE")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "rejects malformed tool input at the interactive boundary",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("read_file", { path: "contract.txt", limit: 0 }, "invalid-contract")]),
        Scene.model.text("INVALID_CONTRACT_REJECTED"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Reject malformed input.\r"),
        Scene.action.writeAfter("INVALID_CONTRACT_REJECTED", "\u0003", 1_000),
        Scene.action.writeAfterDelay("\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("INVALID_CONTRACT_REJECTED")
      expect(result.output).not.toContain("Read contract.txt")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "cancels an active process tool without publishing late output",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "shell",
            {
              command: "bun",
              args: [
                "-e",
                "setTimeout(() => console.log(Buffer.from('TEFURV9UT09MX09VVFBVVA==', 'base64').toString()), 5000)",
              ],
              waitMillis: 10_000,
            },
            "cancel-shell",
          ),
        ]),
        Scene.model.text("CANCEL_CONTRACT_COMPLETE", 5_000),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Cancel a process tool.\r"),
        Scene.action.writeAfter("bun -e setTimeout", "\u0003", 100),
        Scene.action.writeAfter("cancelled", "\u0003", 100),
        Scene.action.writeAfterDelay("\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("cancelled")
      expect(result.output).not.toContain("LATE_TOOL_OUTPUT")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
