import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { SkillRegistry } from "@rika/agent"
import { Config, Time } from "@rika/core"
import { Context, Effect, Layer, Schema } from "effect"

export const Scope = Schema.Literals(["project", "user"]).annotate({ identifier: "Rika.Cli.SkillInstaller.Scope" })
export type Scope = typeof Scope.Type

export class SkillInstallerError extends Schema.TaggedErrorClass<SkillInstallerError>()("SkillInstallerError", {
  message: Schema.String,
  operation: Schema.String,
  exit_code: Schema.Int,
  path: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}

export interface InstallInput {
  readonly source: string
  readonly scope: Scope
  readonly force: boolean
}

export interface RemoveInput {
  readonly name: string
  readonly scope: Scope
}

export interface InstallResult {
  readonly action: "add"
  readonly name: string
  readonly scope: Scope
  readonly source: string
  readonly commit: string
  readonly directory: string
  readonly installed_at: number
}

export interface RemoveResult {
  readonly action: "remove"
  readonly name: string
  readonly scope: Scope
  readonly directory: string
  readonly removed: boolean
}

export interface Interface {
  readonly install: (input: InstallInput) => Effect.Effect<InstallResult, SkillInstallerError>
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, SkillInstallerError>
}

export interface SystemInterface {
  readonly home: string
  readonly exists: (path: string) => Effect.Effect<boolean, SkillInstallerError>
  readonly isFile: (path: string) => Effect.Effect<boolean, SkillInstallerError>
  readonly isDirectory: (path: string) => Effect.Effect<boolean, SkillInstallerError>
  readonly makeDirectory: (path: string) => Effect.Effect<void, SkillInstallerError>
  readonly makeTempDirectory: (prefix: string) => Effect.Effect<string, SkillInstallerError>
  readonly readText: (path: string) => Effect.Effect<string, SkillInstallerError>
  readonly writeText: (path: string, text: string) => Effect.Effect<void, SkillInstallerError>
  readonly remove: (path: string) => Effect.Effect<void, SkillInstallerError>
  readonly rename: (from: string, to: string) => Effect.Effect<void, SkillInstallerError>
  readonly copyDirectory: (from: string, to: string) => Effect.Effect<void, SkillInstallerError>
  readonly runGit: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, SkillInstallerError>
}

export class System extends Context.Service<System, SystemInterface>()("@rika/cli/SkillInstaller/System") {}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/SkillInstaller") {}

const LockEntry = Schema.Struct({
  source: Schema.String,
  commit: Schema.String,
  installed_at: Schema.Number,
  scope: Scope,
  directory: Schema.String,
}).annotate({ identifier: "Rika.Cli.SkillInstaller.LockEntry" })

const LockFile = Schema.Struct({
  skills: Schema.Record(Schema.String, LockEntry),
}).annotate({ identifier: "Rika.Cli.SkillInstaller.LockFile" })

type LockFile = typeof LockFile.Type

export const layer: Layer.Layer<Service, never, Config.Service | Time.Service | System> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const time = yield* Time.Service
    const system = yield* System

    return Service.of({
      install: Effect.fn("Cli.SkillInstaller.install")(function* (input: InstallInput) {
        const values = yield* config.get
        const parsedSource = yield* parseSource(system.home, input.source)
        const temp = yield* system.makeTempDirectory("rika-skill-")
        return yield* installFromClone(values.workspace_root, time, system, input, parsedSource, temp).pipe(
          Effect.ensuring(system.remove(temp).pipe(Effect.ignore)),
        )
      }),
      remove: Effect.fn("Cli.SkillInstaller.remove")(function* (input: RemoveInput) {
        const values = yield* config.get
        yield* validateSkillName(input.name)
        const root = skillRoot(values.workspace_root, system.home, input.scope)
        const directory = join(root, input.name)
        const lockPath = join(root, "skills-lock.json")
        if (!(yield* system.exists(directory))) {
          return yield* new SkillInstallerError({
            message: `Skill ${input.name} is not installed at ${directory}`,
            operation: "remove",
            exit_code: 1,
            path: directory,
            name: input.name,
          })
        }
        if (!(yield* system.isDirectory(directory))) {
          return yield* new SkillInstallerError({
            message: `Skill ${input.name} is not an installed directory at ${directory}`,
            operation: "remove",
            exit_code: 1,
            path: directory,
            name: input.name,
          })
        }
        yield* system.remove(directory)
        const lock = yield* readLock(system, lockPath)
        const nextLock = { skills: { ...lock.skills } }
        delete nextLock.skills[input.name]
        yield* writeLock(system, lockPath, nextLock)
        return {
          action: "remove",
          name: input.name,
          scope: input.scope,
          directory,
          removed: true,
        } satisfies RemoveResult
      }),
    })
  }),
)

