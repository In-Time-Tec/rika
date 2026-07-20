import { expect, test } from "vitest"
import { Scene } from "./scene"

const quitAfter = (marker: string) => [Scene.action.writeAfter(marker, "\u0003", 500)]

test(
  "renders an exact edit as a single-file diff",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            { command: "mkdir -p src; echo \"export const mode = 'old'\" > src/config.ts" },
            "seed-config",
          ),
        ]),
        Scene.model.turn([
          Scene.model.toolCall(
            "edit",
            {
              path: "src/config.ts",
              old_str: "export const mode = 'old'\n",
              new_str: "export const mode = 'new'\nexport const enabled = true\n",
            },
            "edit-config",
          ),
        ]),
        Scene.model.text("PATCH_STREAM_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Update the config.\r"),
        ...quitAfter("PATCH_STREAM_COMPLETE"),
      ],
    }).then((result) => {
      expect(result.output).toContain("Editing src/config.ts")
      expect(result.output).toContain("Edited src/config.ts +2 -1")
      expect(result.output).toContain("- export const mode = 'old'")
      expect(result.output).toContain("+ export const mode = 'new'")
      expect(result.output).toContain("+ export const enabled = true")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "groups multi-file writes and expands each file independently",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("write", { path: "alpha.txt", content: "ALPHA_FILE_BODY\n" }, "write-alpha"),
          Scene.model.toolCall("write", { path: "beta.txt", content: "BETA_FILE_BODY\n" }, "write-beta"),
          Scene.model.toolCall("write", { path: "gamma.txt", content: "GAMMA_FILE_BODY\n" }, "write-gamma"),
        ]),
        Scene.model.text("MULTI_FILE_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Create three files.\r"),
        Scene.action.writeAfter("MULTI_FILE_COMPLETE", "\t", 100),
        Scene.action.writeAfter("3 files", "\r", 100),
        Scene.action.writeAfter("Create alpha.txt", "\t\r", 100),
        ...quitAfter("ALPHA_FILE_BODY"),
      ],
    }).then((result) => {
      expect(result.output).toContain("Created 3 files +3")
      expect(result.output).toContain("Create alpha.txt +1")
      expect(result.output).toContain("Create beta.txt +1")
      expect(result.output).toContain("Create gamma.txt +1")
      expect(result.output).toContain("ALPHA_FILE_BODY")
      expect(result.output).not.toContain("BETA_FILE_BODY\n+BETA_FILE_BODY")
    }),
  45_000,
)

test(
  "groups commands while preserving command and result ordering",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("bash", { command: "printf FIRST_OUTPUT" }, "first-command"),
          Scene.model.toolCall("bash", { command: "printf SECOND_OUTPUT" }, "second-command"),
          Scene.model.toolCall("bash", { command: "printf THIRD_OUTPUT" }, "third-command"),
        ]),
        Scene.model.text("COMMAND_GROUP_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run three commands.\r"),
        Scene.action.writeAfter("COMMAND_GROUP_COMPLETE", "\t", 100),
        Scene.action.writeAfter("Ran 3 commands", "\r", 100),
        ...quitAfter("$ printf FIRST_OUTPUT"),
      ],
    }).then((result) => {
      expect(result.output).toContain("Ran 3 commands")
      const first = result.output.lastIndexOf("$ printf FIRST_OUTPUT")
      const second = result.output.lastIndexOf("$ printf SECOND_OUTPUT")
      const third = result.output.lastIndexOf("$ printf THIRD_OUTPUT")
      expect(first).toBeGreaterThan(-1)
      expect(first).toBeLessThan(second)
      expect(second).toBeLessThan(third)
    }),
  45_000,
)

test(
  "shows bounded expanded process output and a nonzero exit code",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            {
              command: "i=1; while [ $i -le 20 ]; do echo BOUND_LINE_$i; i=$((i+1)); done; exit 7",
            },
            "bounded-failure",
          ),
        ]),
        Scene.model.text("BOUND_FAILURE_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run the failing command.\r"),
        Scene.action.writeAfter("BOUND_FAILURE_COMPLETE", "\t", 100),
        Scene.action.writeAfter("exit code: 7", "\r", 100),
        ...quitAfter("BOUND_LINE_12"),
      ],
    }).then((result) => {
      expect(result.output).toContain("(exit code: 7)")
      expect(result.output).toContain("BOUND_LINE_1")
      expect(result.output).toContain("BOUND_LINE_12")
      expect(result.output).not.toContain("BOUND_LINE_13")
      expect(result.output).not.toContain("BOUND_LINE_20")
    }),
  45_000,
)

