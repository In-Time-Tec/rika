import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as ReleaseUpdate from "../src/release/release-update"

const target = "linux-x64"
const latest = "0.0.4"
const releaseApiUrl = "https://releases.test/api/latest"
const releaseBaseUrl = "https://releases.test/download"
const archiveFile = ReleaseUpdate.archiveFileName(latest, target)

const digestOf = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const withPlatform = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const context = yield* Layer.buildWithScope(Layer.merge(BunServices.layer, FetchHttpClient.layer), scope)
      return yield* Effect.provide(body, context)
    }),
  )

const stubFetch = (routes: Readonly<Record<string, string | Uint8Array>>): typeof globalThis.fetch => {
  const handler = (input: string | URL | Request) => {
    let url: string
    if (typeof input === "string") url = input
    else if (input instanceof URL) url = input.toString()
    else url = input.url
    const body = routes[url]
    if (body === undefined) return Promise.reject(new TypeError(`fetch failed: ${url}`))
    return Promise.resolve(new Response(body))
  }
  return Object.assign(handler, { preconnect: globalThis.fetch.preconnect })
}

const buildArchive = Effect.fn("ReleaseUpdateProc.buildArchive")(function* (options: {
  readonly directory: string
  readonly withRuntime: boolean
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = ReleaseUpdate.archiveRootName(latest, target)
  const stage = path.join(options.directory, root)
  yield* fileSystem.makeDirectory(path.join(stage, "bin"), { recursive: true })
  yield* fileSystem.writeFileString(path.join(stage, "bin", "rika"), `rika ${latest}`, { mode: 0o755 })
  if (options.withRuntime) {
    yield* fileSystem.writeFileString(path.join(stage, "bin", ".rika-performance"), `performance ${latest}`, {
      mode: 0o755,
    })
    yield* fileSystem.writeFileString(path.join(stage, "bin", ".rika-interactive"), `interactive ${latest}`, {
      mode: 0o755,
    })
    yield* fileSystem.writeFileString(path.join(stage, "bin", ".rika-resident"), `resident ${latest}`, {
      mode: 0o755,
    })
  }
  const archive = path.join(options.directory, archiveFile)
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("tar", ["-czf", archive, root], { cwd: options.directory }),
  )
  expect(Number(exitCode)).toBe(0)
  const bytes = yield* fileSystem.readFile(archive)
  yield* fileSystem.remove(stage, { recursive: true, force: true })
  yield* fileSystem.remove(archive, { force: true })
  return bytes
})

const installed = Effect.fn("ReleaseUpdateProc.installed")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix })
  const installRoot = path.join(home, "share", "rika", "current")
  const binDirectory = path.join(home, "bin")
  yield* fileSystem.makeDirectory(path.join(installRoot, "bin"), { recursive: true })
  yield* fileSystem.makeDirectory(binDirectory, { recursive: true })
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", "rika"), "rika 0.0.3", { mode: 0o755 })
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-performance"), "performance 0.0.3", {
    mode: 0o755,
  })
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-interactive"), "interactive 0.0.3", {
    mode: 0o755,
  })
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-resident"), "resident 0.0.3", {
    mode: 0o755,
  })
  const command = path.join(binDirectory, "rika")
  yield* fileSystem.symlink(path.join(installRoot, "bin", "rika"), command)
  return { home, installRoot, command, binary: path.join(installRoot, "bin", "rika") }
})

const runUpdate = (options: {
  readonly installRoot: string
  readonly executable: string
  readonly routes: Readonly<Record<string, string | Uint8Array>>
}) =>
  Effect.result(
    ReleaseUpdate.update({
      currentVersion: "0.0.3",
      executable: options.executable,
      host: { platform: "linux", architecture: "x64" },
    }),
  ).pipe(
    Effect.provideService(FetchHttpClient.Fetch, stubFetch(options.routes)),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({
        env: {
          RIKA_INSTALL_ROOT: options.installRoot,
          RIKA_RELEASE_API_URL: releaseApiUrl,
          RIKA_RELEASE_BASE_URL: releaseBaseUrl,
        },
      }),
    ),
  )

it.effect("replaces a verified install in one rename and keeps the command on PATH working", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const install = yield* installed("rika-update-publish-")
      const workshop = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-update-archive-" })
      const archive = yield* buildArchive({ directory: workshop, withRuntime: true })
      const result = yield* runUpdate({
        installRoot: install.installRoot,
        executable: install.binary,
        routes: {
          [releaseApiUrl]: `{"tag_name":"v${latest}"}`,
          [`${releaseBaseUrl}/SHA256SUMS`]: `${digestOf(archive)}  ${archiveFile}\n`,
          [`${releaseBaseUrl}/${archiveFile}`]: archive,
        },
      })
      expect(result._tag).toBe("Success")
      if (result._tag === "Success")
        expect(result.success).toEqual({
          _tag: "Updated",
          current: "0.0.3",
          latest,
          installRoot: install.installRoot,
        })
      expect(yield* fileSystem.readFileString(install.binary)).toBe(`rika ${latest}`)
      expect(yield* fileSystem.readFileString(path.join(install.installRoot, "bin", ".rika-performance"))).toBe(
        `performance ${latest}`,
      )
      expect(yield* fileSystem.readFileString(path.join(install.installRoot, "bin", ".rika-interactive"))).toBe(
        `interactive ${latest}`,
      )
      expect(yield* fileSystem.readFileString(path.join(install.installRoot, "bin", ".rika-resident"))).toBe(
        `resident ${latest}`,
      )
      expect(yield* fileSystem.readFileString(install.command)).toBe(`rika ${latest}`)
      expect(yield* fileSystem.readDirectory(path.dirname(install.installRoot))).toEqual(["current"])
    }),
  ),
)

it.effect("leaves the working install in place when the downloaded archive has no payload", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const install = yield* installed("rika-update-rollback-")
      const workshop = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-update-archive-" })
      const archive = yield* buildArchive({ directory: workshop, withRuntime: false })
      const result = yield* runUpdate({
        installRoot: install.installRoot,
        executable: install.binary,
        routes: {
          [releaseApiUrl]: `{"tag_name":"v${latest}"}`,
          [`${releaseBaseUrl}/SHA256SUMS`]: `${digestOf(archive)}  ${archiveFile}\n`,
          [`${releaseBaseUrl}/${archiveFile}`]: archive,
        },
      })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.failure).toBe("install-failed")
        expect(result.failure.message).toContain("left unchanged")
      }
      expect(yield* fileSystem.readFileString(install.binary)).toBe("rika 0.0.3")
      expect(yield* fileSystem.readFileString(install.command)).toBe("rika 0.0.3")
      expect(yield* fileSystem.readDirectory(path.dirname(install.installRoot))).toEqual(["current"])
    }),
  ),
)
