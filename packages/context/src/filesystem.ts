import { sameBinding, WorkspaceBinding } from "@rika/execution"
import { Effect, FileSystem, Path } from "effect"
import { SkillCatalog } from "generalist"
import { FileSystemCatalog } from "generalist/instructions/skills"
import type { GuidanceFile } from "./contract"
import { WorkspaceReaderError, type WorkspaceReaderService, validateBinding } from "./workspace"

const guidanceNames = ["AGENTS.md", "AGENT.md", "CLAUDE.md"] as const
const skillRoots = [".agents/skills", ".claude/skills", ".pi/skills"] as const
const maximumGuidanceFiles = 1
const maximumGuidanceBytes = 64 * 1024
const maximumSkillFiles = 64
const maximumSkillBytes = 64 * 1024
const maximumSkillFrontmatterBytes = 64 * 1024

const failure = (reason: WorkspaceReaderError["reason"], message: string) =>
  WorkspaceReaderError.make({ reason, message })

const unavailable = () => failure("unavailable", "Workspace content is unavailable")

const skillFailure = (message: string) => SkillCatalog.SkillCatalogError.make({ source: "workspace", message })

const contained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const containedInAny = (path: Path.Path, roots: ReadonlyArray<string>, candidate: string): boolean =>
  roots.some((root) => contained(path, root, candidate))

const realDirectory = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  candidate: string,
): Effect.Effect<string, WorkspaceReaderError> =>
  Effect.gen(function* () {
    const resolved = path.normalize(candidate)
    if (!contained(path, root, resolved))
      return yield* failure("forbidden", "Workspace content resolves outside checkout")
    const real = yield* fileSystem.realPath(resolved).pipe(Effect.mapError(unavailable))
    if (!contained(path, root, real)) return yield* failure("forbidden", "Workspace content resolves outside checkout")
    const info = yield* fileSystem.stat(real).pipe(Effect.mapError(unavailable))
    if (info.type !== "Directory") return yield* failure("malformed", "Workspace content must be a directory")
    return real
  })

interface RealFile {
  readonly path: string
  readonly size: FileSystem.Size
}

const realFile = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  candidate: string,
): Effect.Effect<RealFile, WorkspaceReaderError> =>
  Effect.gen(function* () {
    const resolved = path.normalize(candidate)
    if (!contained(path, root, resolved))
      return yield* failure("forbidden", "Workspace content resolves outside checkout")
    const real = yield* fileSystem.realPath(resolved).pipe(Effect.mapError(unavailable))
    if (!contained(path, root, real)) return yield* failure("forbidden", "Workspace content resolves outside checkout")
    const info = yield* fileSystem.stat(real).pipe(Effect.mapError(unavailable))
    if (info.type !== "File") return yield* failure("malformed", "Workspace content must be a file")
    return { path: real, size: info.size }
  })

const boundedFile = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  candidate: string,
  limit: number,
  message: string,
): Effect.Effect<string, WorkspaceReaderError> =>
  realFile(fileSystem, path, root, candidate).pipe(
    Effect.flatMap((file) => {
      if (file.size > BigInt(limit)) return Effect.fail(failure("forbidden", message))
      return fileSystem.readFileString(file.path).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((content) =>
          new TextEncoder().encode(content).byteLength > limit
            ? Effect.fail(failure("forbidden", message))
            : Effect.succeed(content),
        ),
      )
    }),
  )

const verifyBinding = (
  expected: WorkspaceBinding,
  received: WorkspaceBinding,
): Effect.Effect<void, WorkspaceReaderError> =>
  validateBinding(received).pipe(
    Effect.flatMap((valid) =>
      sameBinding(valid, expected)
        ? Effect.void
        : Effect.fail(failure("binding", "Workspace binding does not match this reader")),
    ),
  )

const readGuidance = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  checkout: string,
): Effect.Effect<ReadonlyArray<GuidanceFile>, WorkspaceReaderError> =>
  Effect.gen(function* () {
    const files: Array<GuidanceFile> = []
    for (const name of guidanceNames) {
      if (files.length === maximumGuidanceFiles) break
      const candidate = path.join(checkout, name)
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.mapError(unavailable))
      if (!exists) continue
      const content = yield* boundedFile(
        fileSystem,
        path,
        checkout,
        candidate,
        maximumGuidanceBytes,
        "Workspace guidance exceeds the configured size limit",
      )
      files.push({ path: name, content })
    }
    return files
  })

