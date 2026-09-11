import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Installation, layer as installationLayer } from "../../src/client/installation"

const InstallationDisk = Schema.Struct({
  formatVersion: Schema.Literal(1),
  checkouts: Schema.Record(Schema.String, Schema.Struct({ workspaceIdentity: Schema.String })),
})

const fixture = Effect.fn("TuiV2.InstallationTest.fixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tui-v2-installation-" })
  const workspace = path.join(home, "workspace")
  const commonDirectory = path.join(home, "repository.git")
  const filename = path.join(home, "installation-v2.json")
  yield* fileSystem.makeDirectory(workspace)
  yield* fileSystem.makeDirectory(commonDirectory)
  const canonicalWorkspace = yield* fileSystem.realPath(workspace)
  const canonicalCommonDirectory = yield* fileSystem.realPath(commonDirectory)
  let headRevision = "first-head"
  let branch = "main"
  const missing: string | undefined = undefined
  const gitOutput = (_workspace: string, arguments_: ReadonlyArray<string>) => {
    const command = arguments_.join("\0")
    if (command === "rev-parse\0--show-toplevel") return Effect.succeed(canonicalWorkspace)
    if (command === "rev-parse\0--path-format=absolute\0--git-common-dir")
      return Effect.succeed(canonicalCommonDirectory)
    if (command === "remote\0get-url\0origin")
      return Effect.succeed("https://installation-token@example.test/team/rika.git?access_token=secret#fragment")
    if (command === "rev-parse\0HEAD") return Effect.succeed(headRevision)
    if (command === "symbolic-ref\0--quiet\0--short\0HEAD") return Effect.succeed(branch)
    return Effect.succeed(missing)
  }
  const context = yield* Layer.build(installationLayer({ home, filename, runtimeVersion: "1.4.0-test", gitOutput }))
  return {
    fileSystem,
    filename,
    installation: Context.get(context, Installation),
    workspace: canonicalWorkspace,
    updateRepository: (input: { readonly headRevision: string; readonly branch: string }) => {
      headRevision = input.headRevision
      branch = input.branch
    },
  }
})

it.layer(BunServices.layer)((test) => {
  test.effect("retains the legacy-compatible checkout workspace identity without persisting credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture()
        const first = yield* current.installation.prepare({ deviceId: "device-1", workspace: current.workspace })
        expect(first.workspacePath).toBe(current.workspace)
        expect(first.checkoutFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(first.workspaceIdentity).toMatch(/^runner:[A-Za-z0-9_-]{43}$/)
        expect(first.profile).toMatchObject({
          protocolVersion: 2,
          workspaceIdentity: first.workspaceIdentity,
          repository: {
            remoteUrl: "https://example.test/team/rika.git",
            headRevision: "first-head",
            branch: "main",
          },
          nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.4.0-test", trustMode: "trusted-local" },
          capabilities: { nativeTools: true, checkpoints: false, pty: false },
        })

        const diskText = yield* current.fileSystem.readFileString(current.filename)
        expect(diskText).not.toContain("installation-token")
        expect(diskText).not.toContain("access_token")
        expect(diskText).not.toContain("secret")
        expect(diskText).not.toContain("accessToken")
        expect(diskText).not.toContain("refreshToken")
        expect(diskText).not.toContain("clientId")
        const disk = yield* Schema.decodeEffect(Schema.fromJsonString(InstallationDisk))(diskText)
        expect(Object.keys(disk.checkouts)).toEqual([first.checkoutFingerprint])
        const info = yield* current.fileSystem.stat(current.filename)
        expect(info.mode & 0o777).toBe(0o600)

        current.updateRepository({ headRevision: "second-head", branch: "feature" })
        const second = yield* current.installation.prepare({ deviceId: "device-1", workspace: current.workspace })
        expect(second.checkoutFingerprint).toBe(first.checkoutFingerprint)
        expect(second.workspaceIdentity).toBe(first.workspaceIdentity)
        expect(second.profile.repository).toMatchObject({ headRevision: "second-head", branch: "feature" })

        const retainedIdentity = "runner:retained-workspace"
        yield* current.fileSystem.writeFileString(
          current.filename,
          yield* Schema.encodeEffect(Schema.fromJsonString(InstallationDisk))({
            formatVersion: 1,
            checkouts: { [first.checkoutFingerprint]: { workspaceIdentity: retainedIdentity } },
          }),
        )
        const retained = yield* current.installation.prepare({ deviceId: "device-1", workspace: current.workspace })
        expect(retained.workspaceIdentity).toBe(retainedIdentity)
        expect(retained.profile.workspaceIdentity).toBe(retainedIdentity)
      }),
    ),
  )

  test.effect("rejects corrupt retained installation state instead of replacing workspace authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture()
        yield* current.fileSystem.writeFileString(current.filename, "not-json")
        const error = yield* Effect.flip(
          current.installation.prepare({ deviceId: "device-1", workspace: current.workspace }),
        )
        expect(error).toMatchObject({ kind: "storage", message: "Installation state is corrupt" })
        expect(yield* current.fileSystem.readFileString(current.filename)).toBe("not-json")
      }),
    ),
  )
})
