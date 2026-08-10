import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"

const PackageManifest = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) })
const PackageManifestJson = Schema.fromJsonString(PackageManifest)

const expected: Record<string, ReadonlyArray<string>> = {
  "@rika/configuration": [
    "behavior-mode",
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
    "agent-role-toolkits",
    "coding-tool-catalog",
    "thread-tool-contract",
    "media-view-contract",
    "media-view-service",
    "view-media-tool",
    "coding-tool-policy",
    "local-safety-policy",
    "bash-tool",
    "shell-command-status-tool",
    "shell-process-registry",
    "coding-tool-result",
    "coding-tool-runtime",
    "parallel-web-search",
    "read-web-page-service",
    "read-web-page-tool",
    "web-search-input-contract",
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
    "mcp-discovery",
    "mcp-oauth-service",
    "mcp-runtime",
    "plugin-contract",
    "plugin-digest",
    "plugin-registry",
    "skill-prompt-listing",
    "skill-file-system",
    "skill-registry",
    "skill-registry-model",
  ],
  "@rika/transcript": [
    "transcript-unit-identity",
    "transcript-unit-order",
    "recorded-shell-presentation",
    "subagent-presentation",
    "partial-tool-input",
    "cell-presentation",
    "transcript-presentation-model",
    "transcript-unit",
  ],
  "@rika/product": [
    "agent-profile",
    "goal-record",
    "goal-repository",
    "goal-service",
    "execution-authority-reconciliation",
    "failure-message",
    "failure-policy",
    "operation-failure",
    "openai-auth-contract",
    "openai-auth-service",
    "openrouter-auth-contract",
    "openrouter-auth-service",
    "provider-credential-store",
    "context-file-system",
    "context-resolution-service",
    "resolved-context",
    "execution-request",
    "execution-route-resolution",
    "execution-route-snapshot",
    "execution-gateway",
    "execution-transcript-contract",
    "execution-projection",
    "review-intent",
    "execution-status",
    "model-registration-identity",
    "provider-connection-snapshot",
    "configuration-operation",
    "extension-operation",
    "interactive-operation",
    "product-operation",
    "product-operation-service",
    "review-policy",
    "thread-operation",
    "interactive-command",
    "interactive-event",
    "interactive-session",
    "interactive-thread-view-feed",
    "server-interactive-feed",
    "server-operation-request",
    "server-service-handshake",
    "server-service",
    "pending-turn",
    "thread-record",
    "thread-relationship",
    "thread-result",
    "thread-state",
    "thread-summary",
    "thread-view",
    "thread-tool-action",
    "transcript-page",
    "turn-record",
    "workspace-record",
    "thread-repository",
    "thread-search-repository",
    "thread-summary-repository",
    "transcript-repository",
    "turn-repository",
    "thread-query-service",
  ],
  "@rika/product-store": [
    "product-database-layer",
    "sqlite-goal-repository",
    "sqlite-thread-search-repository",
    "sqlite-thread-summary-repository",
    "sqlite-thread-repository",
    "sqlite-transcript-repository",
    "sqlite-turn-repository",
  ],
  "@rika/terminal": [
    "opentui-surface",
    "terminal-message",
    "terminal-performance-evaluation",
    "terminal-session",
    "terminal-state",
    "terminal-state-reducer",
    "terminal-timeline-bounds",
    "terminal-transcript-presentation",
    "transcript-viewport",
  ],
}

it.effect("every frozen export target resolves to a source file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(BunServices.layer)
      const path = Context.get(context, Path.Path)
      const fileSystem = Context.get(context, FileSystem.FileSystem)
      for (const [packageName, names] of Object.entries(expected)) {
        const packagePath = packageName.slice("@rika/".length)
        const manifest = yield* Schema.decodeUnknownEffect(PackageManifestJson)(
          yield* fileSystem.readFileString(path.resolve("packages", packagePath, "package.json")),
        )
        for (const name of names) {
          const target = manifest.exports[`./${name}`]
          expect(target, `${packageName}/${name} is missing an exports entry`).toBeDefined()
          expect(
            yield* fileSystem.exists(path.resolve("packages", packagePath, target!)),
            `${packageName}/${name} points at a missing file`,
          ).toBe(true)
        }
      }
    }),
  ),
)

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
