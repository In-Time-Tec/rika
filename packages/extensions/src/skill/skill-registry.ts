import { SkillSource } from "@batonfx/core"
import { SkillLoader } from "@batonfx/skills"
import { Crypto, Effect, Encoding, FileSystem, Layer, Path, Schema } from "effect"
import { SkillFileSystem } from "./skill-file-system"

export const layer = Layer.effect(
  SkillFileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return SkillFileSystem.of({
      exists: (path) => fileSystem.exists(path),
      readDirectory: (path) => fileSystem.readDirectory(path, { recursive: true }),
      readFileString: (path) => fileSystem.readFileString(path),
      isFile: (path) => fileSystem.stat(path).pipe(Effect.map((info) => info.type === "File")),
      realPath: (path) => fileSystem.realPath(path),
    })
  }),
)

export interface Options {
  readonly globalRoot: string
  readonly workspaceRoot: string
  readonly descriptionCap?: number
  readonly workspaceTrusted?: boolean
}

export type Origin = "global" | "workspace"

export interface Executable {
  readonly name: string
  readonly importName: string
  readonly digest: string
  readonly origin: Origin
  readonly importable: boolean
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
  readonly executable: ReadonlyArray<Executable>
  readonly digest: string
  readonly executableDigest: string
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

const failure = (operation: string, path: string, cause: unknown) =>
  SkillRegistryError.make({ operation, path, message: cause instanceof Error ? cause.message : String(cause), cause })

const contained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const importNameOf = (manifest: string): string | undefined => {
  const parsed: unknown = JSON.parse(manifest)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const rika = document["rika"]
  if (typeof rika !== "object" || rika === null || Array.isArray(rika)) return undefined
  if ((rika as Record<string, unknown>)["kind"] !== "skill") return undefined
  const declared = (rika as Record<string, unknown>)["importName"]
  if (typeof declared === "string" && declared.length > 0) return declared
  const name = document["name"]
  return typeof name === "string" && name.length > 0 ? name : undefined
}

const discoverImplementation = (
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
    const source = SkillSource.merge(global, workspace)
    const skills = yield* source.all.pipe(Effect.mapError(failure.bind(undefined, "list", options.workspaceRoot)))
    const canonical = skills.toSorted((left, right) => left.frontmatter.name.localeCompare(right.frontmatter.name))
    const digestBytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(canonical.map((skill) => skill.listing).join("\n")))
      .pipe(Effect.mapError(failure.bind(undefined, "digest", options.workspaceRoot)))
    const executable: Array<Executable> = []
    for (const skill of canonical) {
      const name = skill.frontmatter.name
      const workspaceSkill = yield* workspace.get(name).pipe(Effect.mapError(failure.bind(undefined, "discover", name)))
      const origin: Origin = workspaceSkill === undefined ? "global" : "workspace"
      const root = path.resolve(origin === "global" ? options.globalRoot : options.workspaceRoot)
      const directory = path.join(root, name)
      const manifestPath = path.join(directory, "package.json")
      /**
       * Discovery reads its root recursively and follows what it finds, so a link inside the root
       * can name a directory outside it. A skill is executable content, so where it really lives
       * decides whether the root bounded anything.
       */

      const present = yield* skillFileSystem
        .exists(manifestPath)
        .pipe(Effect.mapError((cause) => failure("discover", manifestPath, cause)))
      if (!present) continue
      const isFile = yield* skillFileSystem
        .isFile(manifestPath)
        .pipe(Effect.mapError((cause) => failure("discover", manifestPath, cause)))
      if (!isFile) continue
      const realDirectory = yield* skillFileSystem
        .realPath(directory)
        .pipe(Effect.mapError((cause) => failure("discover", directory, cause)))
      /**
       * Discovery reads its root recursively and follows what it finds, so a link inside the root
       * can name a directory outside it. A skill is executable content, so where it really lives
       * decides whether the root bounded anything.
       */
      const realRoot = yield* skillFileSystem
        .realPath(root)
        .pipe(Effect.mapError((cause) => failure("discover", root, cause)))
      if (!contained(path, realRoot, realDirectory))
        return yield* failure("discover", directory, "Skill directory escapes its configured root")
      const realManifest = yield* skillFileSystem
        .realPath(manifestPath)
        .pipe(Effect.mapError((cause) => failure("discover", manifestPath, cause)))
      if (!contained(path, realDirectory, realManifest))
        return yield* failure("discover", manifestPath, "Skill manifest escapes skill directory")
      const content = yield* skillFileSystem
        .readFileString(realManifest)
        .pipe(Effect.mapError((cause) => failure("discover", manifestPath, cause)))
      const importName = yield* Effect.try({
        try: () => importNameOf(content),
        catch: (cause) => failure("discover", manifestPath, cause),
      })
      if (importName === undefined) continue
      const entryBytes = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${name}\0${importName}\0${content}`))
        .pipe(Effect.mapError(failure.bind(undefined, "digest", manifestPath)))
      executable.push({
        name,
        importName,
        digest: Encoding.encodeHex(entryBytes),
        origin,
        importable: origin === "global" || options.workspaceTrusted === true,
      })
    }
    const executableDigestBytes = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          executable
            .map((entry) => `${entry.name}\0${entry.importName}\0${entry.digest}\0${entry.importable}`)
            .join("\n"),
        ),
      )
      .pipe(Effect.mapError(failure.bind(undefined, "digest", options.workspaceRoot)))
    const activate = Effect.fn("SkillRegistry.activate")((name: string) =>
      Effect.gen(function* () {
        const skill = yield* source.get(name).pipe(Effect.mapError(failure.bind(undefined, "activate", name)))
        if (skill === undefined) return yield* failure("activate", name, "Skill not found")
        const workspaceSkill = yield* workspace
          .get(name)
          .pipe(Effect.mapError(failure.bind(undefined, "activate", name)))
        const root = workspaceSkill === undefined ? options.globalRoot : options.workspaceRoot
        const directory = path.join(path.resolve(root), name)
        const exists = yield* skillFileSystem
          .exists(directory)
          .pipe(Effect.mapError((cause) => failure("activate", directory, cause)))
        if (!exists) return yield* failure("activate", directory, "Skill directory was deleted")
        const realDirectory = yield* skillFileSystem
          .realPath(directory)
          .pipe(Effect.mapError((cause) => failure("activate", directory, cause)))
        const manifest = path.join(directory, "SKILL.md")
        const realManifest = yield* skillFileSystem
          .realPath(manifest)
          .pipe(Effect.mapError((cause) => failure("activate", manifest, cause)))
        if (!contained(path, realDirectory, realManifest))
          return yield* failure("activate", manifest, "Skill manifest escapes skill directory")
        const body = yield* skill.body.pipe(Effect.mapError(failure.bind(undefined, "activate", name)))
        const entries = yield* skillFileSystem
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => failure("activate", directory, cause)))
        const resources: Array<Resource> = []
        for (const entry of entries.toSorted()) {
          const resourcePath = path.resolve(directory, entry)
          if (!contained(path, directory, resourcePath))
            return yield* failure("activate", resourcePath, "Resource path escapes skill directory")
          if (path.basename(resourcePath) === "SKILL.md") continue
          const isFile = yield* skillFileSystem
            .isFile(resourcePath)
            .pipe(Effect.mapError((cause) => failure("activate", resourcePath, cause)))
          if (!isFile) continue
          const realResourcePath = yield* skillFileSystem
            .realPath(resourcePath)
            .pipe(Effect.mapError((cause) => failure("activate", resourcePath, cause)))
          if (!contained(path, realDirectory, realResourcePath))
            return yield* failure("activate", resourcePath, "Resource path escapes skill directory")
          const content = yield* skillFileSystem
            .readFileString(realResourcePath)
            .pipe(Effect.mapError((cause) => failure("activate", resourcePath, cause)))
          resources.push({ path: path.relative(directory, resourcePath), content })
        }
        return { body, resources }
      }),
    )
    return {
      source,
      listings: canonical.map((skill) => skill.listing),
      executable,
      digest: Encoding.encodeHex(digestBytes),
      executableDigest: Encoding.encodeHex(executableDigestBytes),
      activate,
    }
  })

export function discover(options: Options): Effect.Effect<Discovered, SkillRegistryError>
export function discover(options: Options) {
  return discoverImplementation(options)
}
