import { Config, Effect, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { WorkspaceError } from "./error"

const maximumOutputBytes = 64 * 1024

const run = (
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Record<string, string>,
  output: (stream: "stdout" | "stderr", text: string) => Effect.Effect<void, WorkspaceError, never>,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Config.string("PATH").pipe(Config.withDefault("/usr/local/bin:/usr/bin:/bin"))
      const process = yield* spawner
        .spawn(
          ChildProcess.make(command[0]!, command.slice(1), {
            cwd,
            env: { PATH: path, ...environment },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        )
        .pipe(
          Effect.mapError(() =>
            WorkspaceError.make({ phase: "capabilities", message: "Workspace command failed", retryable: true }),
          ),
        )
      let retained = ""
      let truncated = false
      const consumeStreamAdapter = (
        stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
        name: "stdout" | "stderr",
      ) => {
        const decoder = new TextDecoder()
        return Stream.runForEach(stream, (chunk) =>
          Effect.gen(function* () {
            const text = decoder.decode(chunk, { stream: true })
            yield* output(name, text)
            if (retained.length < maximumOutputBytes) retained += text.slice(0, maximumOutputBytes - retained.length)
            if (retained.length >= maximumOutputBytes) truncated = true
          }),
        ).pipe(
          Effect.mapError(() =>
            WorkspaceError.make({ phase: "capabilities", message: "Workspace command output failed", retryable: true }),
          ),
        )
      }
      const { stdout, stderr } = process
      const completed = Effect.all(
        [
          consumeStreamAdapter(stdout, "stdout"),
          consumeStreamAdapter(stderr, "stderr"),
          process.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(() =>
              WorkspaceError.make({ phase: "capabilities", message: "Workspace command failed", retryable: true }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([, , code]) => ({ code, output: retained, truncated })))
      return { process, completed }
    }),
    ({ process }) => process.kill().pipe(Effect.ignore),
  ).pipe(Effect.flatMap(({ completed }) => completed))

export const WorkspaceCommand = { run } as const
