import { describe, expect, test } from "vitest"
import { repositoryPolicy } from "./package-boundary-policy"

const {
  checkDependencyManifests,
  checkExportMaps,
  checkManifests,
  checkPackageMetadata,
  checkScriptBoundaries,
  checkSourceMetrics,
  checkTestTopology,
  checkSourceBasename,
  checkPackageEdges,
} = repositoryPolicy

const manifest = (name: string, dependencies: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  path: `${name}/package.json`,
  manifest: { name, dependencies, rika: { kind: "capability", domain: name }, ...extra },
})

describe("repository policy", () => {
  test("rejects forbidden local links and external framework workspace links", () => {
    expect(checkDependencyManifests([manifest("@rika/cli", { "@batonfx/core": "workspace:*" })])).toEqual([
      "@rika/cli/package.json: @batonfx/core uses external workspace linking",
    ])
    expect(checkDependencyManifests([manifest("@rika/cli", { "@batonfx/core": "file:/tmp/other/a.tgz" })])).toEqual([
      "@rika/cli/package.json: @batonfx/core uses file:/tmp/other/a.tgz",
    ])
  })

  test("allows the autoresearch link and web research SDK", () => {
    expect(
      checkDependencyManifests([
        manifest("@rika/cli", { "@batonfx/core": "file:/private/tmp/rika-autoresearch-links/a.tgz" }),
      ]),
    ).toEqual([])
    expect(checkDependencyManifests([manifest("@rika/coding-tools", { "parallel-web": "1.1.0" })])).toEqual([])
  })

  test("admits the Baton adapter as the CLI execution boundary", () => {
    expect(
      checkPackageEdges([
        manifest(
          "@rika/cli",
          { "@rika/baton-execution": "workspace:*" },
          {
            rika: { kind: "application", domain: "cli" },
          },
        ),
        manifest(
          "@rika/baton-execution",
          { "@rika/product": "workspace:*" },
          {
            rika: { kind: "adapter", domain: "execution" },
          },
        ),
        manifest("@rika/product", {}),
      ]),
    ).toEqual([])
  })

  test("rejects model providers only in tools", () => {
    expect(
      checkDependencyManifests([manifest("@rika/coding-tools", { openai: "6.0.0", "@ai-sdk/anthropic": "2.0.0" })]),
    ).toEqual([
      "@rika/coding-tools/package.json: @rika/coding-tools cannot depend on language-model provider openai",
      "@rika/coding-tools/package.json: @rika/coding-tools cannot depend on language-model provider @ai-sdk/anthropic",
    ])
  })

  test("reports metadata, source export, and colon script diagnostics", () => {
    expect(checkPackageMetadata([{ path: "bad/package.json", manifest: { name: "bad" } }])[0]?.rule).toBe(
      "package-kind",
    )
    expect(checkExportMaps([manifest("@rika/x", {}, { exports: { "./x": "./dist/x.js" } })])[0]?.rule).toBe(
      "source-exports",
    )
    expect(checkScriptBoundaries([manifest("@rika/x", {}, { scripts: { "bad:check": "echo bad" } })])[0]?.rule).toBe(
      "colon-script",
    )
  })

  test("combines diagnostics with remediation text", () => {
    const diagnostics = checkManifests([{ path: "bad/package.json", manifest: { name: "bad" } }])
    expect(diagnostics[0]?.remediation).toContain("rika.kind")
  })

  test("enforces warning and failure source thresholds", () => {
    expect(checkSourceMetrics({ path: "x.ts", lines: 501, exports: 5, dependencies: 13 })).toEqual([
      expect.objectContaining({ rule: "file-size", severity: "warning" }),
      expect.objectContaining({ rule: "export-count", severity: "warning" }),
      expect.objectContaining({ rule: "dependency-count", severity: "warning" }),
    ])
    expect(
      checkSourceMetrics({ path: "x.ts", lines: 801, exports: 9, dependencies: 19 }).every(
        (item) => item.severity === "error",
      ),
    ).toBe(true)
  })

  test("matches tests by source-relative stem instead of package ownership", () => {
    expect(
      checkTestTopology({
        sourcePath: "packages/example/src/feature/nested-value.ts",
        testPaths: ["packages/example/test/feature/nested-value.test.ts"],
      }),
    ).toEqual([])
    expect(
      checkTestTopology({
        sourcePath: "packages/example/src/feature/nested-value.ts",
        testPaths: ["packages/example/test/other/nested-value.test.ts"],
      })[0],
    ).toEqual(expect.objectContaining({ rule: "test-topology", severity: "warning" }))
    expect(
      checkTestTopology({
        sourcePath: "packages/example/src/feature/nested-value.ts",
        testPaths: ["packages/example/test/feature/nested-value.test.ts"],
        exception: "packages/example/test/integration.test.ts",
      }),
    ).toEqual([])
  })

  test("allows maintained framework configuration basenames without path waivers", () => {
    expect(checkSourceBasename("vitest.config.ts")).toBeUndefined()
    expect(checkSourceBasename("test/integration/vitest.config.ts")).toBeUndefined()
    expect(checkSourceBasename("test/integration/custom-vitest.config.ts")).toEqual(
      expect.objectContaining({ rule: "basename", severity: "error" }),
    )
  })
})
