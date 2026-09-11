/* oxlint-disable effecttsgo/async-function -- the fixture uses the foreign filesystem test boundary. */
/* oxlint-disable effecttsgo/strict-effect-provide -- the credential fixture installs TestClock at its test boundary. */
/* oxlint-disable effecttsgo/global-date-in-effect -- fixture expiry is intentionally relative to the current process. */
/* oxlint-disable effecttsgo/prefer-schema-over-json -- the assertion decodes a JOSE payload for transport evidence. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture narrowing is backed by provided services and decoded JOSE shape. */
/* oxlint-disable effecttsgo/any-unknown-in-error-context -- foreign filesystem and schema fixtures use broad test boundaries. */
/* oxlint-disable effecttsgo/unknown-in-effect-catch -- temporary filesystem fixture setup is outside the product error boundary. */
/* oxlint-disable effecttsgo/node-builtin-import -- temporary files are isolated test fixtures. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- this fixture provides the concrete Bun service context. */
/* oxlint-disable effecttsgo/unsafe-effect-type-assertion -- this fixture supplies the concrete Bun service context. */
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Buffer } from "node:buffer"
// ast-grep-ignore: effect-prefer-filesystem -- temporary fixture files are isolated from product file operations.
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
// ast-grep-ignore: effect-prefer-path -- temporary fixture paths are assembled at the outer test boundary.
import { join } from "node:path"
import { makeFileCredentialAuth } from "../src/credentials"

const credentialProgram = (Effect.acquireUseRelease(
    // ast-grep-ignore: effect-prefer-program-construction -- temporary fixture setup is a foreign filesystem boundary.
    Effect.tryPromise(async () => {
      const home = await mkdtemp(join(tmpdir(), "rika-client-v2-"))
      await mkdir(join(home, ".config", "rika"), { recursive: true, mode: 0o700 })
      const generated = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
      const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", generated.privateKey)
      const profile = JSON.stringify({ formatVersion: 3, origin: "https://rika.test", deviceId: "device", clientId: "client" })
      const credential = JSON.stringify({
        formatVersion: 2,
        origin: "https://rika.test",
        deviceId: "device",
        refreshToken: "refresh",
        privateJwk,
        accessToken: "access",
        // ast-grep-ignore: effect-prefer-clock -- fixture expiry intentionally uses the current process time.
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1_000,
      })
      const config = join(home, ".config", "rika")
      await writeFile(join(config, "hosted.json"), profile, { mode: 0o600 })
      await writeFile(join(config, "hosted-credential.json"), credential, { mode: 0o600 })
      await chmod(config, 0o700)
      return { home, cleanup: () => rm(home, { recursive: true, force: true }) }
    }),
    (fixture) =>
      Effect.gen(function* () {
        const auth = yield* makeFileCredentialAuth({ origin: "https://rika.test", home: fixture.home, fetch: globalThis.fetch })
        expect(auth.deviceId).toBe("device")
        expect(auth.clientId).toBe("client")
        const headers = yield* auth.requestHeaders!({ method: "GET", url: "https://rika.test/api/v1/me/context?page=2#ignored" })
        expect(headers.authorization).toBe("DPoP access")
        expect(headers.dpop).toBeTypeOf("string")
        const parts = headers.dpop!.split(".")
        expect(parts).toHaveLength(3)
        // ast-grep-ignore: effect-prefer-schema-json -- the test decodes a compact JOSE payload for transport evidence.
        const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { htu: string; htm: string; ath: string }
        expect(payload.htu).toBe("https://rika.test/api/v1/me/context")
        expect(payload.htm).toBe("GET")
        expect(payload.ath).toBeTypeOf("string")
        const webSocketHeaders = yield* auth.webSocketHeaders!({ method: "GET", url: "wss://rika.test/sessions/root/ws?cursor=4" })
        expect(webSocketHeaders.authorization).toBe("DPoP access")
        expect(webSocketHeaders.dpop).toBeTypeOf("string")
        // ast-grep-ignore: effect-prefer-schema-json -- the test decodes a compact JOSE payload for transport evidence.
        const webSocketPayload = JSON.parse(
          Buffer.from(webSocketHeaders.dpop!.split(".")[1]!, "base64url").toString("utf8"),
        ) as { htu: string; htm: string; ath: string }
        expect(webSocketPayload.htu).toBe("https://rika.test/sessions/root/ws")
        expect(webSocketPayload.htm).toBe("GET")
        expect(webSocketPayload.ath).toBeTypeOf("string")
      }),
        // ast-grep-ignore: effect-prefer-promise-composition -- temporary fixture cleanup is a foreign filesystem boundary.
        (fixture) => Effect.promise(fixture.cleanup),
    )
) as Effect.Effect<void, unknown, BunServices.BunServices | Scope.Scope>

it.effect("reads the existing CLI credential files and signs HTTP DPoP without argv tokens", () =>
  Effect.scoped(
    Layer.build(BunServices.layer).pipe(
      Effect.flatMap((services) => Effect.provide(credentialProgram, services)),
    ),
  ),
)

