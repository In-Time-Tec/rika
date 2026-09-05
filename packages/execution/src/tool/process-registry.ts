import {
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Function,
  Layer,
  Option,
  PlatformError,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RuntimeFilesystem } from "./filesystem"

interface Output {
  readonly processId: string
  readonly stdout: string
  readonly stderr: string
  readonly running: boolean
  readonly exitCode?: number
  readonly elapsedMillis: number
  readonly truncated: boolean
}

interface Entry {
  readonly close: Effect.Effect<void>
  readonly output: Ref.Ref<PendingOutput>
  readonly exit: Deferred.Deferred<number>
  readonly startedAtNanos: bigint
  readonly admission: Semaphore.Semaphore
}

type EntryState =
  | { readonly _tag: "Active"; readonly entry: Entry }
  | { readonly _tag: "Terminal"; readonly output: Output }

interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

interface PendingOutput {
  readonly stdout: string
  readonly stderr: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly retainedBytes: number
  readonly truncated: boolean
}

export const pendingOutputLimit = 64 * 1024
const terminalOutputLimit = 128

// Keep the detached group leader alive until the spawner's TERM/KILL cleanup
// finishes, even when the user's shell exits first. FD 3 carries only the real
// command's status; FD 4 parks the leader without spawning a sleep process.
// Neither descriptor is inherited by the user's command.
const supervisor = `
trap 'interrupted=1' TERM INT HUP
exec 5<&0
(trap - INT QUIT; exec "$@") <&5 3>&- 4<&- 5<&- &
exec 5<&-
wait "$!"
printf '%s\\n' "$?" >&3
exec 3>&-
while :; do
  interrupted=0
  read -r _ <&4
  if [ "$interrupted" -eq 0 ]; then kill -KILL -$$; fi
done
`

const retainTerminalOutput = (
  states: ReadonlyMap<string, EntryState>,
  processId: string,
  output: Output,
): Map<string, EntryState> => {
  const next = new Map(states)
  next.delete(processId)
  next.set(processId, { _tag: "Terminal", output })
  let terminalCount = 0
  for (const state of next.values()) if (state._tag === "Terminal") terminalCount += 1
  if (terminalCount <= terminalOutputLimit) return next
  for (const [id, state] of next) {
    if (state._tag !== "Terminal") continue
    next.delete(id)
    terminalCount -= 1
    if (terminalCount <= terminalOutputLimit) break
  }
  return next
}

const appendOutput = (pending: PendingOutput, channel: "stdout" | "stderr", text: string): PendingOutput => {
  const accepted = pending.truncated
    ? ""
    : RuntimeFilesystem.boundedPrefix(text, pendingOutputLimit - pending.retainedBytes)
  const bytesKey = channel === "stdout" ? "stdoutBytes" : "stderrBytes"
  return {
    ...pending,
    [channel]: pending[channel] + accepted,
    [bytesKey]: pending[bytesKey] + RuntimeFilesystem.byteLength(text),
    retainedBytes: pending.retainedBytes + RuntimeFilesystem.byteLength(accepted),
    truncated: pending.truncated || accepted !== text,
  }
}

export const collectBoundedText: {
  (limit: number): <E, R>(stream: Stream.Stream<Uint8Array, E, R>) => Effect.Effect<BoundedText, E, R>
  <E, R>(stream: Stream.Stream<Uint8Array, E, R>, limit: number): Effect.Effect<BoundedText, E, R>
} = Function.dual(2, <E, R>(stream: Stream.Stream<Uint8Array, E, R>, limit: number) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    const collected = yield* Stream.runFold(
      stream,
      () => ({ text: "", retainedBytes: 0, truncated: false }),
      (state, bytes) => {
        const decoded = decoder.decode(bytes, { stream: true })
        const accepted = state.truncated ? "" : RuntimeFilesystem.boundedPrefix(decoded, limit - state.retainedBytes)
        return {
          text: state.text + accepted,
          retainedBytes: state.retainedBytes + RuntimeFilesystem.byteLength(accepted),
          truncated: state.truncated || accepted !== decoded,
        }
      },
    )
    const final = decoder.decode()
    const accepted = collected.truncated ? "" : RuntimeFilesystem.boundedPrefix(final, limit - collected.retainedBytes)
    return {
      text: collected.text + accepted,
      truncated: collected.truncated || accepted !== final,
    }
  }),
)

export class ProcessNotFound extends Data.TaggedError("ProcessNotFound")<{ readonly message: string }> {}

