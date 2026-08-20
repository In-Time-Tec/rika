import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as ReleaseUpdate from "../src/release/release-update"

const digestOf = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const releaseApiUrl = "https://releases.test/api/latest"
const releaseBaseUrl = "https://releases.test/download"

interface StubRoute {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
}

const stubFetch = (routes: Readonly<Record<string, StubRoute>>, seen: Array<string>): typeof globalThis.fetch => {
  const handler = (input: string | URL | Request) => {
    let url: string
    if (typeof input === "string") url = input
    else if (input instanceof URL) url = input.toString()
    else url = input.url
    seen.push(url)
    const route = routes[url]
    if (route === undefined) return Promise.reject(new TypeError(`fetch failed: ${url}`))
    return Promise.resolve(
      new Response(route.body ?? "", { status: route.status ?? 200, headers: { ...route.headers } }),
    )
  }
  return Object.assign(handler, { preconnect: globalThis.fetch.preconnect })
}

const withPlatform = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const context = yield* Layer.buildWithScope(Layer.merge(BunServices.layer, FetchHttpClient.layer), scope)
      return yield* Effect.provide(body, context)
    }),
  )

const runUpdate = (options: {
  readonly currentVersion: string
  readonly executable: string
  readonly host?: Parameters<typeof ReleaseUpdate.hostReleaseTarget>[0]
  readonly environment: Readonly<Record<string, string>>
  readonly routes: Readonly<Record<string, StubRoute>>
  readonly seen: Array<string>
}) =>
  Effect.result(
    ReleaseUpdate.update({
      currentVersion: options.currentVersion,
      executable: options.executable,
      host: options.host ?? { platform: "linux", architecture: "x64" },
    }),
  ).pipe(
    Effect.provideService(FetchHttpClient.Fetch, stubFetch(options.routes, options.seen)),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: options.environment })),
  )

const installedRoot = Effect.fn("ReleaseUpdateTest.installedRoot")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix })
  const installRoot = path.join(root, "current")
  yield* fileSystem.makeDirectory(path.join(installRoot, "bin"), { recursive: true })
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", "rika"), "installed rika")
  return { root, installRoot, binary: path.join(installRoot, "bin", "rika") }
})

it("maps supported hosts to release targets and rejects the rest", () => {
  expect(ReleaseUpdate.hostReleaseTarget({ platform: "darwin", architecture: "arm64" })).toBe("darwin-arm64")
  expect(ReleaseUpdate.hostReleaseTarget({ platform: "Linux", architecture: "x86_64" })).toBe("linux-x64")
  expect(ReleaseUpdate.hostReleaseTarget({ platform: "linux", architecture: "aarch64" })).toBe("linux-arm64")
  expect(ReleaseUpdate.hostReleaseTarget({ platform: "darwin", architecture: "x64" })).toBeUndefined()
  expect(ReleaseUpdate.hostReleaseTarget({ platform: "win32", architecture: "x64" })).toBeUndefined()
  expect(ReleaseUpdate.hostReleaseTarget({ platform: "linux", architecture: "riscv64" })).toBeUndefined()
})

it("treats only a strictly newer published version as an available update", () => {
  expect(ReleaseUpdate.updateAvailable({ current: "0.0.3", latest: "0.0.4" })).toBe(true)
  expect(ReleaseUpdate.updateAvailable({ current: "0.0.4", latest: "0.0.4" })).toBe(false)
  expect(ReleaseUpdate.updateAvailable({ current: "0.1.0", latest: "0.0.9" })).toBe(false)
  expect(ReleaseUpdate.updateAvailable({ current: "1.2", latest: "1.2.0" })).toBe(false)
  expect(ReleaseUpdate.updateAvailable({ current: "1.2", latest: "1.2.1" })).toBe(true)
  expect(ReleaseUpdate.updateAvailable({ current: "0.0.0-dev", latest: "0.0.4" })).toBe(true)
  expect(ReleaseUpdate.releaseVersion("v0.0.4")).toBe("0.0.4")
  expect(ReleaseUpdate.releaseVersion("0.0.4")).toBe("0.0.4")
})

