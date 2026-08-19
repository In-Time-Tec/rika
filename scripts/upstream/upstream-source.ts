import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { packedTarballName, tarballDirectory, tarballPrefix, upstreamPackages } from "./upstream-package-contract"
import { directoryDigest } from "./upstream-content-digest"
import { extractedDigest, packSibling } from "./upstream-sibling-pack"

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
  const project = yield* path.fromFileUrl(new URL("../..", import.meta.url))
  const projects = path.resolve(project, "..")
  return { path, project, projects }
})

const recordedSpecifiers = Effect.fn("Upstream.recordedSpecifiers")(function* (project: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifest = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    yield* fileSystem.readFileString(path.join(project, "package.json")),
  )) as { readonly overrides?: Record<string, string> }
  return manifest.overrides ?? {}
})

// Every Baton package declares `effect` as a peer dependency, so a Baton package that resolves
// outside this repository drags in its own `effect` copy. Effect's Redacted registry is a
// module-local WeakMap, so an api key built by Rika's `effect` is unreadable by a second instance
// and provider setup dies with "Unable to get redacted value". One resolved `effect` is therefore
// a correctness requirement, not a tidiness preference.
const resolution = Effect.fn("Upstream.resolution")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const { path, project } = yield* roots
  const root = yield* fileSystem.realPath(project)
  for (const { name } of upstreamPackages) {
    const installed = path.join(project, "node_modules", ...name.split("/"))
    if (!(yield* fileSystem.exists(installed))) return yield* new UpstreamError({ message: `${name} is not installed` })
    const actual = yield* fileSystem.realPath(installed)
    if (!actual.startsWith(`${root}${path.sep}`))
      return yield* new UpstreamError({
        message: `${name} resolves outside the repository to ${actual}, which duplicates effect`,
      })
  }
  const instances = new Set<string>()
  for (const directory of [
    project,
    ...upstreamPackages.map(({ name }) => path.join(project, "node_modules", ...name.split("/"))),
  ]) {
    const nested = path.join(directory, "node_modules", "effect")
    const resolved = (yield* fileSystem.exists(nested)) ? nested : path.join(project, "node_modules", "effect")
    instances.add(yield* fileSystem.realPath(resolved))
  }
  if (instances.size > 1)
    return yield* new UpstreamError({
      message: `Rika resolves ${instances.size} effect instances: ${[...instances].toSorted().join(", ")}`,
    })
})

const makePackDirectories = Effect.fn("Upstream.makePackDirectories")(function* (parent: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  for (const child of ["pack", "source"]) {
    const directory = path.join(parent, child)
    yield* fileSystem.remove(directory, { recursive: true, force: true })
    yield* fileSystem.makeDirectory(directory, { recursive: true })
  }
})

// Resolution alone cannot see a stale install: Bun keys its cache on the tarball path, so a
// correctly resolved package can still hold a previous extraction. This compares the bytes Rika
// actually loads against the bytes a fresh pack of the sibling worktree produces.
const freshness = Effect.fn("Upstream.freshness")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const { path, project, projects } = yield* roots
  const specifiers = yield* recordedSpecifiers(project)
  const staging = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-upstream-status-" })
  const stale: Array<string> = []
  for (const { name, directory } of upstreamPackages) {
    const source = path.join(projects, directory)
    if (!(yield* fileSystem.exists(source)))
      return yield* new UpstreamError({ message: `Missing sibling package: ${source}` })
    const specifier = specifiers[name]
    if (specifier === undefined)
      return yield* new UpstreamError({ message: `${name} is not pinned to a packed sibling tarball` })
    yield* makePackDirectories(staging)
    const packed = yield* packSibling(source, path.join(staging, "pack"))
    if (packed === undefined) return yield* new UpstreamError({ message: `Failed to pack ${name} from ${source}` })
    const expected = packedTarballName(packed)
    if (specifier !== `file:${tarballDirectory}/${expected}`)
      stale.push(`${name} is pinned to ${specifier} but the sibling worktree packs to ${expected}`)
    const sourceDigest = yield* extractedDigest(packed.file, path.join(staging, "source"))
    const installedDigest = yield* directoryDigest(
      yield* fileSystem.realPath(path.join(project, "node_modules", ...name.split("/"))),
    )
    if (sourceDigest !== installedDigest)
      stale.push(`${name} installed content ${installedDigest} does not match sibling content ${sourceDigest}`)
  }
  if (stale.length > 0) return yield* new UpstreamError({ message: `Stale Baton install:\n${stale.join("\n")}` })
})

