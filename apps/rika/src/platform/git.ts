import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

/**
 * Runs `git -C <workspace> ...` and returns trimmed stdout, or `undefined` when git is missing, exits non-zero,
 * or prints nothing. Callers treat every one of those as "no value" — a checkout without a remote, a directory
 * outside any repository, or a host without git all behave the same way.
 */
export const gitOutput = Effect.fn("Platform.gitOutput")(function* (
  workspace: string,
  arguments_: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make("git", ["-C", workspace, ...arguments_], { stdout: "pipe", stderr: "ignore" }))
        .pipe(Effect.option)
      if (child._tag === "None") return undefined
      const result = yield* Effect.all([Stream.mkString(Stream.decodeText(child.value.stdout)), child.value.exitCode], {
        concurrency: 2,
      }).pipe(Effect.option)
      if (result._tag === "None") return undefined
      const [output, exitCode] = result.value
      if (Number(exitCode) !== 0) return undefined
      const value = output.trim()
      return value.length === 0 ? undefined : value
    }),
  )
})
