import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { Effect, FileSystem, Function, Layer, Option, Path, PlatformError, Scope, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as NativeRuntime from "../../src/tool/runtime"

export const workspace = "/workspace"
export const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength

export const provide: {
  <R, E2, RIn>(
    layer: Layer.Layer<R, E2, RIn>,
  ): <A, E, RAll>(effect: Effect.Effect<A, E, RAll>) => Effect.Effect<A, E | E2, RIn | Exclude<RAll, R> | Scope.Scope>
  <A, E, RAll, R, E2, RIn>(
    effect: Effect.Effect<A, E, RAll>,
    layer: Layer.Layer<R, E2, RIn>,
  ): Effect.Effect<A, E | E2, RIn | Exclude<RAll, R> | Scope.Scope>
} = Function.dual(2, <A, E, RAll, R, E2, RIn>(effect: Effect.Effect<A, E, RAll>, layer: Layer.Layer<R, E2, RIn>) =>
  Layer.build(layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
)

const platformError = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "NativeToolRuntimeTest",
    method,
    description: "foreign failure",
    pathOrDescriptor: path,
  })

const info = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
})

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const processHandle = ({ stdout, stderr, exitCode }: ProcessResult, onKill: () => void = () => undefined) => {
  const encoder = new TextEncoder()
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.sync(onKill),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.make(encoder.encode(`${stdout}${stderr}`)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.make(encoder.encode(`${exitCode}\n`)),
    unref: Effect.succeed(Effect.void),
  })
}

export interface TestEnvironment {
  readonly files: Map<string, string>
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd?: string }>
  readonly killed: Array<string>
  readonly runtime: Layer.Layer<ToolRuntime.Service>
  readonly dependencies: Layer.Layer<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
}

export const makeEnvironment = (): TestEnvironment => {
  const files = new Map([
    ["/workspace/a.txt", "zero\nneedle\nlast"],
    ["/workspace/src/z.ts", "alpha\nalpha2"],
    ["/workspace/ambiguous.txt", "same same"],
    ["/outside.txt", "outside content"],
  ])
  const directories = new Map<string, Array<string>>([
    ["/", ["workspace", "outside.txt"]],
    ["/workspace", ["src", "a.txt", "ambiguous.txt", "socket"]],
    ["/workspace/src", ["z.ts"]],
  ])
  const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd?: string }> = []
  const killed: Array<string> = []
  const fileSystem = FileSystem.layerNoop({
    realPath: (target) => Effect.succeed(target),
    readDirectory: (target) => Effect.succeed(directories.get(target) ?? []),
    stat: (target) => {
      let type: FileSystem.File.Type = "Socket"
      if (directories.has(target)) type = "Directory"
      else if (files.has(target)) type = "File"
      return Effect.succeed(info(type))
    },
    readFileString: (target) => {
      const content = files.get(target)
      return content === undefined ? Effect.fail(platformError("readFileString", target)) : Effect.succeed(content)
    },
    exists: (target) => Effect.succeed(files.has(target) || directories.has(target)),
    writeFileString: (target, content) => Effect.sync(() => void files.set(target, content)),
  })
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((spawnedCommand) => {
      if (spawnedCommand._tag === "PipedCommand") return Effect.fail(platformError("spawn", "pipeline"))
      const command =
        spawnedCommand.args[5] === "rika-process"
          ? ChildProcess.make(spawnedCommand.args[6]!, spawnedCommand.args.slice(7), spawnedCommand.options)
          : spawnedCommand
      const recorded = { command: command.command, args: command.args }
      commands.push(command.options.cwd === undefined ? recorded : { ...recorded, cwd: command.options.cwd })
      const executed = command.command === "/bin/bash" ? (command.args[1] ?? "") : command.command
      if (executed === "never-spawn") return Effect.never
      if (executed === "fail-spawn") return Effect.fail(platformError("spawn", executed))
      const output = {
        large: "x".repeat(40_001),
        "exact-limit": "x".repeat(16_384),
        "multibyte-limit": `${"日".repeat(6_000)}TAIL`,
        "unicode-boundary": `${"x".repeat(39_999)}🙂`,
      } satisfies Readonly<Record<string, string>>
      const fixtureOutput = Object.entries(output).find(([name]) => name === executed)?.[1]
      if (fixtureOutput !== undefined)
        return Effect.succeed(processHandle({ stdout: fixtureOutput, stderr: "", exitCode: 0 }))
      if (executed === "running") {
        const handle = processHandle({ stdout: "partial", stderr: "", exitCode: 0 }, () => killed.push(executed))
        return Effect.addFinalizer(() => handle.kill().pipe(Effect.orDie)).pipe(
          Effect.as({ ...handle, exitCode: Effect.never, getOutputFd: () => Stream.never }),
        )
      }
      if (executed === "stream-failure") {
        const handle = processHandle({ stdout: "", stderr: "", exitCode: 0 })
        return Effect.succeed({ ...handle, stdout: Stream.fail(platformError("stdout", executed)) })
      }
      if (executed === "bad") return Effect.succeed(processHandle({ stdout: "out", stderr: "err", exitCode: 7 }))
      return Effect.succeed(processHandle({ stdout: "out", stderr: "err", exitCode: 0 }))
    }),
  )
  const dependencies = Layer.mergeAll(fileSystem, Path.layer, spawner)
  return {
    files,
    commands,
    killed,
    dependencies,
    runtime: NativeRuntime.layer(workspace).pipe(Layer.provide(dependencies)),
  }
}