const status = Effect.gen(function* () {
  yield* resolution()
  yield* freshness()
})

// Symlinking a sibling worktree into node_modules makes Bun resolve that package's own
// dependencies from the sibling repository, which yields a second `effect`. Packing each sibling
// and installing the tarballs lets Bun build one graph from this repository instead.
const link = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const { path, project, projects } = yield* roots
  for (const repository of ["batonfx"] as const) {
    const repositoryPath = path.join(projects, repository)
    if (!(yield* fileSystem.exists(repositoryPath))) {
      return yield* new UpstreamError({ message: `Missing sibling repository: ${repositoryPath}` })
    }
  }
  // Tarballs live at a stable gitignored path so the recorded specifiers stay reproducible instead
  // of embedding a per-run temporary directory into the tracked manifest. The file name carries the
  // packed content digest, which is the only part of a `file:` specifier Bun uses as a cache key.
  const tarballs = path.join(project, tarballDirectory)
  yield* fileSystem.remove(tarballs, { recursive: true, force: true })
  yield* fileSystem.makeDirectory(tarballs, { recursive: true })
  const staging = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-upstream-link-" })
  const specifiers: Record<string, string> = {}
  for (const { name, directory } of upstreamPackages) {
    const source = path.join(projects, directory)
    yield* run("bun", ["run", "build"], source)
    yield* makePackDirectories(staging)
    const packed = yield* packSibling(source, path.join(staging, "pack"))
    if (packed === undefined) return yield* new UpstreamError({ message: `Failed to pack ${name} from ${source}` })
    if (!packed.name.startsWith(tarballPrefix(name)))
      return yield* new UpstreamError({ message: `${source} packed ${packed.name}, which is not ${name}` })
    const named = packedTarballName(packed)
    yield* fileSystem.copyFile(packed.file, path.join(tarballs, named))
    specifiers[name] = `file:${tarballDirectory}/${named}`
  }
  const manifestPath = path.join(project, "package.json")
  const manifest = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    yield* fileSystem.readFileString(manifestPath),
  )) as {
    readonly overrides?: Record<string, string>
    readonly workspaces: { readonly catalog: Record<string, string> }
  }
  const pinned = {
    ...manifest,
    overrides: { ...manifest.overrides, ...specifiers },
    workspaces: { ...manifest.workspaces, catalog: { ...manifest.workspaces.catalog, ...specifiers } },
  }
  yield* fileSystem.writeFileString(
    manifestPath,
    `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(pinned)}\n`,
  )
  yield* run("bun", ["install"], project)
  yield* run("bun", ["run", "format", "--", "package.json"], project)
  yield* fileSystem.remove(path.join(project, ".turbo"), { recursive: true, force: true })
  yield* status
})

const registry = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const { path, project } = yield* roots
  yield* run("git", ["checkout", "--", "package.json", "bun.lock"], project)
  yield* fileSystem.remove(path.join(project, tarballDirectory), { recursive: true, force: true })
  yield* run("bun", ["install", "--frozen-lockfile", "--force"], project)
})

const command = Command.make("upstream").pipe(
  Command.withSubcommands([
    Command.make("link", {}, () => link).pipe(Command.withDescription("Link sibling Baton packages")),
    Command.make("status", {}, () => status).pipe(Command.withDescription("Verify sibling package links")),
    Command.make("registry", {}, () => registry).pipe(Command.withDescription("Restore registry dependencies")),
  ]),
)

const main = Command.run(command, { version: "0.0.0" })

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
)
