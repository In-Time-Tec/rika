import * as BunServices from "@effect/platform-bun/BunServices"
import { Clock, Config, Deferred, Effect, Fiber, FileSystem, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
// Independent OS observations must not depend on the process adapter under test.
// ast-grep-ignore: effect-prefer-child-process
import { execFileSync } from "node:child_process" // oxlint-disable-line effecttsgo/node-builtin-import
// ast-grep-ignore: effect-prefer-filesystem
import { readFileSync, readdirSync } from "node:fs" // oxlint-disable-line effecttsgo/node-builtin-import
import { expect, test } from "vitest"
import * as ProcessRegistry from "../../src/tool/process-registry"
import { provide } from "./support"

const alive = (pid: number) => {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()
    return state !== "" && !state.startsWith("Z")
  } catch {
    return false
  }
}

for (const cleanup of ["cancel", "scope", "completion"] as const) {
  for (const resistant of [false, true]) {
    test(`${cleanup} stops a ${resistant ? "TERM-resistant" : "normal"} child after its shell exits early`, () => {
      let child = 0
      let grandchild = 0
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "rika-process-registry-" })
            yield* fs.writeFileString(
              `${cwd}/child.sh`,
              `${resistant ? "trap '' TERM" : "trap 'exit 0' TERM"}\nsleep 60 &\necho $! > grandchild.pid\necho $$ > child.pid\nwait\n`,
            )
            yield* Effect.scoped(
              Effect.gen(function* () {
                const registry = yield* ProcessRegistry.Service
                const command =
                  cleanup === "completion"
                    ? "sh child.sh & while [ ! -f child.pid ]; do sleep 0.01; done; exit 0"
                    : "trap 'exit 0' TERM; sh child.sh & wait"
                const id = yield* registry.start("/bin/sh", ["-c", command], cwd)
                yield* Effect.tryPromise(() =>
                  expect
                    .poll(() => {
                      try {
                        child = Number(readFileSync(`${cwd}/child.pid`, "utf8"))
                        grandchild = Number(readFileSync(`${cwd}/grandchild.pid`, "utf8"))
                        return child > 0 && grandchild > 0
                      } catch {
                        return false
                      }
                    })
                    .toBe(true),
                )
                if (cleanup !== "completion") {
                  expect(alive(child)).toBe(true)
                  expect(alive(grandchild)).toBe(true)
                }
                if (cleanup === "cancel") {
                  yield* registry.cancel(id)
                  yield* Effect.tryPromise(() => expect.poll(() => alive(child), { timeout: 1_000 }).toBe(false))
                }
                if (cleanup === "completion") {
                  expect(yield* registry.poll(id, 2_000, 100)).toMatchObject({ running: false, exitCode: 0 })
                  yield* Effect.tryPromise(() => expect.poll(() => alive(child), { timeout: 1_000 }).toBe(false))
                }
              }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer)))),
            )
            yield* Effect.tryPromise(() => expect.poll(() => alive(child), { timeout: 1_000 }).toBe(false))
            yield* Effect.tryPromise(() => expect.poll(() => alive(grandchild), { timeout: 1_000 }).toBe(false))
          }).pipe(provide(BunServices.layer)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (child > 0 && alive(child)) process.kill(child, "SIGKILL")
              if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, "SIGKILL")
            }),
          ),
        ),
      )
    })
  }
}

test("normal completion preserves output and nonzero exit status", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const id = yield* registry.start("/bin/sh", ["-c", "printf output; printf error >&2; exit 7"], process.cwd())
        expect(yield* registry.poll(id, 2_000, 100)).toMatchObject({
          running: false,
          stdout: "output",
          stderr: "error",
          exitCode: 7,
        })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer)))),
    ),
  ))

test("preserves cwd, environment, literal arguments, stdin, exec and signal status without exposing private FDs", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const inheritedPath = yield* Config.string("PATH")
        const handles: Array<ChildProcessSpawner.ChildProcessHandle> = []
        const observed = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  handles.push(handle)
                }),
              ),
            ),
          ),
        )
        yield* Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          const literal = "literal ' $HOME ; $(false)"
          const id = yield* registry.start(
            "/bin/sh",
            [
              "-c",
              `
        IFS= read -r line
        printf '%s\\n' "$PWD" "$PATH" "$1" "$line"
        if (: >&3) 2>/dev/null; then printf 'leaked fd3'; fi
        if (: <&4) 2>/dev/null; then printf 'leaked fd4'; fi
        if (: <&5) 2>/dev/null; then printf 'leaked fd5'; fi
        exec /bin/sh -c 'printf stderr >&2; exit 23'
      `,
              "command",
              literal,
            ],
            process.cwd(),
          )
          yield* Stream.run(Stream.make(new TextEncoder().encode("input line\n")), handles[0]!.stdin)
          expect(yield* registry.poll(id, 2_000, 10_000)).toMatchObject({
            stdout: `${process.cwd()}\n${inheritedPath}\n${literal}\ninput line\n`,
            stderr: "stderr",
            running: false,
            exitCode: 23,
            truncated: false,
          })
          const signalled = yield* registry.start("/bin/sh", ["-c", "kill -TERM $$"], process.cwd())
          expect(yield* registry.poll(signalled, 2_000, 100)).toMatchObject({ running: false, exitCode: 143 })
          const interrupted = yield* registry.start("/bin/sh", ["-c", "kill -INT $$; printf survived"], process.cwd())
          expect(yield* registry.poll(interrupted, 2_000, 100)).toMatchObject({
            running: false,
            exitCode: 130,
            stdout: "",
          })
          for (const handle of handles) expect(alive(Number(handle.pid))).toBe(false)
        }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(observed))))
      }).pipe(provide(BunServices.layer)),
    ),
  ))

