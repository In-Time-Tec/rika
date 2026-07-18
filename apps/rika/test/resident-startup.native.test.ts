import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { fileURLToPath } from "node:url"
import { Clock, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { claimStartup } from "../src/resident-startup"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

test("elects exactly one startup owner from two hundred simultaneous claims", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-" })
        const lease = `${root}/resident.startup`
        const claims = yield* Effect.all(
          Array.from({ length: 200 }, () => claimStartup(lease, "identity")),
          { concurrency: "unbounded" },
        )
        const owners = claims.filter((claim) => claim._tag === "Owner")
        expect(owners).toHaveLength(1)
        expect(claims.filter((claim) => claim._tag === "Joiner")).toHaveLength(199)
        if (owners[0]?._tag === "Owner") yield* owners[0].release
        expect(yield* fs.exists(lease)).toBe(false)
      }),
    ),
  ))

test("reclaims a lease whose owning process is gone", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-stale-" })
        const lease = `${root}/resident.startup`
        yield* fs.writeFileString(
          lease,
          yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({
            identity: "identity",
            nonce: "stale",
            ownerPid: 99_999_999,
            processPid: 99_999_999,
            claimedAt: 0,
            expiresAt: 30_000,
          }),
        )
        const claim = yield* claimStartup(lease, "identity")
        expect(claim._tag).toBe("Owner")
        if (claim._tag === "Owner") yield* claim.release
      }),
    ),
  ))

test("releases an adopted lease with its current contents", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-adopted-" })
        const lease = `${root}/resident.startup`
        const owner = yield* claimStartup(lease, "identity")
        expect(owner._tag).toBe("Owner")
        if (owner._tag !== "Owner") return
        yield* owner.adopt(process.ppid)
        yield* owner.release
        expect(yield* fs.exists(lease)).toBe(false)
      }),
    ),
  ))

test("keeps an adopted live child lease for joiners until ready release", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-adopted-live-" })
        const lease = `${root}/resident.startup`
        const owner = yield* claimStartup(lease, "identity")
        expect(owner._tag).toBe("Owner")
        if (owner._tag !== "Owner") return
        yield* owner.adopt(process.ppid)
        expect((yield* claimStartup(lease, "identity"))._tag).toBe("Joiner")
        yield* owner.release
      }),
    ),
  ))

test("keeps an adopted owner lease until the owner releases it", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-running-owner-" })
        const lease = `${root}/resident.startup`
        const owner = yield* claimStartup(lease, "identity")
        expect(owner._tag).toBe("Owner")
        if (owner._tag !== "Owner") return
        yield* owner.adopt(process.pid)
        expect(
          yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(yield* fs.readFileString(lease)),
        ).toMatchObject({
          identity: "identity",
          processPid: process.pid,
        })
        expect((yield* claimStartup(lease, "identity"))._tag).toBe("Joiner")
        yield* owner.release
        expect(yield* fs.exists(lease)).toBe(false)
      }),
    ),
  ))

test("fails closed instead of replacing an expired lease owned by a live process", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-live-expired-" })
        const lease = `${root}/resident.startup`
        yield* fs.writeFileString(
          lease,
          yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({
            identity: "identity",
            nonce: "live-expired",
            ownerPid: process.pid,
            processPid: process.pid,
            claimedAt: 0,
            expiresAt: 1,
          }),
        )
        const result = yield* Effect.result(claimStartup(lease, "identity"))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.message).toContain("alive but startup expired")
        expect(yield* fs.exists(lease)).toBe(true)
      }),
    ),
  ))

test("reports an incompatible product database through resident startup without polling", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-database-" })
        const databasePath = `${root}/rika.db`
        const relayPath = `${root}/relay.db`
        yield* Effect.sync(() => {
          const database = new NativeDatabase(databasePath)
          database.exec("CREATE TABLE old_sessions (id TEXT PRIMARY KEY)")
          database.close()
        })
        const before = yield* fs.readFile(databasePath)
        const startedAt = yield* Clock.currentTimeMillis
        const handle = yield* spawner.spawn(
          ChildProcess.make("bun", ["src/client-main.ts", "doctor"], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            extendEnv: true,
            env: {
              HOME: root,
              RIKA_DATABASE: databasePath,
              RIKA_RELAY_DATABASE: relayPath,
            },
          }),
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: 3 },
        ).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              handle
                .kill({ killSignal: "SIGKILL" })
                .pipe(Effect.ignore, Effect.andThen(Effect.fail("resident startup did not fail promptly"))),
          }),
        )
        expect(Number(exitCode)).not.toBe(0)
        expect(`${stdout}\n${stderr}`).toContain("Use a fresh Rika data root")
        expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(2_000)
        expect([...(yield* fs.readFile(databasePath))]).toEqual([...before])
        expect((yield* fs.readDirectory(root)).some((name) => name.endsWith(".startup"))).toBe(false)
      }),
    ),
  ))
