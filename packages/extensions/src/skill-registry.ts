import { SkillSource } from "@batonfx/core"
import { SkillLoader } from "@batonfx/skills"
import { Context, Crypto, Effect, Encoding, FileSystem, Function, Layer, Path, PlatformError, Schema } from "effect"

export interface Options {
  readonly globalRoot: string
  readonly workspaceRoot: string
  readonly descriptionCap?: number
}

export interface Resource {
  readonly path: string
  readonly content: string
}

export interface Activation {
  readonly body: string
  readonly resources: ReadonlyArray<Resource>
}

export interface Discovered {
  readonly source: SkillSource.Interface
  readonly listings: ReadonlyArray<string>
  readonly digest: string
  readonly activate: (name: string) => Effect.Effect<Activation, SkillRegistryError>
}

export class SkillRegistryError extends Schema.TaggedErrorClass<SkillRegistryError>()(
  "@rika/extensions/SkillRegistryError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface FileSystemInterface {
  readonly exists: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>
  readonly readFileString: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
  readonly isFile: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>
}

export class SkillFileSystem extends Context.Service<SkillFileSystem, FileSystemInterface>()(
  "@rika/extensions/skill-registry/SkillFileSystem",
) {}

export const fileSystemLayer = Layer.effect(
  SkillFileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return SkillFileSystem.of({
      exists: (path) => fileSystem.exists(path),
      readDirectory: (path) => fileSystem.readDirectory(path, { recursive: true }),
      readFileString: (path) => fileSystem.readFileString(path),
      isFile: (path) => fileSystem.stat(path).pipe(Effect.map((info) => info.type === "File")),
    })
  }),
)

const fileSystemTestLayerImpl = (
  files: Readonly<Record<string, string>>,
  directories: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  Layer.effect(
    SkillFileSystem,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const normalizedFiles = new Map(Object.entries(files).map(([name, content]) => [path.resolve(name), content]))
      const normalizedDirectories = new Map(
        Object.entries(directories).map(([name, entries]) => [path.resolve(name), entries]),
      )
      return SkillFileSystem.of({
        exists: (name) =>
          Effect.succeed(normalizedFiles.has(path.resolve(name)) || normalizedDirectories.has(path.resolve(name))),
        readDirectory: (name) => {
          const entries = normalizedDirectories.get(path.resolve(name))
          return entries === undefined ? Effect.die(`Missing test directory: ${name}`) : Effect.succeed(entries)
        },
        readFileString: (name) => {
          const content = normalizedFiles.get(path.resolve(name))
          return content === undefined ? Effect.die(`Missing test file: ${name}`) : Effect.succeed(content)
        },
        isFile: (name) => Effect.succeed(normalizedFiles.has(path.resolve(name))),
      })
    }),
  )

export const fileSystemTestLayer: {
  (
    files: Readonly<Record<string, string>>,
  ): (directories: Readonly<Record<string, ReadonlyArray<string>>>) => Layer.Layer<SkillFileSystem, never, Path.Path>
  (
    files: Readonly<Record<string, string>>,
    directories: Readonly<Record<string, ReadonlyArray<string>>>,
  ): Layer.Layer<SkillFileSystem, never, Path.Path>
} = Function.dual(2, fileSystemTestLayerImpl)

const failure = (operation: string, path: string, cause: unknown) =>
  SkillRegistryError.make({ operation, path, message: cause instanceof Error ? cause.message : String(cause), cause })

const contained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export const discover = (
  options: Options,
): Effect.Effect<Discovered, SkillRegistryError, FileSystem.FileSystem | Path.Path | Crypto.Crypto | SkillFileSystem> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const skillFileSystem = yield* SkillFileSystem
    const loaderOptions = (root: string): SkillLoader.LoadOptions => ({
      roots: [root],
      cwd: "/",
      ...(options.descriptionCap === undefined ? {} : { descriptionCap: options.descriptionCap }),
    })
    const global = yield* SkillLoader.make(loaderOptions(options.globalRoot)).pipe(
      Effect.mapError(failure.bind(undefined, "discover", options.globalRoot)),
    )
    const workspace = yield* SkillLoader.make(loaderOptions(options.workspaceRoot)).pipe(
      Effect.mapError(failure.bind(undefined, "discover", options.workspaceRoot)),
    )
    const source = SkillSource.merge([global, workspace])
    const skills = yield* source.all.pipe(Effect.mapError(failure.bind(undefined, "list", options.workspaceRoot)))
    const canonical = skills.toSorted((left, right) => left.frontmatter.name.localeCompare(right.frontmatter.name))
    const digestBytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(canonical.map((skill) => skill.listing).join("\n")))
      .pipe(Effect.mapError(failure.bind(undefined, "digest", options.workspaceRoot)))
    const activate = Effect.fn("SkillRegistry.activate")((name: string) =>
      Effect.gen(function* () {
        const skill = yield* source.get(name).pipe(Effect.mapError(failure.bind(undefined, "activate", name)))
        if (skill === undefined) return yield* failure("activate", name, "Skill not found")
        const body = yield* skill.body.pipe(Effect.mapError(failure.bind(undefined, "activate", name)))
        const workspaceSkill = yield* workspace
          .get(name)
          .pipe(Effect.mapError(failure.bind(undefined, "activate", name)))
        const root = workspaceSkill === undefined ? options.globalRoot : options.workspaceRoot
        const directory = path.join(path.resolve(root), name)
        const exists = yield* skillFileSystem
          .exists(directory)
          .pipe(Effect.mapError((cause) => failure("activate", directory, cause)))
        if (!exists) return { body, resources: [] }
        const entries = yield* skillFileSystem
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => failure("activate", directory, cause)))
        const resources: Array<Resource> = []
        for (const entry of entries.toSorted()) {
          const resourcePath = path.resolve(directory, entry)
          if (path.basename(resourcePath) === "SKILL.md") continue
          if (!contained(path, directory, resourcePath))
            return yield* failure("activate", resourcePath, "Resource path escapes skill directory")
          const isFile = yield* skillFileSystem
            .isFile(resourcePath)
            .pipe(Effect.mapError((cause) => failure("activate", resourcePath, cause)))
          if (!isFile) continue
          const content = yield* skillFileSystem
            .readFileString(resourcePath)
            .pipe(Effect.mapError((cause) => failure("activate", resourcePath, cause)))
          resources.push({ path: path.relative(directory, resourcePath), content })
        }
        return { body, resources }
      }),
    )
    return {
      source,
      listings: canonical.map((skill) => skill.listing),
      digest: Encoding.encodeHex(digestBytes),
      activate,
    }
  })