it("reads one published checksum per artifact and ignores unrelated or malformed rows", () => {
  const checksums = [
    `${"a".repeat(64)}  rika-1.0.0-darwin-arm64.tar.gz`,
    `${"b".repeat(64)} *rika-1.0.0-linux-x64.tar.gz`,
    "not-a-digest  rika-1.0.0-linux-arm64.tar.gz",
    "",
  ].join("\n")
  expect(ReleaseUpdate.publishedChecksum({ checksums, file: "rika-1.0.0-darwin-arm64.tar.gz" })).toBe("a".repeat(64))
  expect(ReleaseUpdate.publishedChecksum({ checksums, file: "rika-1.0.0-linux-x64.tar.gz" })).toBe("b".repeat(64))
  expect(ReleaseUpdate.publishedChecksum({ checksums, file: "rika-1.0.0-linux-arm64.tar.gz" })).toBeUndefined()
  expect(ReleaseUpdate.publishedChecksum({ checksums, file: "rika-9.9.9-linux-x64.tar.gz" })).toBeUndefined()
})

it("reports the current version, the target version, and the outcome", () => {
  const current = ReleaseUpdate.updateReport({ _tag: "AlreadyCurrent", current: "0.0.4", latest: "0.0.4" })
  expect(current).toContain("Current version: 0.0.4")
  expect(current).toContain("Latest release: 0.0.4")
  expect(current).toContain("Already up to date")
  const updated = ReleaseUpdate.updateReport({
    _tag: "Updated",
    current: "0.0.3",
    latest: "0.0.4",
    installRoot: "/install/current",
  })
  expect(updated).toContain("Current version: 0.0.3")
  expect(updated).toContain("Latest release: 0.0.4")
  expect(updated).toContain("/install/current")
})

it.effect("refuses an unsupported platform before touching the network", () =>
  withPlatform(
    Effect.gen(function* () {
      const seen: Array<string> = []
      const result = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: "/install/current/bin/rika",
        host: { platform: "win32", architecture: "x64" },
        environment: {},
        routes: {},
        seen,
      })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.failure).toBe("unsupported-platform")
        expect(result.failure.message).toContain("win32-x64")
        expect(result.failure.message).toContain("darwin-arm64")
      }
      expect(seen).toEqual([])
    }),
  ),
)

it.effect("stops before downloading when the running version is already the latest release", () =>
  withPlatform(
    Effect.gen(function* () {
      const install = yield* installedRoot("rika-update-current-")
      const seen: Array<string> = []
      const result = yield* runUpdate({
        currentVersion: "0.0.4",
        executable: install.binary,
        environment: { RIKA_INSTALL_ROOT: install.installRoot, RIKA_RELEASE_API_URL: releaseApiUrl },
        routes: { [releaseApiUrl]: { body: '{"tag_name":"v0.0.4"}' } },
        seen,
      })
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.success).toEqual({ _tag: "AlreadyCurrent", current: "0.0.4", latest: "0.0.4" })
      }
      expect(seen).toEqual([releaseApiUrl])
    }),
  ),
)

it.effect("downloads, verifies, and reports an available upgrade without extracting a tampered artifact", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const install = yield* installedRoot("rika-update-tampered-")
      const archiveFile = ReleaseUpdate.archiveFileName("0.0.4", "linux-x64")
      const honest = new TextEncoder().encode("the published archive")
      const tampered = new TextEncoder().encode("the tampered archive")
      const seen: Array<string> = []
      const result = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: install.binary,
        environment: {
          RIKA_INSTALL_ROOT: install.installRoot,
          RIKA_RELEASE_API_URL: releaseApiUrl,
          RIKA_RELEASE_BASE_URL: releaseBaseUrl,
        },
        routes: {
          [releaseApiUrl]: { body: '{"tag_name":"v0.0.4"}' },
          [`${releaseBaseUrl}/SHA256SUMS`]: { body: `${digestOf(honest)}  ${archiveFile}\n` },
          [`${releaseBaseUrl}/${archiveFile}`]: { body: tampered },
        },
        seen,
      })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.failure).toBe("checksum-mismatch")
        expect(result.failure.message).toContain(digestOf(honest))
        expect(result.failure.message).toContain(digestOf(tampered))
        expect(result.failure.message).toContain("left unchanged")
      }
      expect(seen).toEqual([releaseApiUrl, `${releaseBaseUrl}/SHA256SUMS`, `${releaseBaseUrl}/${archiveFile}`])
      expect(yield* fileSystem.readFileString(install.binary)).toBe("installed rika")
      expect(yield* fileSystem.readDirectory(install.root)).toEqual(["current"])
    }),
  ),
)

it.effect("reports a lost network without changing the install", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const install = yield* installedRoot("rika-update-offline-")
      const seen: Array<string> = []
      const result = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: install.binary,
        environment: { RIKA_INSTALL_ROOT: install.installRoot, RIKA_RELEASE_API_URL: releaseApiUrl },
        routes: {},
        seen,
      })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.failure).toBe("network")
        expect(result.failure.message).toContain("network connection")
      }
      expect(yield* fileSystem.readFileString(install.binary)).toBe("installed rika")
    }),
  ),
)

