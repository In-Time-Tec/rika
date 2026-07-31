import { describe, expect, test } from "vitest"
import { checkDependencyManifests } from "../../scripts/check-dependencies"

const manifest = (name: string, dependencies: Record<string, string>) => ({
  path: `${name}/package.json`,
  manifest: { name, dependencies },
})

describe("dependency boundaries", () => {
  test("checks external framework links in workspace manifests", () => {
    expect(checkDependencyManifests([manifest("@rika/runtime", { "@relayfx/sdk": "workspace:*" })])).toEqual([
      "@rika/runtime/package.json: @relayfx/sdk uses external workspace linking",
    ])
  })

  test("allows autoresearch local package links and rejects other file links", () => {
    expect(
      checkDependencyManifests([
        manifest("@rika/cli", {
          "@relayfx/sdk": "file:/private/tmp/rika-autoresearch-links/relayfx-sdk-0.7.32.tgz",
        }),
      ]),
    ).toEqual([])
    expect(
      checkDependencyManifests([manifest("@rika/cli", { "@relayfx/sdk": "file:/tmp/other/relayfx-sdk.tgz" })]),
    ).toEqual(["@rika/cli/package.json: @relayfx/sdk uses file:/tmp/other/relayfx-sdk.tgz"])
  })

  test("allows web-research SDKs but rejects language-model provider SDKs in tools", () => {
    expect(checkDependencyManifests([manifest("@rika/tools", { "parallel-web": "1.1.0" })])).toEqual([])
    expect(
      checkDependencyManifests([manifest("@rika/tools", { openai: "6.0.0", "@ai-sdk/anthropic": "2.0.0" })]),
    ).toEqual([
      "@rika/tools/package.json: @rika/tools cannot depend on language-model provider openai",
      "@rika/tools/package.json: @rika/tools cannot depend on language-model provider @ai-sdk/anthropic",
    ])
  })
})