export const systemLayer = (options: { readonly home?: string; readonly temp?: string } = {}) =>
  Layer.succeed(System, nodeSystem(options.home ?? homedir(), options.temp ?? tmpdir()))

export const liveLayer = layer.pipe(Layer.provide(systemLayer()))

export const fakeLayer = Layer.succeed(
  Service,
  Service.of({
    install: () =>
      Effect.fail(
        new SkillInstallerError({
          message: "Skill installer fake has no install implementation",
          operation: "install",
          exit_code: 1,
        }),
      ),
    remove: () =>
      Effect.fail(
        new SkillInstallerError({
          message: "Skill installer fake has no remove implementation",
          operation: "remove",
          exit_code: 1,
        }),
      ),
  }),
)

export const install = Effect.fn("Cli.SkillInstaller.install.call")(function* (input: InstallInput) {
  const service = yield* Service
  return yield* service.install(input)
})

export const remove = Effect.fn("Cli.SkillInstaller.remove.call")(function* (input: RemoveInput) {
  const service = yield* Service
  return yield* service.remove(input)
})

interface ParsedSource {
  readonly cloneUrl: string
  readonly path: string
}

const installFromClone = (
  workspaceRoot: string,
  time: Time.Interface,
  system: SystemInterface,
  input: InstallInput,
  source: ParsedSource,
  temp: string,
) =>
  Effect.gen(function* () {
    const clonePath = join(temp, "repo")
    yield* system.runGit(temp, ["clone", "--depth", "1", source.cloneUrl, clonePath])
    const commit = (yield* system.runGit(clonePath, ["rev-parse", "HEAD"])).trim()
    const sourceDirectory = yield* safeJoin(clonePath, source.path, "sourcePath")
    const definition = yield* readSkillDefinition(system, sourceDirectory)
    yield* validateSkillName(definition.name)
    const root = skillRoot(workspaceRoot, system.home, input.scope)
    const target = join(root, definition.name)
    const lockPath = join(root, "skills-lock.json")
    if ((yield* system.exists(target)) && !input.force) {
      return yield* new SkillInstallerError({
        message: `Skill ${definition.name} already exists at ${target}; rerun with --force to overwrite`,
        operation: "install",
        exit_code: 1,
        path: target,
        name: definition.name,
      })
    }
    yield* system.makeDirectory(root)
    const staging = join(root, `.${definition.name}.installing-${Date.now()}`)
    yield* system.remove(staging)
    yield* system.copyDirectory(sourceDirectory, staging)
    if (input.force) yield* system.remove(target)
    yield* system.rename(staging, target)
    const installedAt = yield* time.nowMillis
    const lock = yield* readLock(system, lockPath)
    const nextLock = {
      skills: {
        ...lock.skills,
        [definition.name]: {
          source: input.source,
          commit,
          installed_at: installedAt,
          scope: input.scope,
          directory: target,
        },
      },
    }
    yield* writeLock(system, lockPath, nextLock)
    return {
      action: "add",
      name: definition.name,
      scope: input.scope,
      source: input.source,
      commit,
      directory: target,
      installed_at: installedAt,
    } satisfies InstallResult
  })

