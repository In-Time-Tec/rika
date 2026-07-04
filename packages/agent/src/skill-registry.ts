import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Config } from "@rika/core"
import { Mcp } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

export const Source = Schema.Literals(["project", "user", "legacy", "built-in"]).annotate({
  identifier: "Rika.Agent.SkillRegistry.Source",
})
export type Source = typeof Source.Type

export interface Location extends Schema.Schema.Type<typeof Location> {}
export const Location = Schema.Struct({
  source: Source,
  root: Schema.String,
}).annotate({ identifier: "Rika.Agent.SkillRegistry.Location" })

export interface SkillSummary extends Schema.Schema.Type<typeof SkillSummary> {}
export const SkillSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  source: Source,
  directory: Schema.String,
  skill_file: Schema.String,
}).annotate({ identifier: "Rika.Agent.SkillRegistry.SkillSummary" })

export interface SkillResource extends Schema.Schema.Type<typeof SkillResource> {}
export const SkillResource = Schema.Struct({
  path: Schema.String,
  relative_path: Schema.String,
}).annotate({ identifier: "Rika.Agent.SkillRegistry.SkillResource" })

export interface Skill extends Schema.Schema.Type<typeof Skill> {}
export const Skill = Schema.Struct({
  summary: SkillSummary,
  instructions: Schema.String,
  resources: Schema.Array(SkillResource),
  mcp_servers: Schema.optional(Mcp.ServerMap),
}).annotate({ identifier: "Rika.Agent.SkillRegistry.Skill" })

export interface SelectInput extends Schema.Schema.Type<typeof SelectInput> {}
export const SelectInput = Schema.Struct({
  content: Schema.String,
}).annotate({ identifier: "Rika.Agent.SkillRegistry.SelectInput" })

export interface Selection extends Schema.Schema.Type<typeof Selection> {}
export const Selection = Schema.Struct({
  available: Schema.Array(SkillSummary),
  selected: Schema.Array(Skill),
}).annotate({ identifier: "Rika.Agent.SkillRegistry.Selection" })

export class SkillRegistryError extends Schema.TaggedErrorClass<SkillRegistryError>()("SkillRegistryError", {
  message: Schema.String,
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<SkillSummary>, SkillRegistryError>
  readonly inspect: (name: string) => Effect.Effect<Skill, SkillRegistryError>
  readonly selectForPrompt: (input: SelectInput) => Effect.Effect<Selection, SkillRegistryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/SkillRegistry") {}

interface FileSystemAdapter {
  readonly list: (path: string) => Effect.Effect<ReadonlyArray<DirectoryEntry>, SkillRegistryError>
  readonly readText: (path: string) => Effect.Effect<string, SkillRegistryError>
  readonly isDirectory: (path: string) => Effect.Effect<boolean>
  readonly isFile: (path: string) => Effect.Effect<boolean>
}

interface DirectoryEntry {
  readonly name: string
  readonly isDirectory: boolean
  readonly isFile: boolean
}

export const layer: Layer.Layer<Service, never, Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    return makeService(nodeFileSystem, defaultLocations(values.workspace_root))
  }),
)

export const layerFromLocations = (locations: ReadonlyArray<Location>) =>
  Layer.succeed(Service, makeService(nodeFileSystem, locations))

export const fakeLayer = (skills: ReadonlyArray<Skill> = []) => Layer.succeed(Service, makeInMemoryService(skills))

export const emptyLayer = fakeLayer([])

export const list = Effect.fn("SkillRegistry.list.call")(function* () {
  const service = yield* Service
  return yield* service.list()
})

export const inspect = Effect.fn("SkillRegistry.inspect.call")(function* (name: string) {
  const service = yield* Service
  return yield* service.inspect(name)
})

export const selectForPrompt = Effect.fn("SkillRegistry.selectForPrompt.call")(function* (input: SelectInput) {
  const service = yield* Service
  return yield* service.selectForPrompt(input)
})