test(
  "renders a process wait with the original command and only newly received output",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            {
              command: "printf EARLY_CHUNK; sleep 0.4; printf LATE_CHUNK",
              timeout_ms: 100,
            },
            "background-command",
          ),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("shell_command_status", { processId: "1", waitMillis: 2_000 }, "wait-command"),
        ]),
        Scene.model.text("WAIT_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run and wait.\r"),
        Scene.action.writeAfter("WAIT_COMPLETE", "\t\t\r", 100),
        ...quitAfter("LATE_CHUNK"),
      ],
    }).then((result) => {
      expect(result.output).toContain("Waited for printf EARLY_CHUNK")
      expect(result.output).toContain("LATE_CHUNK")
      const waitFrame = result.output.slice(result.output.lastIndexOf("Waited for printf EARLY_CHUNK"))
      expect(waitFrame.match(/EARLY_CHUNK/g)).toHaveLength(1)
      expect(waitFrame.match(/LATE_CHUNK/g)).toHaveLength(2)
    }),
  45_000,
)

test(
  "cancels a running command without publishing late output",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            {
              command: 'printf STARTED_CHUNK; sleep 5; printf FORBIDDEN_\\"LATE_CHUNK\\"',
              timeout_ms: 0,
            },
            "cancel-command",
          ),
        ]),
        Scene.model.text("FORBIDDEN_MODEL_COMPLETION", 5_000),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Start a long command.\r"),
        Scene.action.writeAfter("printf STARTED_CHUNK", "\u0003", 100),
        ...quitAfter("cancelled"),
      ],
    }).then((result) => {
      expect(result.output).toContain("printf STARTED_CHUNK")
      expect(result.output).toContain("(cancelled)")
      expect(result.output).not.toContain("FORBIDDEN_LATE_CHUNK")
      expect(result.output).not.toContain("FORBIDDEN_MODEL_COMPLETION")
    }),
  15_000,
)

test(
  "keeps duplicate commands as separately expandable results",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("bash", { command: "printf DUPLICATE_OUTPUT" }, "duplicate-one"),
          Scene.model.toolCall("bash", { command: "printf DUPLICATE_OUTPUT" }, "duplicate-two"),
        ]),
        Scene.model.text("DUPLICATES_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run both duplicate commands.\r"),
        Scene.action.writeAfter("DUPLICATES_COMPLETE", "\t\r", 100),
        ...quitAfter("Ran 2 commands"),
      ],
    }).then((result) => {
      const finalGroup = result.output.slice(result.output.lastIndexOf("Ran 2 commands"))
      expect(finalGroup.match(/\$ printf DUPLICATE_OUTPUT/g)).toHaveLength(2)
    }),
  45_000,
)

test(
  "keeps process output literal while rendering assistant Markdown",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            { command: "printf '# PROCESS_HEADING\\n**PROCESS_BOLD**\\n- PROCESS_ITEM'" },
            "markdown-output",
          ),
        ]),
        Scene.model.text("## ASSISTANT_HEADING\n\n**ASSISTANT_BOLD**\n\n- ASSISTANT_ITEM\n\nMARKDOWN_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Show Markdown and process output.\r"),
        Scene.action.writeAfter("MARKDOWN_COMPLETE", "\t", 100),
        Scene.action.writeAfter("printf # PROCESS_HEADING", "\r", 100),
        ...quitAfter("PROCESS_ITEM"),
      ],
    }).then((result) => {
      expect(result.output).toContain("# PROCESS_HEADING")
      expect(result.output).toContain("**PROCESS_BOLD**")
      expect(result.output).toContain("- PROCESS_ITEM")
      expect(result.output).toContain("ASSISTANT_HEADING")
      expect(result.output).toContain("ASSISTANT_BOLD")
      expect(result.output).toContain("ASSISTANT_ITEM")
      expect(result.output).not.toContain("**ASSISTANT_BOLD**")
    }),
  45_000,
)
