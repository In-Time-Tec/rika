import {
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
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RuntimeFilesystem } from "../runtime/coding-tool-runtime-filesystem"

interface Output {
  readonly processId: string
  readonly stdout: string
  readonly stderr: string
  readonly running: boolean
  readonly exitCode?: number
  readonly truncated: boolean
}

interface Entry {
  readonly process: ChildProcessSpawner.ChildProcessHandle
  readonly output: Ref.Ref<PendingOutput>
  readonly exit: Deferred.Deferred<number>
}

interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

interface PendingOutput {
  readonly stdout: string
  readonly stderr: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly truncated: boolean
}

export const pendingOutputLimit = 64 * 1024

const appendOutput = (pending: PendingOutput, channel: "stdout" | "stderr", text: string): PendingOutput => {
  const retainedBytes = RuntimeFilesystem.byteLength(pending.stdout) + RuntimeFilesystem.byteLength(pending.stderr)
  const accepted = RuntimeFilesystem.boundedPrefix(text, pendingOutputLimit - retainedBytes)
  const bytesKey = channel === "stdout" ? "stdoutBytes" : "stderrBytes"
  return {
    ...pending,
    [channel]: pending[channel] + accepted,
    [bytesKey]: pending[bytesKey] + RuntimeFilesystem.byteLength(text),
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
      () => ({ text: "", truncated: false }),
      (state, bytes) => {
        const decoded = decoder.decode(bytes, { stream: true })
        const accepted = RuntimeFilesystem.boundedPrefix(decoded, limit - RuntimeFilesystem.byteLength(state.text))
        return { text: state.text + accepted, truncated: state.truncated || accepted !== decoded }
      },
    )
    const final = decoder.decode()
    const accepted = RuntimeFilesystem.boundedPrefix(final, limit - RuntimeFilesystem.byteLength(collected.text))
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

export class Service extends Context.Service<Service, Interface>()(
  "@rika/coding-tools/process/shell-process-registry/Service",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const entries = yield* Ref.make(new Map<string, Entry>())
    let nextId = 1
    yield* Effect.addFinalizer(() =>
      Ref.get(entries).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(
            current.values(),
            (entry) => entry.process.kill({ killSignal: "SIGTERM", forceKillAfter: "100 millis" }).pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          ),
        ),
      ),
    )
    return Service.of({
      start: Effect.fn("ProcessRegistry.start")(function* (command, args, cwd) {
        const handle = yield* spawner
          .spawn(ChildProcess.make(command, args, { cwd }))
          .pipe(Effect.provideService(Scope.Scope, scope))
        const output = yield* Ref.make<PendingOutput>({
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
        })
        const exit = yield* Deferred.make<number>()
        const processId = String(nextId++)
        yield* Ref.update(entries, (current) => new Map(current).set(processId, { process: handle, output, exit }))
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
                Effect.exit(handle.exitCode),
              ],
              { concurrency: 3 },
            )
            if (Exit.isFailure(stdoutExit) || Exit.isFailure(stderrExit) || Exit.isFailure(processExit))
              yield* Ref.update(output, (pending) => ({ ...pending, truncated: true }))
            yield* Deferred.succeed(exit, Exit.isSuccess(processExit) ? Number(processExit.value) : -1)
          }),
          scope,
        )
        return processId
      }),
      poll: Effect.fn("ProcessRegistry.poll")(function* (processId, waitMillis, outputLimit) {
        const entry = (yield* Ref.get(entries)).get(processId)
        if (entry === undefined) return yield* new ProcessNotFound({ message: `Unknown process id: ${processId}` })
        if (waitMillis > 0)
          yield* Deferred.await(entry.exit).pipe(Effect.timeout(`${waitMillis} millis`), Effect.ignore)
        const pendingExit = yield* Deferred.poll(entry.exit)
        const exit = Option.isSome(pendingExit) ? Option.some(yield* pendingExit.value) : Option.none<number>()
        const output = yield* Ref.getAndSet(entry.output, {
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
        })
        const combined = `${output.stdout}${output.stderr}`
        const totalBytes = output.stdoutBytes + output.stderrBytes
        const bounded = RuntimeFilesystem.boundedText<BoundedText>(
          combined,
          outputLimit,
          "page or narrow the command",
          totalBytes,
        )
        const capacityTruncated = bounded.truncated
        const text = bounded.text
        const result = {
          processId,
          stdout: capacityTruncated ? text : output.stdout,
          stderr: capacityTruncated ? "" : output.stderr,
          running: Option.isNone(exit),
          ...(Option.isSome(exit) ? { exitCode: exit.value } : {}),
          truncated: output.truncated || capacityTruncated,
        }
        if (Option.isSome(exit))
          yield* Ref.update(entries, (current) => {
            const next = new Map(current)
            next.delete(processId)
            return next
          })
        return result
      }),
      cancel: Effect.fn("ProcessRegistry.cancel")(function* (processId) {
        const entry = (yield* Ref.get(entries)).get(processId)
        if (entry === undefined) return yield* new ProcessNotFound({ message: `Unknown process id: ${processId}` })
        yield* entry.process.kill({ killSignal: "SIGTERM", forceKillAfter: "100 millis" })
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