it.effect("names the GitHub rate limit instead of reporting a generic failure", () =>
  withPlatform(
    Effect.gen(function* () {
      const install = yield* installedRoot("rika-update-ratelimit-")
      const seen: Array<string> = []
      const result = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: install.binary,
        environment: { RIKA_INSTALL_ROOT: install.installRoot, RIKA_RELEASE_API_URL: releaseApiUrl },
        routes: {
          [releaseApiUrl]: { status: 403, headers: { "x-ratelimit-remaining": "0" }, body: '{"message":"limit"}' },
        },
        seen,
      })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.failure).toBe("rate-limited")
        expect(result.failure.message).toContain("rate limit")
      }
    }),
  ),
)

it.effect("separates an unreachable release from an artifact the release does not publish", () =>
  withPlatform(
    Effect.gen(function* () {
      const install = yield* installedRoot("rika-update-missing-")
      const environment = {
        RIKA_INSTALL_ROOT: install.installRoot,
        RIKA_RELEASE_API_URL: releaseApiUrl,
        RIKA_RELEASE_BASE_URL: releaseBaseUrl,
      }
      const seen: Array<string> = []
      const unavailable = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: install.binary,
        environment,
        routes: { [releaseApiUrl]: { status: 404, body: '{"message":"Not Found"}' } },
        seen,
      })
      expect(unavailable._tag).toBe("Failure")
      if (unavailable._tag === "Failure") expect(unavailable.failure.failure).toBe("release-unavailable")

      const otherTarget = ReleaseUpdate.archiveFileName("0.0.4", "darwin-arm64")
      const missing = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: install.binary,
        environment,
        routes: {
          [releaseApiUrl]: { body: '{"tag_name":"v0.0.4"}' },
          [`${releaseBaseUrl}/SHA256SUMS`]: { body: `${"c".repeat(64)}  ${otherTarget}\n` },
        },
        seen,
      })
      expect(missing._tag).toBe("Failure")
      if (missing._tag === "Failure") {
        expect(missing.failure.failure).toBe("artifact-missing")
        expect(missing.failure.message).toContain(ReleaseUpdate.archiveFileName("0.0.4", "linux-x64"))
      }
    }),
  ),
)

it.effect("refuses to replace an install this binary does not own", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-update-unmanaged-" })
      const seen: Array<string> = []
      const empty = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: path.join(root, "current", "bin", "rika"),
        environment: { RIKA_INSTALL_ROOT: path.join(root, "current"), RIKA_RELEASE_API_URL: releaseApiUrl },
        routes: {},
        seen,
      })
      expect(empty._tag).toBe("Failure")
      if (empty._tag === "Failure") {
        expect(empty.failure.failure).toBe("unmanaged-install")
        expect(empty.failure.message).toContain("install.sh")
      }

      const packaged = path.join(root, "node_modules", "@rikafx", "cli-linux-x64")
      yield* fileSystem.makeDirectory(path.join(packaged, "bin"), { recursive: true })
      yield* fileSystem.writeFileString(path.join(packaged, "bin", "rika"), "npm rika")
      const fromNpm = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: path.join(packaged, "bin", "rika"),
        environment: { RIKA_RELEASE_API_URL: releaseApiUrl },
        routes: {},
        seen,
      })
      expect(fromNpm._tag).toBe("Failure")
      if (fromNpm._tag === "Failure") {
        expect(fromNpm.failure.failure).toBe("unmanaged-install")
        expect(fromNpm.failure.message).toContain("npm install -g @rikafx/cli@latest")
      }

      const development = path.join(root, ".local", "share", "rika-dev", "current")
      yield* fileSystem.makeDirectory(path.join(development, "bin"), { recursive: true })
      yield* fileSystem.writeFileString(path.join(development, "bin", "rika"), "dev rika")
      const fromSource = yield* runUpdate({
        currentVersion: "0.0.3",
        executable: path.join(development, "bin", "rika"),
        environment: { RIKA_RELEASE_API_URL: releaseApiUrl },
        routes: {},
        seen,
      })
      expect(fromSource._tag).toBe("Failure")
      if (fromSource._tag === "Failure") {
        expect(fromSource.failure.failure).toBe("unmanaged-install")
        expect(fromSource.failure.message).toContain("bun run install-local")
      }
      expect(seen).toEqual([])
    }),
  ),
)
