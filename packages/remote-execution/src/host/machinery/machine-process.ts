import { Config, Crypto, Deferred, Effect, FileSystem, Ref, Schema, Semaphore } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { MachineOutcome, MachineRequest, type MachineOutcome as MachineOutcomeValue } from "../../protocol/messages"

const Request = Schema.Struct({
  environment: Schema.Record(Schema.String, Schema.String),
  request: MachineRequest,
})

const Response = Schema.Union([Schema.Struct({ outcome: MachineOutcome }), Schema.Struct({ error: Schema.String })])

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request))
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response))

export class MachineProcessError extends Schema.TaggedError<MachineProcessError>()("MachineProcessError", {
  message: Schema.String,
}) {}

export interface Options {
  readonly workspace: string
  readonly workspaceUser: string
  readonly environment: Readonly<Record<string, string>>
}

interface ConnectionState {
  text: string
}

const connect = (
  socketPath: string,
  input: typeof Request.Type,
): Effect.Effect<MachineOutcomeValue, MachineProcessError> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    const state: ConnectionState = { text: "" }
    const result = yield* Deferred.make<MachineOutcomeValue, MachineProcessError>()
    const complete = (effect: Effect.Effect<MachineOutcomeValue, MachineProcessError>) => {
      Deferred.doneUnsafe(result, effect)
    }
    const socket = yield* Effect.tryPromise({
      try: () =>
        Bun.connect<ConnectionState>({
          unix: socketPath,
          socket: {
            open(opened) {
              opened.data = state
              opened.write(`${encodeRequest(input)}\n`)
            },
            data(opened, chunk) {
              opened.data.text += decoder.decode(chunk, { stream: true })
            },
            close(opened) {
              opened.data.text += decoder.decode()
              complete(
                decodeResponse(opened.data.text.trim()).pipe(
                  Effect.mapError(() =>
                    MachineProcessError.make({ message: "Workspace machine returned an invalid response" }),
                  ),
                  Effect.flatMap((response) =>
                    "outcome" in response
                      ? Effect.succeed(response.outcome)
                      : Effect.fail(MachineProcessError.make({ message: response.error })),
                  ),
                ),
              )
            },
            error(_opened, error) {
              complete(Effect.fail(MachineProcessError.make({ message: String(error) })))
            },
          },
        }),
      catch: (error) => MachineProcessError.make({ message: String(error) }),
    })
    return yield* Deferred.await(result).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          socket.end()
        }),
      ),
    )
  })

const waitUntilReady = (
  socketPath: string,
  process: ChildProcessSpawner.ChildProcessHandle,
): Effect.Effect<void, MachineProcessError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    for (let attempt = 0; attempt < 100; attempt++) {
      if (yield* fileSystem.exists(socketPath).pipe(Effect.orElseSucceed(() => false))) return
      if (!(yield* process.isRunning.pipe(Effect.orElseSucceed(() => false))))
        return yield* MachineProcessError.make({ message: "Workspace machine exited before becoming ready" })
      yield* Effect.sleep("50 millis")
    }
    return yield* MachineProcessError.make({ message: "Workspace machine did not become ready" })
  })

const runCleanup = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workspaceUser: string,
  socketPath: string,
) =>
  spawner
    .exitCode(
      ChildProcess.make("sudo", ["-n", "-u", workspaceUser, "--", "rm", "-f", socketPath], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.ignore)

interface RunningProcess {
  readonly child: ChildProcessSpawner.ChildProcessHandle
  readonly socketPath: string
  readonly environment: Readonly<Record<string, string>>
}

const stop = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workspaceUser: string,
  running: RunningProcess,
) =>
  running.child
    .kill({ forceKillAfter: "2 seconds" })
    .pipe(Effect.ignore, Effect.andThen(runCleanup(spawner, workspaceUser, running.socketPath)))

export const make = (options: Options) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const executablePath = yield* Config.string("PATH").pipe(Config.withDefault("/usr/local/bin:/usr/bin:/bin"))
    const language = yield* Config.string("LANG").pipe(Config.withDefault("C.UTF-8"))
    const githubConfig = yield* Config.string("GH_CONFIG_DIR").pipe(Config.withDefault("/run/rika/gh"))
    const main = new URL("./machine-process-main.ts", import.meta.url).pathname
    const start = Effect.gen(function* () {
      const socketPath = `/tmp/rika-machine-${yield* crypto.randomUUIDv4}.sock`
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            "sudo",
            [
              "-n",
              "-u",
              options.workspaceUser,
              "--",
              "env",
              `HOME=/home/${options.workspaceUser}`,
              `PATH=${executablePath}`,
              "bun",
              "run",
              main,
              options.workspace,
              socketPath,
            ],
            { stdout: "inherit", stderr: "inherit" },
          ),
        )
        .pipe(Effect.mapError((error) => MachineProcessError.make({ message: String(error) })))
      yield* waitUntilReady(socketPath, child).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
      return {
        child,
        socketPath,
        environment: {
          HOME: `/home/${options.workspaceUser}`,
          PATH: executablePath,
          LANG: language,
          GH_CONFIG_DIR: githubConfig,
        },
      } satisfies RunningProcess
    })
    return yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const state = yield* Ref.make(yield* start)
        const restart = yield* Semaphore.make(1)
        return { state, restart }
      }),
      ({ state }) => Effect.flatMap(Ref.get(state), (running) => stop(spawner, options.workspaceUser, running)),
    ).pipe(
      Effect.map(({ state, restart }) => ({
        execute: (request: MachineRequest) =>
          Effect.gen(function* () {
            const running = yield* Ref.get(state)
            return yield* connect(running.socketPath, {
              environment: { ...running.environment, ...options.environment },
              request,
            }).pipe(
              Effect.catch((error) =>
                restart.withPermits(1)(
                  Effect.gen(function* () {
                    const current = yield* Ref.get(state)
                    if (current !== running) return
                    yield* stop(spawner, options.workspaceUser, current)
                    yield* Ref.set(state, yield* start)
                  }).pipe(Effect.andThen(Effect.fail(error))),
                ),
              ),
            )
          }),
      })),
    )
  })

export const wire = { Request, Response }