const readSkillDefinition = (system: SystemInterface, directory: string) =>
  Effect.gen(function* () {
    const skillFile = join(directory, "SKILL.md")
    if (!(yield* system.isFile(skillFile))) {
      return yield* new SkillInstallerError({
        message: `No SKILL.md found at ${skillFile}`,
        operation: "readSkill",
        exit_code: 1,
        path: skillFile,
      })
    }
    const parsed = SkillRegistry.parseSkillMarkdown(yield* system.readText(skillFile))
    if (parsed !== undefined) return parsed
    return yield* new SkillInstallerError({
      message: `Invalid skill frontmatter in ${skillFile}`,
      operation: "readSkill",
      exit_code: 1,
      path: skillFile,
    })
  })

const readLock = (system: SystemInterface, path: string): Effect.Effect<LockFile, SkillInstallerError> =>
  Effect.gen(function* () {
    if (!(yield* system.exists(path))) return { skills: {} }
    const raw = yield* system.readText(path)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new SkillInstallerError({ message: errorMessage(cause), operation: "readLock", exit_code: 1, path }),
    })
    const decoded = Schema.decodeUnknownOption(LockFile)(parsed)
    if (decoded._tag === "Some") return decoded.value
    return yield* new SkillInstallerError({
      message: `Invalid skills lockfile at ${path}`,
      operation: "readLock",
      exit_code: 1,
      path,
    })
  })

const writeLock = (system: SystemInterface, path: string, lock: LockFile) =>
  Effect.gen(function* () {
    yield* system.makeDirectory(dirname(path))
    yield* system.writeText(path, `${JSON.stringify(lock, null, 2)}\n`)
  })

const parseSource = (home: string, source: string): Effect.Effect<ParsedSource, SkillInstallerError> => {
  const [base, fragment] = splitFragment(source)
  const path = normalizedSourcePath(fragment)
  const url = tryUrl(base)
  if (url !== undefined) {
    if (url.protocol === "file:") return Effect.succeed({ cloneUrl: url.href, path })
    if (url.hostname === "github.com") return githubUrlSource(url, path)
    return Effect.succeed({ cloneUrl: base, path })
  }
  if (isLocalPath(base)) return Effect.succeed({ cloneUrl: expandHome(home, base), path })
  const segments = base.split("/").filter((segment) => segment.length > 0)
  if (segments.length >= 2) {
    const [owner, repo, ...rest] = segments
    if (owner !== undefined && repo !== undefined) {
      return Effect.succeed({
        cloneUrl: `https://github.com/${owner}/${stripGitSuffix(repo)}.git`,
        path: normalizedSourcePath(fragment ?? rest.join("/")),
      })
    }
  }
  return Effect.fail(
    new SkillInstallerError({ message: `Unsupported skill source ${source}`, operation: "parseSource", exit_code: 2 }),
  )
}

const githubUrlSource = (url: URL, fragmentPath: string): Effect.Effect<ParsedSource, SkillInstallerError> => {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0)
  const [owner, repo, ...rest] = segments
  if (owner === undefined || repo === undefined) {
    return Effect.fail(
      new SkillInstallerError({
        message: `Unsupported GitHub skill source ${url.href}`,
        operation: "parseSource",
        exit_code: 2,
      }),
    )
  }
  const path =
    fragmentPath !== "."
      ? fragmentPath
      : rest[0] === "tree" || rest[0] === "blob"
        ? normalizedSourcePath(rest.slice(2).join("/"))
        : normalizedSourcePath(rest.join("/"))
  return Effect.succeed({ cloneUrl: `https://github.com/${owner}/${stripGitSuffix(repo)}.git`, path })
}