const makeService = (fileSystem: FileSystemAdapter, locations: ReadonlyArray<Location>): Interface =>
  Service.of({
    list: Effect.fn("SkillRegistry.list")(function* () {
      const skills = yield* discoverSkills(fileSystem, locations)
      return skills.map((skill) => skill.summary)
    }),
    inspect: Effect.fn("SkillRegistry.inspect")(function* (name: string) {
      const skills = yield* discoverSkills(fileSystem, locations)
      const skill = skills.find((candidate) => candidate.summary.name === name)
      if (skill !== undefined) return skill
      return yield* new SkillRegistryError({ message: `Skill ${name} was not found`, operation: "inspect", name })
    }),
    selectForPrompt: Effect.fn("SkillRegistry.selectForPrompt")(function* (input: SelectInput) {
      const skills = yield* discoverSkills(fileSystem, locations)
      return selectSkills(input.content, skills)
    }),
  })

function makeInMemoryService(skills: ReadonlyArray<Skill>): Interface {
  const deduped = dedupeSkills(skills)
  return Service.of({
    list: Effect.fn("SkillRegistry.fake.list")(function* () {
      return deduped.map((skill) => skill.summary)
    }),
    inspect: Effect.fn("SkillRegistry.fake.inspect")(function* (name: string) {
      const skill = deduped.find((candidate) => candidate.summary.name === name)
      if (skill !== undefined) return skill
      return yield* new SkillRegistryError({ message: `Skill ${name} was not found`, operation: "inspect", name })
    }),
    selectForPrompt: Effect.fn("SkillRegistry.fake.selectForPrompt")(function* (input: SelectInput) {
      return selectSkills(input.content, deduped)
    }),
  })
}

const discoverSkills = (fileSystem: FileSystemAdapter, locations: ReadonlyArray<Location>) =>
  Effect.gen(function* () {
    const skills: Array<Skill> = []
    for (const location of locations) {
      if (!(yield* fileSystem.isDirectory(location.root))) continue
      const entries = yield* fileSystem.list(location.root).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory) continue
        const directory = join(location.root, entry.name)
        const skill = yield* readSkill(fileSystem, location, directory).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (skill !== undefined) skills.push(skill)
      }
    }
    return dedupeSkills(skills)
  })

const readSkill = (fileSystem: FileSystemAdapter, location: Location, directory: string) =>
  Effect.gen(function* () {
    const skillFile = join(directory, "SKILL.md")
    if (!(yield* fileSystem.isFile(skillFile))) return undefined
    const content = yield* fileSystem.readText(skillFile)
    const parsed = parseSkillMarkdown(content)
    if (parsed === undefined) return undefined
    const resources = yield* resourcePaths(fileSystem, directory)
    const mcpServers = yield* readMcpServers(fileSystem, directory)
    return {
      summary: {
        name: parsed.name,
        description: parsed.description,
        source: location.source,
        directory,
        skill_file: skillFile,
      },
      instructions: parsed.body,
      resources,
      ...(mcpServers === undefined ? {} : { mcp_servers: mcpServers }),
    }
  })

const selectSkills = (content: string, skills: ReadonlyArray<Skill>): Selection => {
  const selected = skills.filter((skill) => promptSelectsSkill(content, skill.summary.name))
  return { available: skills.map((skill) => skill.summary), selected }
}

const promptSelectsSkill = (content: string, name: string) => {
  const normalizedName = name.toLowerCase()
  const explicit = explicitSkillNames(content).map((value) => value.toLowerCase())
  if (explicit.includes(normalizedName)) return true

  const escaped = escapeRegExp(name)
  const end = String.raw`(?=$|[^A-Za-z0-9._-])`
  return [
    new RegExp(String.raw`\buse\s+skill\s+${escaped}${end}`, "i"),
    new RegExp(String.raw`\bload\s+skill\s+${escaped}${end}`, "i"),
    new RegExp(String.raw`\buse\s+the\s+${escaped}\s+skill\b`, "i"),
    new RegExp(String.raw`\buse\s+${escaped}\s+skill\b`, "i"),
  ].some((pattern) => pattern.test(content))
}

const explicitSkillNames = (content: string) => {
  const values: Array<string> = []
  for (const match of content.matchAll(/(?:@skill:|skill:|\/skill\s+)([A-Za-z0-9._-]+)/g)) {
    if (match[1] !== undefined) values.push(match[1])
  }
  return values
}