it.effect("refreshes lazily once for concurrent HTTP and WebSocket requests", () =>
  Effect.provide(
    Effect.scoped(
      Effect.gen(function* () {
      const services = yield* Layer.build(BunServices.layer)
      // ast-grep-ignore: effect-prefer-program-construction -- temporary fixture setup is a foreign filesystem boundary.
      const fixture = yield* Effect.tryPromise(async () => {
        const home = await mkdtemp(join(tmpdir(), "rika-client-v2-refresh-"))
        const config = join(home, ".config", "rika")
        await mkdir(config, { recursive: true, mode: 0o700 })
        const generated = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
        const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", generated.privateKey)
        await writeFile(join(config, "hosted.json"), JSON.stringify({ formatVersion: 3, origin: "https://rika.test", deviceId: "device", clientId: "client" }), { mode: 0o600 })
        await writeFile(join(config, "hosted-credential.json"), JSON.stringify({ formatVersion: 1, origin: "https://rika.test", deviceId: "device", refreshToken: "refresh", privateJwk }), { mode: 0o600 })
        await chmod(config, 0o700)
        return { home, filename: join(config, "hosted-credential.json") }
      })
      let request: Request | undefined
      let refreshCalls = 0
      const auth = yield* makeFileCredentialAuth({
        origin: "https://rika.test",
        home: fixture.home,
        fetch: (input, init) => {
          refreshCalls += 1
          request = new Request(input instanceof Request ? input.url : String(input), init)
          // ast-grep-ignore: effect-prefer-promise-composition -- the fixture returns a Web Response from a foreign Fetch stub.
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: `refreshed-${refreshCalls}`, refresh_token: `next-refresh-${refreshCalls}`, expires_in: 3_600, token_type: "DPoP" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )
        },
      }).pipe(Effect.provide(services))
      const first = yield* auth.requestHeaders!({ method: "GET", url: "https://rika.test/api/v1/me/context" })
      expect(request?.url).toBe("https://rika.test/api/auth/oauth2/token")
      expect(request?.headers.get("dpop")).toBeTypeOf("string")
      expect(request?.headers.get("authorization")).toBeNull()
      expect(first).toMatchObject({ authorization: "DPoP refreshed-1" })
      expect(refreshCalls).toBe(1)
      yield* TestClock.adjust("1 hour")
      const [http, webSocket] = yield* Effect.all(
        [
          auth.requestHeaders!({ method: "GET", url: "https://rika.test/api/v1/me/context?page=2" }),
          auth.webSocketHeaders!({ method: "GET", url: "wss://rika.test/sessions/root/ws?cursor=4" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(refreshCalls).toBe(2)
      expect(http.authorization).toBe("DPoP refreshed-2")
      expect(webSocket.authorization).toBe("DPoP refreshed-2")
      expect(webSocket.dpop).toBeTypeOf("string")
      // ast-grep-ignore: effect-prefer-schema-json -- the test decodes a compact JOSE payload for transport evidence.
      const webSocketPayload = JSON.parse(
        Buffer.from(webSocket.dpop!.split(".")[1]!, "base64url").toString("utf8"),
      ) as { htu: string; htm: string; ath: string }
      expect(webSocketPayload.htu).toBe("https://rika.test/sessions/root/ws")
      expect(webSocketPayload.htm).toBe("GET")
      expect(webSocketPayload.ath).toBeTypeOf("string")
      const saved = yield* Effect.tryPromise(() => readFile(fixture.filename, "utf8"))
      expect(saved).toContain('"refreshToken":"next-refresh-2"')
      // ast-grep-ignore: effect-prefer-promise-composition -- temporary fixture cleanup is a foreign filesystem boundary.
      yield* Effect.promise(() => rm(fixture.home, { recursive: true, force: true }))
      }),
    ),
    TestClock.layer(),
  ),
)

it.effect("preserves the existing credential file when atomic rotation cannot write", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(BunServices.layer)
      // ast-grep-ignore: effect-prefer-program-construction -- temporary fixture setup is a foreign filesystem boundary.
      const fixture = yield* Effect.tryPromise(async () => {
        const home = await mkdtemp(join(tmpdir(), "rika-client-v2-atomic-"))
        const config = join(home, ".config", "rika")
        await mkdir(config, { recursive: true, mode: 0o700 })
        const generated = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
        const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", generated.privateKey)
        await writeFile(join(config, "hosted.json"), JSON.stringify({ formatVersion: 3, origin: "https://rika.test", deviceId: "device", clientId: "client" }), { mode: 0o600 })
        const filename = join(config, "hosted-credential.json")
        await writeFile(filename, JSON.stringify({ formatVersion: 1, origin: "https://rika.test", deviceId: "device", refreshToken: "refresh", privateJwk }), { mode: 0o600 })
        await chmod(config, 0o700)
        return { home, config, filename }
      })
      const auth = yield* makeFileCredentialAuth({
        origin: "https://rika.test",
        home: fixture.home,
        fetch: () =>
          // ast-grep-ignore: effect-prefer-promise-composition -- this fetch fixture returns a foreign Promise boundary.
          Promise.resolve(
            new Response(JSON.stringify({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 3_600, token_type: "DPoP" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
      }).pipe(Effect.provide(services))
      yield* Effect.tryPromise(() => chmod(fixture.config, 0o500))
      const failed = yield* Effect.exit(auth.requestHeaders!({ method: "GET", url: "https://rika.test/api/v1/me/context" }))
      expect(Exit.isFailure(failed)).toBe(true)
      yield* Effect.tryPromise(() => chmod(fixture.config, 0o700))
      const saved = yield* Effect.tryPromise(() => readFile(fixture.filename, "utf8"))
      expect(saved).toContain('"formatVersion":1')
      expect(saved).toContain('"refreshToken":"refresh"')
      // ast-grep-ignore: effect-prefer-promise-composition -- temporary fixture cleanup is a foreign filesystem boundary.
      yield* Effect.promise(() => rm(fixture.home, { recursive: true, force: true }))
    }),
  ),
)
