import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { inspectWorkspaceCapabilities } from "../../src/workspace/capabilities"
import { provideLayer } from "../support/layer"

const platform = Layer.merge(BunCrypto.layer, BunFileSystem.layer)

it.effect("recognizes an accessible workspace directory with Bun FileSystem", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const workspacePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-capabilities-" })
      const snapshot = yield* inspectWorkspaceCapabilities({
        target: "orb",
        workspacePath,
        nativeTools: true,
        pty: true,
      })
      expect(snapshot.filesystem).toEqual({ _tag: "Ready", detail: "workspace filesystem available" })
      expect(snapshot.workspaceLifecycle).toEqual({ _tag: "Ready", detail: "workspace lifecycle ready" })
    }),
  ).pipe(provideLayer(platform)),
)