test("interruption during startup closes the already-spawned supervisor", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const started = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>()
        const paused = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner
              .spawn(command)
              .pipe(Effect.tap((handle) => Deferred.succeed(started, handle).pipe(Effect.andThen(Effect.never)))),
          ),
        )
        yield* Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          const starting = yield* Effect.forkChild(
            registry.start("/bin/sh", ["-c", "echo $$; exec sleep 60"], process.cwd()),
          )
          const handle = yield* Deferred.await(started)
          const childOutput = yield* ProcessRegistry.collectBoundedText(handle.stdout.pipe(Stream.take(1)), 100)
          const child = Number(childOutput.text.trim())
          expect(alive(Number(handle.pid))).toBe(true)
          expect(child).toBeGreaterThan(0)
          expect(alive(child)).toBe(true)
          yield* Fiber.interrupt(starting)
          expect(alive(Number(handle.pid))).toBe(false)
          yield* Effect.tryPromise(() => expect.poll(() => alive(child)).toBe(false))
        }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(paused))))
      }).pipe(provide(BunServices.layer)),
    ),
  ))

test("repeated short commands release supervisor pipes and report cleanup overhead", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        yield* Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          const warmup = yield* registry.start("/bin/true", [], process.cwd())
          yield* registry.poll(warmup, 2_000, 100)
          const descriptors = process.platform === "linux" ? readdirSync("/proc/self/fd").length : undefined
          const directTimes: Array<number> = []
          for (let index = 0; index < 20; index++) {
            const start = yield* Clock.currentTimeMillis
            yield* Effect.scoped(
              spawner.spawn(ChildProcess.make("/bin/true")).pipe(Effect.flatMap((handle) => handle.exitCode)),
            )
            directTimes.push((yield* Clock.currentTimeMillis) - start)
          }
          const supervisedTimes: Array<number> = []
          for (let index = 0; index < 20; index++) {
            const start = yield* Clock.currentTimeMillis
            const id = yield* registry.start("/bin/true", [], process.cwd())
            expect(yield* registry.poll(id, 2_000, 100)).toMatchObject({ running: false, exitCode: 0 })
            supervisedTimes.push((yield* Clock.currentTimeMillis) - start)
          }
          for (const [name, times] of [
            ["direct", directTimes],
            ["supervised", supervisedTimes],
          ] as const) {
            times.sort((a, b) => a - b)
            const median = (times[9]! + times[10]!) / 2
            yield* Effect.logInfo(`${name}: n=20 median=${median.toFixed(1)}ms p95=${times[18]!.toFixed(1)}ms`)
          }
          if (descriptors !== undefined) {
            yield* Effect.tryPromise(() =>
              expect.poll(() => readdirSync("/proc/self/fd").length).toBeLessThanOrEqual(descriptors),
            )
          }
        }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer))))
      }).pipe(provide(BunServices.layer)),
    ),
  ))

test("reports a missing executable as shell status 127 while invalid cwd remains a spawn failure", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const id = yield* registry.start("/rika-does-not-exist/command", [], process.cwd())
        expect(yield* registry.poll(id, 2_000, 1_000)).toMatchObject({ running: false, exitCode: 127 })
        expect(yield* Effect.result(registry.start("/bin/true", [], "/rika-does-not-exist/workspace"))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PlatformError" },
        })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer)))),
    ),
  ))

test("sources BASH_ENV only in the requested Bash command, not in its supervisor", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const startup = yield* fs.makeTempFileScoped({ prefix: "rika-bash-env-" })
        yield* fs.writeFileString(startup, "printf startup >&2; export RIKA_PROCESS_TEST=from-startup\n")
        expect(readFileSync(startup, "utf8")).toContain("printf startup")
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const environment = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline")
            // Bash treats a socket stdin as a remote-shell invocation and skips
            // BASH_ENV. Use /dev/null here to exercise its normal startup path.
            return spawner.spawn(
              ChildProcess.make(command.command, command.args, {
                ...command.options,
                stdin: "ignore",
                env: { BASH_ENV: startup },
              }),
            )
          }),
        )
        yield* Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          const id = yield* registry.start(
            "/bin/bash",
            ["-c", "printf '%s' \"$RIKA_PROCESS_TEST\"; printf '%s' \"$BASH_ENV\" >&2"],
            process.cwd(),
          )
          expect(yield* registry.poll(id, 2_000, 1_000)).toMatchObject({
            running: false,
            exitCode: 0,
            stdout: "from-startup",
            stderr: `startup${startup}`,
          })
        }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(environment))))
      }).pipe(provide(BunServices.layer)),
    ),
  ))
