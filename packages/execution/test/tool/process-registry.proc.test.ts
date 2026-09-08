import * as BunServices from "@effect/platform-bun/BunServices"
import { Clock, Config, Deferred, Effect, Fiber, FileSystem, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
// Independent OS observations must not depend on the process adapter under test.
// ast-grep-ignore: effect-prefer-child-process
import { execFileSync } from "node:child_process" // oxlint-disable-line effecttsgo/node-builtin-import
// ast-grep-ignore: effect-prefer-filesystem
import { readFileSync, readdirSync, statSync } from "node:fs" // oxlint-disable-line effecttsgo/node-builtin-import
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

test("concurrent and repeated cancellation joins escalation without touching another owned group", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "rika-cancel-" })
        const registry = yield* ProcessRegistry.Service
        const unrelated = yield* registry.start("/bin/sh", ["-c", "echo $$; exec sleep 60"], cwd)
        const unrelatedOutput = yield* registry.poll(unrelated, 50, 100)
        const unrelatedPid = Number(unrelatedOutput.stdout.trim())
        expect(alive(unrelatedPid)).toBe(true)
        const id = yield* registry.start(
          "/bin/sh",
          ["-c", "trap 'printf term > signalled; trap \"\" TERM' TERM; echo $$ > ready; while :; do sleep 60; done"],
          cwd,
        )
        yield* Effect.tryPromise(() =>
          expect
            .poll(() => {
              try {
                return Number(readFileSync(`${cwd}/ready`, "utf8")) > 0
              } catch {
                return false
              }
            })
            .toBe(true),
        )
        const child = Number(readFileSync(`${cwd}/ready`, "utf8"))
        const start = yield* Clock.currentTimeMillis
        yield* Effect.all([registry.cancel(id), registry.cancel(id)], { concurrency: 2 })
        expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(2_000)
        expect(readFileSync(`${cwd}/signalled`, "utf8")).toBe("term")
        yield* Effect.tryPromise(() => expect.poll(() => alive(child)).toBe(false))
        yield* registry.cancel(id)
        const result = yield* registry.poll(id, 2_000, 100)
        expect(result.running).toBe(false)
        yield* registry.cancel(id)
        expect(yield* registry.poll(id, 0, 100)).toEqual(result)
        expect(alive(unrelatedPid)).toBe(true)
        expect(yield* registry.poll(unrelated, 0, 100)).toMatchObject({ running: true })
        expect(yield* Effect.result(registry.cancel(String(unrelatedPid)))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProcessNotFound" },
        })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provideMerge(BunServices.layer)))),
    ),
  ))

test("stopping an observer leaves a finite command running and bounds real oversized output", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const id = yield* registry.start(
          "/bin/sh",
          ["-c", "sleep 0.2; head -c 200000 /dev/zero; printf done >&2"],
          process.cwd(),
        )
        const observer = yield* Effect.forkChild(registry.observe(id))
        yield* Fiber.interrupt(observer)
        expect(yield* registry.poll(id, 0, 100)).toMatchObject({ running: true })
        expect(yield* registry.observe(id)).toMatchObject({ exitCode: 0, truncated: true })
        const result = yield* registry.poll(id, 0, 1024)
        expect(result).toMatchObject({ running: false, exitCode: 0, truncated: true })
        expect(new TextEncoder().encode(result.stdout + result.stderr).length).toBeLessThanOrEqual(1024)
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer)))),
    ),
  ))

test("shutdown invalidates retained handles instead of reporting stale running processes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const retained = yield* Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* ProcessRegistry.Service
            const id = yield* registry.start("/bin/sh", ["-c", "exec sleep 60"], process.cwd())
            return { registry, id }
          }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer)))),
        )
        for (const operation of [
          retained.registry.poll(retained.id, 0, 100),
          retained.registry.observe(retained.id),
          retained.registry.cancel(retained.id),
        ]) {
          expect(yield* Effect.result(operation)).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProcessNotFound" },
          })
        }
        expect(yield* Effect.result(retained.registry.start("true", [], process.cwd()))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PlatformError" },
        })
      }),
    ),
  ))

test("losing the supervisor reports unknown completion even when a descendant holds output open", () => {
  let child = 0
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        let supervisorPid = 0
        const observed = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  supervisorPid = Number(handle.pid)
                }),
              ),
            ),
          ),
        )
        yield* Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          const id = yield* registry.start("/bin/sh", ["-c", "echo $$; exec sleep 60"], process.cwd())
          const output = yield* registry.poll(id, 50, 100)
          child = Number(output.stdout.trim())
          expect(alive(child)).toBe(true)
          process.kill(supervisorPid, "SIGKILL")
          expect(yield* registry.poll(id, 2_000, 100)).toMatchObject({ running: false, exitCode: -1, truncated: true })
        }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(observed))))
      }).pipe(provide(BunServices.layer)),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (child > 0 && alive(child)) process.kill(child, "SIGKILL")
        }),
      ),
    ),
  )
})

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

test("commands without an input API receive EOF instead of waiting forever on stdin", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const id = yield* registry.start("/bin/sh", ["-c", "cat; printf eof"], process.cwd())
        const result = yield* registry.poll(id, 2_000, 100)
        expect(result).toMatchObject({ running: false, stdout: "eof", exitCode: 0 })
        expect(yield* registry.poll(id, 0, 100)).toEqual(result)
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer)))),
    ),
  ))

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

test("terminal observation does not require polling or consume unread output", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const id = yield* registry.start("/bin/sh", ["-c", "printf unread; exit 9"], process.cwd())
        const observation = yield* registry.observe(id)
        expect(observation).toMatchObject({ processId: id, exitCode: 9 })
        yield* Effect.sleep("30 millis")
        expect(yield* registry.observe(id)).toEqual(observation)
        expect(yield* registry.poll(id, 0, 100)).toMatchObject({
          running: false,
          stdout: "unread",
          exitCode: 9,
        })
        expect(yield* registry.observe(id)).toEqual(observation)
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
        IFS= read -r line <<'INPUT'
input line
INPUT
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
          const result = yield* registry.poll(id, 2_000, 10_000)
          const [observedCwd, ...output] = result.stdout.split("\n")
          // Shell PWD can preserve different casing for the same macOS directory.
          const expectedDirectory = statSync(process.cwd())
          const observedDirectory = statSync(observedCwd!)
          expect([observedDirectory.dev, observedDirectory.ino]).toEqual([expectedDirectory.dev, expectedDirectory.ino])
          expect(output.join("\n")).toBe(`${inheritedPath}\n${literal}\ninput line\n`)
          expect(result).toMatchObject({
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
          const warmup = yield* registry.start("true", [], process.cwd())
          yield* registry.poll(warmup, 2_000, 100)
          const descriptors = process.platform === "linux" ? readdirSync("/proc/self/fd").length : undefined
          const directTimes: Array<number> = []
          for (let index = 0; index < 20; index++) {
            const start = yield* Clock.currentTimeMillis
            yield* Effect.scoped(
              spawner.spawn(ChildProcess.make("true")).pipe(Effect.flatMap((handle) => handle.exitCode)),
            )
            directTimes.push((yield* Clock.currentTimeMillis) - start)
          }
          const supervisedTimes: Array<number> = []
          for (let index = 0; index < 20; index++) {
            const start = yield* Clock.currentTimeMillis
            const id = yield* registry.start("true", [], process.cwd())
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
        expect(yield* Effect.result(registry.start("true", [], "/rika-does-not-exist/workspace"))).toMatchObject({
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
