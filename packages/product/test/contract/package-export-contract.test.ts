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
    "read-web-page-service",
    "read-web-page-tool",
    "web-search-input-contract",
    "web-search-provider",
    "web-search-service",
    "web-search-tool",
    "edit-file-tool",
    "grep-files-tool",
    "list-files-tool",
    "local-path",
    "read-file-tool",
    "unified-diff",
    "workspace-directory-listing",
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
    "executor-assignment",
    "executor-assignments",
    "environment-policy",
    "environment-store",
    "hosted-authorization",
    "hosted-identity-context",
    "hosted-model",
    "hosted-observability",
    "runner-registration",
    "hosted-store",
    "client-protocol",
    "execution-authority-reconciliation",
    "failure-message",
    "failure-policy",
    "operation-error",
    "operation-failure",
    "openai-auth-contract",
    "openai-auth-http",
    "openai-auth-service",
    "provider-credential-store",
    "context-file-system",
    "context-resolution-service",
    "resolved-context",
    "execution-request",
    "execution-route-resolution",
    "execution-route-snapshot",
    "execution-session-lifecycle",
    "execution-gateway",
    "execution-transcript-contract",
    "execution-projection",
    "execution-projection-watch",
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
    "root-turn-owner",
    "thread-deletion",
    "thread-operation",
    "thread-protocol-store",
    "interactive-command",
    "interactive-connection",
    "interactive-event",
    "interactive-feed",
    "interactive-session",
    "interactive-thread-view-feed",
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
    "workspace-capability",
    "workspace-record",
    "thread-repository",
    "thread-search-repository",
    "thread-summary-repository",
    "transcript-repository",
    "turn-repository",
    "turn-repository-steering",
    "thread-query-service",
    "workspace-preparation",
  ],
  "@rika/product-store": [
    "memory-assignments",
    "memory-store",
    "postgres-assignments",
    "postgres-environment-store",
    "postgres-layer",
    "postgres-store",
    "postgres-thread-protocol-store",
    "postgres-turn-worker-store",
    "migrations",
    "migrations/postgres/0001-hosted-authority.sql",
    "migrations/postgres/0002-hosted-identity-ancestry.sql",
    "migrations/postgres/0003-hosted-authority-fences.sql",
    "migrations/postgres/0004-runner.sql",
    "migrations/postgres/0005-runner-recovery.sql",
    "migrations/postgres/0006-product-state.sql",
    "migrations/postgres/0007-hosted-prompt-admission.sql",
    "migrations/postgres/0008-hosted-turn-worker.sql",
    "migrations/postgres/0009-provider-credentials.sql",
    "migrations/postgres/0013-thread-protocol.sql",
    "migrations/postgres/0014-runner-registration.sql",
    "migrations/postgres/0015-environment-and-egress.sql",
    "migrations/postgres/0016-authority-revocation.sql",
    "migrations/postgres/0018-workspace-preparation.sql",
    "migrations/postgres/0019-approved-repository-publication.sql",
    "migrations/postgres/0020-tool-policy-audit.sql",
    "postgres-product-repositories",
    "postgres-workspace-preparations",
    "memory-thread-search-repository",
    "postgres-goal-repository",
    "postgres-thread-summary-repository",
    "postgres-thread-repository",
    "postgres-transcript-repository",
    "postgres-turn-repository",
  ],
  "@rika/terminal": [
    "opentui-surface",
    "terminal-message",
    "terminal-performance-evaluation",
    "terminal-session",
    "terminal-state",
    "terminal-state-reducer",
    "terminal-submission-state",
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
