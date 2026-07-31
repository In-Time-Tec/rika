import { describe, expect, test } from "vitest"
import {
  checkDependencyManifests,
  checkExportMaps,
  checkManifests,
  checkPackageMetadata,
  checkScriptBoundaries,
} from "./package-boundary-policy"

const manifest = (name: string, dependencies: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  path: `${name}/package.json`,
  manifest: { name, dependencies, rika: { kind: "capability", domain: name }, ...extra },
})

describe("repository policy", () => {
  test("rejects forbidden local links and external framework workspace links", () => {
    expect(checkDependencyManifests([manifest("@rika/runtime", { "@relayfx/sdk": "workspace:*" })])).toEqual([
      "@rika/runtime/package.json: @relayfx/sdk uses external workspace linking",
    ])
    expect(checkDependencyManifests([manifest("@rika/cli", { "@relayfx/sdk": "file:/tmp/other/a.tgz" })])).toEqual([
      "@rika/cli/package.json: @relayfx/sdk uses file:/tmp/other/a.tgz",
    ])
  })

  test("allows the autoresearch link and web research SDK", () => {
    expect(
      checkDependencyManifests([
        manifest("@rika/cli", { "@relayfx/sdk": "file:/private/tmp/rika-autoresearch-links/a.tgz" }),
      ]),
    ).toEqual([])
    expect(checkDependencyManifests([manifest("@rika/tools", { "parallel-web": "1.1.0" })])).toEqual([])
  })

  test("rejects model providers only in tools", () => {
    expect(
      checkDependencyManifests([manifest("@rika/tools", { openai: "6.0.0", "@ai-sdk/anthropic": "2.0.0" })]),
    ).toEqual([
      "@rika/tools/package.json: @rika/tools cannot depend on language-model provider openai",
      "@rika/tools/package.json: @rika/tools cannot depend on language-model provider @ai-sdk/anthropic",
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
})
