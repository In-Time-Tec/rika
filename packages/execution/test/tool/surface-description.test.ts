import { expect, it } from "vitest"
import { describeNativeToolSurface } from "../../src/tool/surface-description"
import { toolkit } from "../../src/tool/registry"

it("describes exact native input shapes and schema bounds without a second hand catalog", () => {
  expect(describeNativeToolSurface(Object.values(toolkit.tools))).toBe(
    [
      "bash({ command, workdir, timeout_ms: 0-60000 })",
      "shell_command_status({ processId, waitMillis: 0-10000 })",
      "read({ path, read_range: [start, end] })",
      "edit({ path, old_str, new_str, replace_all })",
    ].join("\n"),
  )
})