function dedupeSkills(skills: ReadonlyArray<Skill>) {
  const seen = new Set<string>()
  const result: Array<Skill> = []
  for (const skill of skills) {
    if (seen.has(skill.summary.name)) continue
    seen.add(skill.summary.name)
    result.push(skill)
  }
  return result
}

const resourcePaths = (fileSystem: FileSystemAdapter, directory: string) =>
  Effect.gen(function* () {
    const paths = yield* walkFiles(fileSystem, directory)
    return paths
      .filter((path) => basename(path) !== "SKILL.md")
      .map((path) => ({ path, relative_path: slashPath(relative(directory, path)) }))
  })

const walkFiles = (
  fileSystem: FileSystemAdapter,
  directory: string,
): Effect.Effect<ReadonlyArray<string>, SkillRegistryError> =>
  Effect.gen(function* () {
    const entries = yield* fileSystem.list(directory).pipe(Effect.catch(() => Effect.succeed([])))
    const files: Array<string> = []
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory) files.push(...(yield* walkFiles(fileSystem, path)))
      if (entry.isFile) files.push(path)
    }
    return files
  })

export const parseSkillMarkdown = (content: string) => {
  const frontmatter = parseFrontmatter(content)
  if (frontmatter === undefined) return undefined
  const name = frontmatter.fields.get("name")?.trim()
  const description = frontmatter.fields.get("description")?.trim()
  if (name === undefined || name.length === 0 || description === undefined || description.length === 0) return undefined
  return { name, description, body: frontmatter.body }
}

const readMcpServers = (fileSystem: FileSystemAdapter, directory: string) =>
  Effect.gen(function* () {
    const path = join(directory, "mcp.json")
    if (!(yield* fileSystem.isFile(path))) return undefined
    const content = yield* fileSystem.readText(path)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause) => fileError("parseMcpJson", path, cause),
    })
    const decoded = Schema.decodeUnknownOption(Mcp.ServerMap)(parsed)
    if (decoded._tag === "Some") return decoded.value
    return yield* new SkillRegistryError({
      message: `Invalid skill MCP config in ${path}`,
      operation: "decodeMcpJson",
      path,
    })
  })

const parseFrontmatter = (content: string) => {
  if (!content.startsWith("---\n")) return undefined
  const end = content.indexOf("\n---", 4)
  if (end < 0) return undefined
  const fields = new Map<string, string>()
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    fields.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()))
  }
  return { fields, body: content.slice(end + 4).replace(/^\r?\n/, "") }
}

const defaultLocations = (workspaceRoot: string): ReadonlyArray<Location> => {
  const home = homedir()
  const builtInRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "skills")
  return [
    { source: "project", root: join(workspaceRoot, ".agents", "skills") },
    { source: "project", root: join(workspaceRoot, ".claude", "skills") },
    { source: "user", root: join(home, ".config", "agents", "skills") },
    { source: "user", root: join(home, ".agents", "skills") },
    { source: "user", root: join(home, ".config", "rika", "skills") },
    { source: "legacy", root: join(home, ".config", "amp", "skills") },
    { source: "legacy", root: join(home, ".claude", "skills") },
    { source: "built-in", root: builtInRoot },
  ]
}

const nodeFileSystem: FileSystemAdapter = {
  list: (path) =>
    Effect.tryPromise({
      try: async () => {
        const entries = await readdir(path, { withFileTypes: true })
        return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }))
      },
      catch: (cause) => fileError("list", path, cause),
    }),
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => fileError("readText", path, cause),
    }),
  isDirectory: (path) =>
    Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
      Effect.map((value) => value?.isDirectory() ?? false),
      Effect.catch(() => Effect.succeed(false)),
    ),
  isFile: (path) =>
    Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
      Effect.map((value) => value?.isFile() ?? false),
      Effect.catch(() => Effect.succeed(false)),
    ),
}

const fileError = (operation: string, path: string, cause: unknown) =>
  new SkillRegistryError({
    message: `${operation} failed for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    operation,
    path,
  })

const unquote = (value: string) => value.replace(/^['"]|['"]$/g, "")
const slashPath = (path: string) => path.split(sep).join("/")
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
