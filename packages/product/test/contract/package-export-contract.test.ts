import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"

const PackageManifest = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) })
const PackageManifestJson = Schema.fromJsonString(PackageManifest)

const expected: Record<string, ReadonlyArray<string>> = {
  "@rika/configuration": [
    "behavior-mode",
    "model-catalog",
    "model-preset",
    "model-route",
    "model-route-label",
    "model-route-resolution",
    "canonical-data-root",
    "configuration-paths",
    "profile-data-paths",
    "configuration-settings",
    "configuration-service",
  ],
  "@rika/coding-tools": [
    "coding-tool-catalog",
    "thread-tool-contract",
    "tool-invocation",
    "agent-tool-contract",
    "agent-tool-result",
    "media-view-service",
    "view-media-tool",
    "coding-tool-policy",
    "local-safety-policy",
    "bash-tool",
    "shell-command-status-tool",
    "shell-process-registry",
    "coding-tool-runtime",
    "parallel-web-search",
    "read-web-page-service",
    "read-web-page-tool",
    "web-search-provider",
    "web-search-service",
    "web-search-tool",
    "edit-file-tool",
    "grep-files-tool",
    "local-path",
    "read-file-tool",
    "unified-diff",
    "workspace-file-search",
    "write-file-tool",
  ],
  "@rika/extensions": [
    "execution-extension-service",
    "mcp-configuration",
    "mcp-oauth-service",
    "mcp-runtime",
    "plugin-contract",
    "plugin-digest",
    "plugin-registry",
    "skill-registry",
  ],
  "@rika/transcript": [
    "child-parent-correlation",
    "transcript-unit-identity",
    "transcript-unit-order",
    "model-usage-fallback",
    "recorded-shell-presentation",
    "nested-transcript-projection",
    "partial-tool-input",
    "transcript-projection",
    "transcript-settlement",
    "transcript-presentation-model",
    "transcript-projection-model",
    "transcript-source-event",
    "transcript-unit",
  ],
  "@rika/product": [
    "agent-profile",
    "product-agent-service",
    "openai-auth-contract",
    "openai-auth-flow",
    "openai-auth-service",
    "context-file-system",
    "context-resolution-service",
    "resolved-context",
    "execution-approval",
    "execution-child-run",
    "execution-event",
    "execution-identifier",
    "execution-inspection",
    "execution-request",
    "execution-route-snapshot",
    "execution-service",
    "execution-status",
    "execution-workflow",
    "model-registration-identity",
    "provider-connection-snapshot",
    "configuration-operation",
    "extension-operation",
    "interactive-operation",
    "product-operation",
    "product-operation-service",
    "thread-operation",
    "workflow-operation",
    "interactive-command",
    "interactive-event",
    "interactive-session",
    "resident-interactive-feed",
    "resident-operation-request",
    "resident-service-handshake",
    "resident-service",
    "pending-turn",
    "thread-record",
    "thread-relationship",
    "thread-result",
    "thread-state",
    "thread-summary",
    "transcript-page",
    "turn-record",
    "workspace-record",
    "thread-interaction-repository",
    "thread-repository",
    "thread-search-repository",
    "thread-summary-repository",
    "transcript-repository",
    "turn-repository",
    "usage-repository",
    "thread-query-service",
    "thread-tool-service",
    "usage-projection",
    "usage-snapshot",
    "usage-snapshot-codec",
    "workflow-definition",
    "workflow-service",
  ],
  "@rika/product-store": [
    "product-database-layer",
    "sqlite-thread-interaction-repository",
    "sqlite-thread-search-repository",
    "sqlite-thread-summary-repository",
    "sqlite-thread-repository",
    "sqlite-transcript-repository",
    "sqlite-turn-repository",
    "sqlite-usage-repository",
  ],
  "@rika/relay-execution": [
    "baton-agent-definition",
    "media-analysis-adapter",
    "model-provider-runtime",
    "scripted-model-runtime",
    "relay-execution-layer",
    "relay-workflow-compiler",
  ],
  "@rika/terminal": [
    "terminal-performance-evaluation",
    "terminal-transcript-presentation",
    "transcript-viewport",
    "opentui-surface",
    "terminal-message",
    "terminal-state",
    "terminal-state-reducer",
    "terminal-session",
  ],
}

it("every frozen export target exists and resolves through Bun", () =>
  Effect.gen(function* () {
    for (const [packageName, names] of Object.entries(expected))
      for (const name of names) yield* Effect.tryPromise(() => import(`${packageName}/${name}`))
  }))

for (const [packageName, names] of Object.entries(expected)) {
  const packagePath = packageName.slice("@rika/".length)
  it(`${packageName} exports exactly frozen keys`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(BunServices.layer)
          const path = Context.get(context, Path.Path)
          const fileSystem = Context.get(context, FileSystem.FileSystem)
          const manifest = yield* Schema.decodeUnknownEffect(PackageManifestJson)(
            yield* fileSystem.readFileString(path.resolve("packages", packagePath, "package.json")),
          )
          expect(Object.keys(manifest.exports).toSorted()).toEqual(names.map((name) => `./${name}`).toSorted())
          expect(Object.keys(manifest.exports)).not.toContain(".")
        }),
      ),
    ))
}
