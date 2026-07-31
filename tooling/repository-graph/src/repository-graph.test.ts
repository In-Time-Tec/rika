import { describe, expect, test } from "vitest"
import { classifyTestKind, scanImports } from "./repository-graph"

describe("repository graph classification", () => {
  test("classifies every supported test class", () => {
    expect(classifyTestKind("packages/a/src/a.test.ts")).toBe("unit-test")
    expect(classifyTestKind("packages/a/test/contract/a.test.ts")).toBe("contract-test")
    expect(classifyTestKind("apps/a/src/a.integration.test.ts")).toBe("integration-test")
    expect(classifyTestKind("apps/a/test/a.tui.test.ts")).toBe("tui-test")
    expect(classifyTestKind("apps/a/test/a.proc.test.ts")).toBe("process-test")
    expect(classifyTestKind("tooling/a/test/fixtures/example.ts")).toBe("fixture")
  })

  test("keeps the compatibility import scanner separate from generation", () => {
    expect(
      scanImports(
        'import x from "./repository-graph"; export { y } from "./repository-graph.test"; await import("./dependency-cruiser-spike.test")',
      ),
    ).toEqual([
      { specifier: "./dependency-cruiser-spike.test", kind: "dynamic-import" },
      { specifier: "./repository-graph", kind: "import" },
      { specifier: "./repository-graph.test", kind: "import" },
    ])
  })
})
