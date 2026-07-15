import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const packages = [
  ["@batonfx/core", "batonfx/packages/core"],
  ["@batonfx/mcp", "batonfx/packages/mcp"],
  ["@batonfx/providers", "batonfx/packages/providers"],
  ["@batonfx/skills", "batonfx/packages/skills"],
  ["@batonfx/test", "batonfx/packages/test"],
  ["@relayfx/sdk", "relayfx/packages/relay"],
] as const

const consumers = [
  [".", packages.map(([name]) => name)],
  ["apps/rika", ["@batonfx/providers"]],
  ["packages/runtime", ["@batonfx/core", "@batonfx/test", "@relayfx/sdk"]],
] as const

class UpstreamError extends Data.TaggedError("UpstreamError")<{ readonly message: string }> {}

const run = Effect.fn("Upstream.run")((command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exitCode = yield* spawner.exitCode(ChildProcess.make(command, args, { cwd }))
    if (Number(exitCode) !== 0)
      return yield* new UpstreamError({ message: `${command} ${args.join(" ")} exited with ${exitCode}` })
  }),
)

const roots = Effect.gen(function* () {
  const path = yield* Path.Path
  const project = yield* path.fromFileUrl(new URL("..", import.meta.url))
  const projects = path.resolve(project, "..")
  return { path, project, projects }
})

const status = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const { path, project, projects } = yield* roots
  for (const [consumer, names] of consumers) {
    for (const name of names) {
      const relative = packages.find(([packageName]) => packageName === name)?.[1]
      if (relative === undefined) return yield* Effect.die(`Unknown upstream package: ${name}`)
      const installed = path.join(project, consumer, "node_modules", ...name.split("/"))
      const actual = yield* fileSystem.realPath(installed)
      const expected = path.join(projects, relative)
      if (actual !== expected) {
        return yield* new UpstreamError({ message: `${consumer}:${name} resolves to ${actual}; expected ${expected}` })
      }
    }
  }
})

const link = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const { path, project, projects } = yield* roots
  for (const repository of ["batonfx", "relayfx"] as const) {
    const repositoryPath = path.join(projects, repository)
    if (!(yield* fileSystem.exists(repositoryPath))) {
      return yield* new UpstreamError({ message: `Missing sibling repository: ${repositoryPath}` })
    }
  }
  yield* run("bun", ["run", "build"], path.join(projects, "relayfx", "packages", "relay"))
  for (const [, relative] of packages) {
    yield* run("bun", ["run", "build"], path.join(projects, relative))
    yield* run("bun", ["link"], path.join(projects, relative))
  }
  for (const [consumer, names] of consumers) {
    for (const name of names) {
      const relative = packages.find(([packageName]) => packageName === name)?.[1]
      if (relative === undefined) return yield* Effect.die(`Unknown upstream package: ${name}`)
      const installed = path.join(project, consumer, "node_modules", ...name.split("/"))
      yield* fileSystem.remove(installed, { recursive: true, force: true })
      yield* fileSystem.symlink(path.join(projects, relative), installed)
    }
  }
  yield* fileSystem.remove(path.join(project, ".turbo"), { recursive: true, force: true })
  yield* status
})

const registry = Effect.gen(function* () {
  const { project } = yield* roots
  yield* run("bun", ["install", "--frozen-lockfile", "--force"], project)
})

const command = Command.make("upstream").pipe(
  Command.withSubcommands([
    Command.make("link", {}, () => link).pipe(Command.withDescription("Link sibling Baton and Relay packages")),
    Command.make("status", {}, () => status).pipe(Command.withDescription("Verify sibling package links")),
    Command.make("registry", {}, () => registry).pipe(Command.withDescription("Restore registry dependencies")),
  ]),
)

const main = Command.run(command, { version: "0.0.0" })

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
)