const safeJoin = (root: string, path: string, operation: string) =>
  Effect.gen(function* () {
    const resolved = resolve(root, path)
    const relativePath = relative(root, resolved)
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return yield* new SkillInstallerError({
        message: `Skill source path escapes cloned repository: ${path}`,
        operation,
        exit_code: 2,
        path,
      })
    }
    return resolved
  })

const validateSkillName = (name: string) =>
  name !== "." && name !== ".." && name.toLowerCase() !== "skills-lock.json" && /^[A-Za-z0-9._-]+$/.test(name)
    ? Effect.void
    : Effect.fail(
        new SkillInstallerError({
          message: `Skill name ${name} is not safe for a skill directory`,
          operation: "validateSkill",
          exit_code: 1,
          name,
        }),
      )

const skillRoot = (workspaceRoot: string, home: string, scope: Scope) =>
  scope === "project" ? join(workspaceRoot, ".agents", "skills") : join(home, ".config", "rika", "skills")

const splitFragment = (source: string): readonly [string, string | undefined] => {
  const index = source.indexOf("#")
  if (index < 0) return [source, undefined]
  return [source.slice(0, index), source.slice(index + 1)]
}

const normalizedSourcePath = (path: string | undefined) => {
  const normalized = path?.trim()
  return normalized === undefined || normalized.length === 0 ? "." : normalized
}

const tryUrl = (source: string) => {
  try {
    return new URL(source)
  } catch {
    return undefined
  }
}

const isLocalPath = (source: string) =>
  source.startsWith(".") || source.startsWith("/") || source.startsWith("~") || source.startsWith("file:")

const expandHome = (home: string, path: string) =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path

const stripGitSuffix = (value: string) => value.replace(/\.git$/, "")

function nodeSystem(home: string, temp: string): SystemInterface {
  return {
    home,
    exists: (path) =>
      Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
        Effect.map((value) => value !== undefined),
        Effect.catch(() => Effect.succeed(false)),
      ),
    isFile: (path) =>
      Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
        Effect.map((value) => value?.isFile() ?? false),
        Effect.catch(() => Effect.succeed(false)),
      ),
    isDirectory: (path) =>
      Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
        Effect.map((value) => value?.isDirectory() ?? false),
        Effect.catch(() => Effect.succeed(false)),
      ),
    makeDirectory: (path) =>
      Effect.tryPromise({
        try: () => mkdir(path, { recursive: true }).then(() => undefined),
        catch: (cause) => systemError("makeDirectory", cause, path),
      }),
    makeTempDirectory: (prefix) =>
      Effect.tryPromise({
        try: () => mkdtemp(join(temp, prefix)),
        catch: (cause) => systemError("makeTempDirectory", cause, temp),
      }),
    readText: (path) =>
      Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => systemError("readText", cause, path),
      }),
    writeText: (path, text) =>
      Effect.tryPromise({
        try: () => writeFile(path, text, "utf8"),
        catch: (cause) => systemError("writeText", cause, path),
      }),
    remove: (path) =>
      Effect.tryPromise({
        try: () => rm(path, { recursive: true, force: true }),
        catch: (cause) => systemError("remove", cause, path),
      }),
    rename: (from, to) =>
      Effect.tryPromise({
        try: () => rename(from, to),
        catch: (cause) => systemError("rename", cause, from),
      }),
    copyDirectory: (from, to) =>
      Effect.tryPromise({
        try: () => cp(from, to, { recursive: true, filter: (path) => basename(path) !== ".git" }),
        catch: (cause) => systemError("copyDirectory", cause, from),
      }),
    runGit: (cwd, args) =>
      Effect.tryPromise({
        try: async () => {
          const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ])
          if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
          return stdout
        },
        catch: (cause) => systemError("runGit", cause, cwd),
      }),
  }
}

const systemError = (operation: string, cause: unknown, path?: string) =>
  new SkillInstallerError({
    message: errorMessage(cause),
    operation,
    exit_code: 1,
    ...(path === undefined ? {} : { path }),
  })

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
