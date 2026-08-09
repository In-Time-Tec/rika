import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import * as ServerHandshake from "@rika/product/server-service-handshake"
import { Effect, FileSystem, Layer, Option, Path, Schema, Scope } from "effect"
import * as ServerEndpoint from "../src/server/process/server-endpoint"

const provide = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const validToken = "a".repeat(64)

const writeFixture = Effect.fn("ServerEndpointTest.writeFixture")(function* (
  profile: string,
  dataRoot: string,
  overrides: Partial<ServerEndpoint.ServerPublication> = {},
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const endpoint = yield* ServerEndpoint.resolve(profile, dataRoot)
  yield* fs.writeFileString(endpoint.tokenPath, `${validToken}\n`, { mode: 0o600 })
  const publication = {
    port: endpoint.port,
    pid: process.pid,
    tokenPath: endpoint.tokenPath,
    version: "0.3.17",
    protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
    ...overrides,
  }
  yield* fs.writeFileString(path.join(endpoint.canonicalDataRoot, "server.json"), `${encodeJson(publication)}\n`, {
    mode: 0o600,
  })
  return endpoint
})

const expectPublicationFailure = <A, R>(
  effect: Effect.Effect<A, ServerEndpoint.ServerPublicationError, R>,
  reason: ServerEndpoint.ServerPublicationError["reason"],
) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect)
    expect(failure._tag).toBe("ServerPublicationError")
    expect(failure.reason).toBe(reason)
  })

const expectUnsafeToken = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect)
    expect(failure.reason).toBe("unsafe-token")
  })