export interface Interface {
  readonly start: (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) => Effect.Effect<string, PlatformError.PlatformError>
  readonly poll: (processId: string, waitMillis: number, outputLimit: number) => Effect.Effect<Output, ProcessNotFound>
  readonly cancel: (processId: string) => Effect.Effect<void, ProcessNotFound | PlatformError.PlatformError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/execution/tool/process-registry/Service") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.fork(yield* Scope.Scope, "parallel")
    const entries = yield* Ref.make(new Map<string, EntryState>())
    let nextId = 1
    return Service.of({
      start: Effect.fn("ProcessRegistry.start")(function* (command, args, cwd) {
        const processScope = yield* Scope.fork(scope)
        // Scope.close is idempotent but does not join an in-progress close.
        // Registered first, this marker runs after the spawner's finalizer.
        const cleanupDone = yield* Deferred.make<void>()
        yield* Scope.addFinalizer(processScope, Deferred.succeed(cleanupDone, undefined).pipe(Effect.asVoid))
        const close = Scope.close(processScope, Exit.void).pipe(
          Effect.andThen(Deferred.await(cleanupDone)),
          Effect.uninterruptible,
        )
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(
              "/bin/bash",
              ["--noprofile", "--norc", "--posix", "-c", supervisor, "rika-process", command, ...args],
              {
                cwd,
                detached: true,
                killSignal: "SIGTERM",
                forceKillAfter: "100 millis",
                additionalFds: { fd3: { type: "output" }, fd4: { type: "input" } },
              },
            ),
          )
          .pipe(
            Effect.provideService(Scope.Scope, processScope),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)),
          )
        const output = yield* Ref.make<PendingOutput>({
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          retainedBytes: 0,
          truncated: false,
        })
        const exit = yield* Deferred.make<number>()
        const startedAtNanos = yield* Clock.currentTimeNanos
        const admission = yield* Semaphore.make(1)
        const processId = String(nextId++)
        const entry = { close, output, exit, startedAtNanos, admission }
        yield* Ref.update(entries, (current) => new Map(current).set(processId, { _tag: "Active", entry }))
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const stdoutDecoder = new TextDecoder()
            const stderrDecoder = new TextDecoder()
            const drain = (
              channel: "stdout" | "stderr",
              decoder: TextDecoder,
              stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
            ) =>
              Stream.runForEach(stream, (bytes) =>
                Ref.update(output, (pending) =>
                  appendOutput(pending, channel, decoder.decode(bytes, { stream: true })),
                ),
              ).pipe(Effect.ensuring(Ref.update(output, (pending) => appendOutput(pending, channel, decoder.decode()))))
            const [stdoutExit, stderrExit, processExit] = yield* Effect.all(
              [
                Effect.exit(drain("stdout", stdoutDecoder, handle.stdout)),
                Effect.exit(drain("stderr", stderrDecoder, handle.stderr)),
                Effect.exit(
                  collectBoundedText(handle.getOutputFd(3), 16).pipe(
                    Effect.map(({ text }) => (/^\d+\n$/.test(text) ? Number(text) : -1)),
                    Effect.ensuring(close),
                  ),
                ),
              ],
              { concurrency: 3 },
            )
            if (
              Exit.isFailure(stdoutExit) ||
              Exit.isFailure(stderrExit) ||
              Exit.isFailure(processExit) ||
              processExit.value === -1
            )
              yield* Ref.update(output, (pending) => ({ ...pending, truncated: true }))
            yield* Deferred.succeed(exit, Exit.isSuccess(processExit) ? processExit.value : -1)
          }),
          scope,
        )
        return processId
      }),
      poll: Effect.fn("ProcessRegistry.poll")(function* (processId, waitMillis, outputLimit) {
        const initial = (yield* Ref.get(entries)).get(processId)
        if (initial === undefined) return yield* new ProcessNotFound({ message: `Unknown process id: ${processId}` })
        if (initial._tag === "Terminal") return initial.output
        const entry = initial.entry
        return yield* entry.admission.withPermits(1)(
          Effect.gen(function* () {
            const current = (yield* Ref.get(entries)).get(processId)
            if (current === undefined)
              return yield* new ProcessNotFound({ message: `Unknown process id: ${processId}` })
            if (current._tag === "Terminal") return current.output
            if (waitMillis > 0)
              yield* Deferred.await(entry.exit).pipe(Effect.timeout(`${waitMillis} millis`), Effect.ignore)
            const pendingExit = yield* Deferred.poll(entry.exit)
            const exit = Option.isSome(pendingExit) ? Option.some(yield* pendingExit.value) : Option.none<number>()
            const output = yield* Ref.getAndSet(entry.output, {
              stdout: "",
              stderr: "",
              stdoutBytes: 0,
              stderrBytes: 0,
              retainedBytes: 0,
              truncated: false,
            })
            const combined = `${output.stdout}${output.stderr}`
            const totalBytes = output.stdoutBytes + output.stderrBytes
            const bounded = RuntimeFilesystem.boundedText(
              combined,
              outputLimit,
              "page or narrow the command",
              totalBytes,
            )
            const capacityTruncated = bounded.truncated
            const elapsedMillis = Math.max(
              0,
              Number(((yield* Clock.currentTimeNanos) - entry.startedAtNanos) / 1_000_000n),
            )
            const base: Output = {
              processId,
              stdout: capacityTruncated ? bounded.text : output.stdout,
              stderr: capacityTruncated ? "" : output.stderr,
              running: Option.isNone(exit),
              elapsedMillis,
              truncated: output.truncated || capacityTruncated,
            }
            const result: Output = Option.isSome(exit) ? { ...base, exitCode: exit.value } : base
            if (Option.isSome(exit))
              yield* Ref.update(entries, (states) => retainTerminalOutput(states, processId, result))
            return result
          }),
        )
      }),
      cancel: Effect.fn("ProcessRegistry.cancel")(function* (processId) {
        const state = (yield* Ref.get(entries)).get(processId)
        if (state === undefined) return yield* new ProcessNotFound({ message: `Unknown process id: ${processId}` })
        if (state._tag === "Terminal")
          return yield* new ProcessNotFound({ message: `Unknown process id: ${processId}` })
        yield* state.entry.close
        yield* Ref.update(entries, (current) => {
          const next = new Map(current)
          next.delete(processId)
          return next
        })
      }),
    })
  }),
)

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))