const discoveredSkillRoots = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  checkout: string,
): Effect.Effect<ReadonlyArray<string>, WorkspaceReaderError> =>
  Effect.gen(function* () {
    const roots: Array<string> = []
    let manifestCount = 0
    for (const configuredRoot of skillRoots) {
      const candidateRoot = path.join(checkout, configuredRoot)
      const exists = yield* fileSystem.exists(candidateRoot).pipe(Effect.mapError(unavailable))
      if (!exists) continue
      const root = yield* realDirectory(fileSystem, path, checkout, candidateRoot)
      if (!roots.includes(root)) roots.push(root)
      const entries = yield* fileSystem.readDirectory(root, { recursive: true }).pipe(Effect.mapError(unavailable))
      for (const entry of entries.toSorted()) {
        const candidate = path.resolve(root, entry)
        if (!contained(path, root, candidate))
          return yield* failure("forbidden", "Workspace skill resolves outside its configured root")
        if (path.basename(candidate) !== "SKILL.md") continue
        const file = yield* realFile(fileSystem, path, root, candidate)
        if (file.size > BigInt(maximumSkillBytes))
          return yield* failure("forbidden", "Workspace skill exceeds the configured size limit")
        manifestCount += 1
        if (manifestCount > maximumSkillFiles)
          return yield* failure("forbidden", "Workspace skill listing exceeds the configured limit")
      }
    }
    return roots
  })

const skillManifest = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  checkout: string,
  roots: ReadonlyArray<string>,
  skill: SkillCatalog.Skill,
): Effect.Effect<RealFile, WorkspaceReaderError> =>
  Effect.gen(function* () {
    if (skill.location === undefined)
      return yield* failure("malformed", "Workspace skill metadata is missing its location")
    const directory = yield* realDirectory(fileSystem, path, checkout, skill.location)
    if (!containedInAny(path, roots, directory))
      return yield* failure("forbidden", "Workspace skill resolves outside its configured root")
    return yield* realFile(fileSystem, path, directory, path.join(directory, "SKILL.md"))
  })

const boundedSkill = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  checkout: string,
  roots: ReadonlyArray<string>,
  skill: SkillCatalog.Skill,
): Effect.Effect<SkillCatalog.Skill, WorkspaceReaderError> =>
  skillManifest(fileSystem, path, checkout, roots, skill).pipe(
    Effect.flatMap((manifest) => {
      if (manifest.size > BigInt(maximumSkillBytes))
        return Effect.fail(failure("forbidden", "Workspace skill exceeds the configured size limit"))
      return Effect.succeed({
        ...skill,
        instructions: skillManifest(fileSystem, path, checkout, roots, skill).pipe(
          Effect.mapError(() => skillFailure("Workspace skill is unavailable")),
          Effect.flatMap((current) => {
            if (current.size > BigInt(maximumSkillBytes))
              return Effect.fail(skillFailure("Workspace skill exceeds the configured size limit"))
            return skill.instructions.pipe(
              Effect.mapError(() => skillFailure("Workspace skill instructions are invalid")),
              Effect.flatMap((body) =>
                new TextEncoder().encode(body).byteLength > maximumSkillBytes
                  ? Effect.fail(skillFailure("Workspace skill exceeds the configured size limit"))
                  : Effect.succeed(body),
              ),
            )
          }),
        ),
      })
    }),
  )

const listSkills = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  checkout: string,
): Effect.Effect<ReadonlyArray<SkillCatalog.Skill>, WorkspaceReaderError> =>
  Effect.gen(function* () {
    const roots = yield* discoveredSkillRoots(fileSystem, path, checkout)
    const catalog = yield* FileSystemCatalog.make({
      cwd: checkout,
      roots,
      frontmatterMaxBytes: maximumSkillFrontmatterBytes,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => failure("malformed", "Workspace skill metadata is invalid")),
    )
    const skills = (yield* catalog.all).toSorted((left, right) => left.name.localeCompare(right.name))
    if (skills.length > maximumSkillFiles)
      return yield* failure("forbidden", "Workspace skill listing exceeds the configured limit")
    return yield* Effect.forEach(skills, (skill) => boundedSkill(fileSystem, path, checkout, roots, skill))
  })

export const filesystemWorkspaceReader = (options: {
  readonly checkout: string
  readonly binding: WorkspaceBinding
}): Effect.Effect<WorkspaceReaderService, WorkspaceReaderError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const binding = yield* validateBinding(options.binding)
    if (!sameBinding(binding, binding)) return yield* failure("binding", "Workspace binding is invalid")
    if (!path.isAbsolute(options.checkout))
      return yield* failure("forbidden", "Workspace checkout must be an absolute path")
    const checkout = yield* fileSystem.realPath(path.normalize(options.checkout)).pipe(Effect.mapError(unavailable))
    const info = yield* fileSystem.stat(checkout).pipe(Effect.mapError(unavailable))
    if (info.type !== "Directory") return yield* failure("unavailable", "Workspace checkout is unavailable")
    return {
      readGuidance: (received) =>
        verifyBinding(binding, received).pipe(Effect.flatMap(() => readGuidance(fileSystem, path, checkout))),
      listSkills: (received) =>
        verifyBinding(binding, received).pipe(Effect.flatMap(() => listSkills(fileSystem, path, checkout))),
    }
  })