describe("server endpoint ownership", () => {
  it.effect("coalesces profile spelling and data-root aliases into one canonical publication owner", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-endpoint-" })
        const root = `${parent}/root`
        const alias = `${parent}/alias`
        yield* fs.makeDirectory(root)
        yield* fs.symlink(root, alias)
        const endpoint = yield* writeFixture("default", root)

        const [canonical, equivalent] = yield* Effect.all([
          ServerEndpoint.readPublished({ profile: "default", dataRoot: root }),
          ServerEndpoint.readPublished({ profile: "  DEFAULT  ", dataRoot: alias }),
        ])

        expect(equivalent).toEqual(canonical)
        expect(canonical.endpoint).toEqual(endpoint)
        expect(canonical.token).toBe(validToken)
        expect(canonical.endpoint.url).toBe(`ws://127.0.0.1:${endpoint.port}/server`)
        expect(canonical.publication.tokenPath).toBe(endpoint.tokenPath)
      }),
    ),
  )

  it.effect("distinguishes unavailable publication from invalid JSON and schema", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-publication-" })
        const missing = `${parent}/missing`
        yield* fs.makeDirectory(missing)
        yield* expectPublicationFailure(
          ServerEndpoint.readPublished({ profile: "default", dataRoot: missing }),
          "unavailable",
        )

        const root = `${parent}/invalid`
        yield* fs.makeDirectory(root)
        const endpoint = yield* ServerEndpoint.resolve("default", root)
        const publicationPath = path.join(endpoint.canonicalDataRoot, "server.json")
        yield* fs.writeFileString(publicationPath, "{", { mode: 0o600 })
        yield* expectPublicationFailure(ServerEndpoint.readPublished({ profile: "default", dataRoot: root }), "invalid")

        yield* fs.writeFileString(publicationPath, encodeJson({ port: endpoint.port }), { mode: 0o600 })
        yield* expectPublicationFailure(ServerEndpoint.readPublished({ profile: "default", dataRoot: root }), "invalid")
      }),
    ),
  )

  it.effect("rejects invalid publication invariants", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-publication-invalid-" })
        const cases: ReadonlyArray<{
          readonly name: string
          readonly override: (endpoint: ServerEndpoint.ServerEndpoint) => Partial<ServerEndpoint.ServerPublication>
        }> = [
          { name: "zero-pid", override: () => ({ pid: 0 }) },
          { name: "negative-pid", override: () => ({ pid: -1 }) },
          { name: "unsafe-pid", override: () => ({ pid: Number.MAX_SAFE_INTEGER + 1 }) },
          { name: "empty-version", override: () => ({ version: "" }) },
          { name: "blank-version", override: () => ({ version: "   " }) },
          { name: "long-version", override: () => ({ version: "v".repeat(1_025) }) },
          { name: "zero-port", override: () => ({ port: 0 }) },
          { name: "out-of-range-port", override: () => ({ port: 65_536 }) },
          { name: "different-port", override: (endpoint) => ({ port: endpoint.port + 1 }) },
          { name: "different-token", override: (endpoint) => ({ tokenPath: `${endpoint.tokenPath}.other` }) },
        ]

        for (const testCase of cases) {
          const root = `${parent}/${testCase.name}`
          yield* fs.makeDirectory(root)
          const endpoint = yield* ServerEndpoint.resolve("default", root)
          yield* writeFixture("default", root, testCase.override(endpoint))
          yield* expectPublicationFailure(
            ServerEndpoint.readPublished({ profile: "default", dataRoot: root }),
            "invalid",
          )
        }
      }),
    ),
  )

  it.effect("rejects incompatible publication protocol", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-publication-protocol-" })
        yield* writeFixture("default", root, {
          protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion + 1,
        })
        yield* expectPublicationFailure(
          ServerEndpoint.readPublished({ profile: "default", dataRoot: root }),
          "incompatible",
        )
      }),
    ),
  )

  it.effect("rejects symlink, non-file, oversized, and permissive publications", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-publication-unsafe-" })

        const symlinkRoot = `${parent}/symlink`
        yield* fs.makeDirectory(symlinkRoot)
        const symlinkEndpoint = yield* ServerEndpoint.resolve("default", symlinkRoot)
        const target = `${parent}/publication-target`
        yield* fs.writeFileString(target, encodeJson({}), { mode: 0o600 })
        yield* fs.symlink(target, path.join(symlinkEndpoint.canonicalDataRoot, "server.json"))
        yield* expectPublicationFailure(
          ServerEndpoint.readPublished({ profile: "default", dataRoot: symlinkRoot }),
          "unsafe",
        )

        const directoryRoot = `${parent}/directory`
        yield* fs.makeDirectory(directoryRoot)
        const directoryEndpoint = yield* ServerEndpoint.resolve("default", directoryRoot)
        yield* fs.makeDirectory(path.join(directoryEndpoint.canonicalDataRoot, "server.json"))
        yield* expectPublicationFailure(
          ServerEndpoint.readPublished({ profile: "default", dataRoot: directoryRoot }),
          "unsafe",
        )

        const oversizedRoot = `${parent}/oversized`
        yield* fs.makeDirectory(oversizedRoot)
        const oversizedEndpoint = yield* ServerEndpoint.resolve("default", oversizedRoot)
        yield* fs.writeFileString(
          path.join(oversizedEndpoint.canonicalDataRoot, "server.json"),
          "x".repeat(16 * 1_024 + 1),
          { mode: 0o600 },
        )
        yield* expectPublicationFailure(
          ServerEndpoint.readPublished({ profile: "default", dataRoot: oversizedRoot }),
          "unsafe",
        )

        const permissiveRoot = `${parent}/permissive`
        yield* fs.makeDirectory(permissiveRoot)
        const permissiveEndpoint = yield* writeFixture("default", permissiveRoot)
        yield* fs.chmod(path.join(permissiveEndpoint.canonicalDataRoot, "server.json"), 0o644)
        yield* expectPublicationFailure(
          ServerEndpoint.readPublished({ profile: "default", dataRoot: permissiveRoot }),
          "unsafe",
        )
      }),
    ),
  )

  it.effect("rejects publication owner and identity changes during the read", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-publication-race-" })
        const endpoint = yield* writeFixture("default", root)
        const publicationPath = path.join(endpoint.canonicalDataRoot, "server.json")
        let publicationStats = 0
        const changed = FileSystem.FileSystem.of({
          ...fs,
          stat: (filename) =>
            fs.stat(filename).pipe(
              Effect.map((info) => {
                if (filename !== publicationPath || ++publicationStats !== 2) return info
                return { ...info, ino: Option.map(info.ino, (ino) => ino + 1) }
              }),
            ),
        })

        yield* expectPublicationFailure(
          ServerEndpoint.readPublished({ profile: "default", dataRoot: root }).pipe(
            Effect.provideService(FileSystem.FileSystem, changed),
          ),
          "unsafe",
        )
        if (typeof process.getuid === "function") {
          const wrongOwner = FileSystem.FileSystem.of({
            ...fs,
            stat: (filename) =>
              fs
                .stat(filename)
                .pipe(
                  Effect.map((info) =>
                    filename === publicationPath ? { ...info, uid: Option.some(process.getuid() + 1) } : info,
                  ),
                ),
          })
          yield* expectPublicationFailure(
            ServerEndpoint.readPublished({ profile: "default", dataRoot: root }).pipe(
              Effect.provideService(FileSystem.FileSystem, wrongOwner),
            ),
            "unsafe",
          )
        }
      }),
    ),
  )

  it.effect("reads only safe fixed-shape tokens", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-token-" })
        const valid = `${parent}/valid`
        yield* fs.writeFileString(valid, `${validToken}\n`, { mode: 0o600 })
        expect(yield* ServerEndpoint.readToken(valid)).toBe(validToken)

        const target = `${parent}/target`
        const link = `${parent}/link`
        yield* fs.writeFileString(target, validToken, { mode: 0o600 })
        yield* fs.symlink(target, link)
        yield* expectUnsafeToken(ServerEndpoint.readToken(link))

        const permissive = `${parent}/permissive`
        yield* fs.writeFileString(permissive, validToken, { mode: 0o644 })
        yield* expectUnsafeToken(ServerEndpoint.readToken(permissive))

        for (const [name, token] of [
          ["empty", ""],
          ["short", "a".repeat(63)],
          ["non-hex", "g".repeat(64)],
          ["uppercase", "A".repeat(64)],
        ] as const) {
          const tokenPath = `${parent}/${name}`
          yield* fs.writeFileString(tokenPath, token, { mode: 0o600 })
          yield* expectUnsafeToken(ServerEndpoint.readToken(tokenPath))
        }
      }),
    ),
  )

  it.effect("creates one 0600 token and validates the same credential on reuse", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-token-create-" })
        const tokenPath = `${parent}/server.token`

        const first = yield* ServerEndpoint.readOrCreateToken(tokenPath)
        const second = yield* ServerEndpoint.readOrCreateToken(tokenPath)
        const info = yield* fs.stat(tokenPath)

        expect(first).toMatch(/^[a-f0-9]{64}$/)
        expect(second).toBe(first)
        expect((info.mode & 0o777).toString(8)).toBe("600")
        expect((yield* fs.readFileString(tokenPath)).trim()).toBe(first)
      }),
    ),
  )

  it.effect("does not create a missing credential while reading a publication", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-server-token-missing-" })
        const endpoint = yield* writeFixture("default", root)
        yield* fs.remove(endpoint.tokenPath)

        yield* expectUnsafeToken(ServerEndpoint.readPublished({ profile: "default", dataRoot: root }))
        expect(yield* fs.exists(endpoint.tokenPath)).toBe(false)
      }),
    ),
  )
})
