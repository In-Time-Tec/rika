import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "groups real file discovery, search, and range calls in the TUI",
  () =>
    Scene.run({
      files: [
        { path: ".hidden/visible.txt", bytes: new TextEncoder().encode("hidden needle") },
        { path: "node_modules/pkg/index.ts", bytes: new TextEncoder().encode("needle-in-dependency") },
        { path: "src/alpha.ts", bytes: new TextEncoder().encode("zero\nαlpha 🙂\nneedle café\nlast") },
        { path: "src/brackets.ts", bytes: new TextEncoder().encode("literal [value]") },
      ],
      script: [
        Scene.model.turn([
          Scene.model.toolCall("read_file", { path: "src/alpha.ts", offset: 1, limit: 2 }, "read-range"),
        ]),
        Scene.model.turn([Scene.model.toolCall("find_files", { query: ".txt" }, "find-hidden")]),
        Scene.model.turn([
          Scene.model.toolCall("grep", { pattern: "^(needle|hidden).*café?$", regex: true }, "grep-regex"),
        ]),
        Scene.model.text("FILE_DISCOVERY_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Inspect the fixture files.\r"),
        Scene.action.writeAfter("FILE_DISCOVERY_COMPLETE", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("Explored 1 file, 2 searches")
      expect(result.clientLogs).toContain("read-range")
      expect(result.clientLogs).toContain("find-hidden")
      expect(result.clientLogs).toContain("grep-regex")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "renders typed errors for escaped symlinks, invalid regular expressions, missing files, and invalid ranges",
  () =>
    Scene.run({
      workspace: { "inside.txt": "safe" },
      outsideFiles: { "secret.txt": "OUTSIDE_SECRET" },
      symlinks: [{ path: "escape.txt", target: "secret.txt", outside: true }],
      script: [
        Scene.model.turn([Scene.model.toolCall("read_file", { path: "escape.txt" }, "read-symlink")]),
        Scene.model.turn([Scene.model.toolCall("grep", { pattern: "[", regex: true }, "invalid-regex")]),
        Scene.model.turn([Scene.model.toolCall("read_file", { path: "missing.txt" }, "read-missing")]),
        Scene.model.turn([
          Scene.model.toolCall("read_file", { path: "inside.txt", offset: -1, limit: 0 }, "invalid-range"),
        ]),
        Scene.model.text("FILE_ERRORS_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Try unsafe and invalid reads.\r"),
        Scene.action.writeAfter("FILE_ERRORS_COMPLETE", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("✕ Explored 3 files, 1 search")
      expect(result.output).not.toContain("OUTSIDE_SECRET")
      expect(result.clientLogs).toContain("read-symlink")
      expect(result.clientLogs).toContain("invalid-regex")
      expect(result.clientLogs).toContain("read-missing")
      expect(result.clientLogs).toContain("invalid-range")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "cancels a file-reading turn without publishing a late response",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "shell",
            {
              command: "sh",
              args: ["-c", "mkfifo blocked.txt; (sleep 2; printf released > blocked.txt) >/dev/null 2>&1 &"],
            },
            "setup-fifo",
          ),
        ]),
        Scene.model.turn([
          Scene.model.textPart("FILE_READ_STARTED"),
          Scene.model.toolCall("read_file", { path: "blocked.txt" }, "cancel-read"),
        ]),
        Scene.model.text("LATE_FILE_RESPONSE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Read the blocking file.\r"),
        Scene.action.writeAfter("FILE_READ_STARTED", "\u0003"),
        Scene.action.writeAfterDelay("\u0003", 3_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("⊘ Explored 1 file")
      expect(result.output).not.toContain("LATE_FILE_RESPONSE")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
