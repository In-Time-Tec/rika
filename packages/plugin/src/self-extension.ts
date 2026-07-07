import { ArtifactStore, Database, ThreadProjection } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { Config, IdGenerator, Time } from "@rika/core"
import { createHash } from "node:crypto"

export const ExtensionKind = Schema.Literals(["skill", "plugin"]).annotate({
  identifier: "Rika.Plugin.SelfExtension.ExtensionKind",
})
export type ExtensionKind = typeof ExtensionKind.Type

export const ExtensionAction = Schema.Literals([
  "create-skill",
  "create-plugin",
  "enable-plugin",
  "disable-plugin",
  "rollback-plugin",
]).annotate({ identifier: "Rika.Plugin.SelfExtension.ExtensionAction" })
export type ExtensionAction = typeof ExtensionAction.Type

export const VerificationStatus = Schema.Literals(["passed", "failed", "skipped"]).annotate({
  identifier: "Rika.Plugin.SelfExtension.VerificationStatus",
})
export type VerificationStatus = typeof VerificationStatus.Type

export interface VerificationResult extends Schema.Schema.Type<typeof VerificationResult> {}
export const VerificationResult = Schema.Struct({
  status: VerificationStatus,
  command: Schema.optional(Schema.String),
  exit_code: Schema.optional(Schema.Int),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Plugin.SelfExtension.VerificationResult" })

export interface FileChange extends Schema.Schema.Type<typeof FileChange> {}
export const FileChange = Schema.Struct({
  path: Schema.String,
  before: Schema.Union([Schema.String, Schema.Null]),
  after: Schema.Union([Schema.String, Schema.Null]),
}).annotate({ identifier: "Rika.Plugin.SelfExtension.FileChange" })

export interface TrustDecision extends Schema.Schema.Type<typeof TrustDecision> {}
export const TrustDecision = Schema.Struct({
  model: Schema.Literal("explicit-local"),
  enabled: Schema.Boolean,
  reason: Schema.String,
  content_hash: Schema.optional(Schema.String),
  verification: VerificationResult,
}).annotate({ identifier: "Rika.Plugin.SelfExtension.TrustDecision" })

export interface ExtensionChange extends Schema.Schema.Type<typeof ExtensionChange> {}
export const ExtensionChange = Schema.Struct({
  kind: ExtensionKind,
  action: ExtensionAction,
  name: Schema.String,
  workspace_id: Ids.WorkspaceId,
  enabled: Schema.Boolean,
  artifact_id: Ids.ArtifactId,
  files: Schema.Array(FileChange),
  trust: TrustDecision,
}).annotate({ identifier: "Rika.Plugin.SelfExtension.ExtensionChange" })

export interface CreateSkillInput extends Schema.Schema.Type<typeof CreateSkillInput> {}
export const CreateSkillInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Plugin.SelfExtension.CreateSkillInput" })

export interface CreatePluginInput extends Schema.Schema.Type<typeof CreatePluginInput> {}
export const CreatePluginInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Plugin.SelfExtension.CreatePluginInput" })

export interface EnablePluginInput extends Schema.Schema.Type<typeof EnablePluginInput> {}
export const EnablePluginInput = Schema.Struct({
  name: Schema.String,
  verification_command: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Plugin.SelfExtension.EnablePluginInput" })

export interface DisablePluginInput extends Schema.Schema.Type<typeof DisablePluginInput> {}
export const DisablePluginInput = Schema.Struct({
  name: Schema.String,
  reason: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Plugin.SelfExtension.DisablePluginInput" })

export class SelfExtensionError extends Schema.TaggedErrorClass<SelfExtensionError>()("SelfExtensionError", {
  message: Schema.String,
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly createSkill: (input: CreateSkillInput) => Effect.Effect<ExtensionChange, SelfExtensionError>
  readonly createPlugin: (input: CreatePluginInput) => Effect.Effect<ExtensionChange, SelfExtensionError>
  readonly enablePlugin: (input: EnablePluginInput) => Effect.Effect<ExtensionChange, SelfExtensionError>
  readonly disablePlugin: (input: DisablePluginInput) => Effect.Effect<ExtensionChange, SelfExtensionError>
  readonly rollbackPlugin: (input: DisablePluginInput) => Effect.Effect<ExtensionChange, SelfExtensionError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/plugin/SelfExtension") {}

export interface FileSystemAdapter {
  readonly readText: (path: string) => Effect.Effect<Option.Option<string>, SelfExtensionError>
  readonly writeText: (path: string, content: string) => Effect.Effect<void, SelfExtensionError>
  readonly makeDirectory: (path: string) => Effect.Effect<void, SelfExtensionError>
  readonly rename: (from: string, to: string) => Effect.Effect<void, SelfExtensionError>
  readonly exists: (path: string) => Effect.Effect<boolean, SelfExtensionError>
}

export interface VerificationRunner {
  readonly run: (command: string, cwd: string) => Effect.Effect<VerificationResult, SelfExtensionError>
}

interface Dependencies {
  readonly workspaceRoot: string
  readonly fileSystem: FileSystemAdapter
  readonly verifier: VerificationRunner
  readonly artifactStore: ArtifactStore.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly time: Time.Interface
  readonly resolveWorkspaceId: (
    threadId: Ids.ThreadId | undefined,
  ) => Effect.Effect<Ids.WorkspaceId, SelfExtensionError>
}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | ArtifactStore.Service
  | Database.Service
  | IdGenerator.Service
  | ThreadProjection.Service
  | Time.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const artifactStore = yield* ArtifactStore.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const values = yield* config.get
    const database = yield* Database.Service
    const projection = yield* ThreadProjection.Service
    return makeService({
      workspaceRoot: values.workspace_root,
      fileSystem: nodeFileSystem,
      verifier: bunVerifier,
      artifactStore,
      idGenerator,
      time,
      resolveWorkspaceId: workspaceResolver(values.workspace_root, database, projection),
    })
  }),
)

export const layerFromAdapters = (input: {
  readonly workspaceRoot: string
  readonly fileSystem?: FileSystemAdapter
  readonly verifier?: VerificationRunner
  readonly resolveWorkspaceId?: Dependencies["resolveWorkspaceId"]
}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const artifactStore = yield* ArtifactStore.Service
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service
      return makeService({
        workspaceRoot: input.workspaceRoot,
        fileSystem: input.fileSystem ?? nodeFileSystem,
        verifier: input.verifier ?? skippedVerifier,
        artifactStore,
        idGenerator,
        time,
        resolveWorkspaceId: input.resolveWorkspaceId ?? unprojectedWorkspaceResolver(input.workspaceRoot),
      })
    }),
  )

export const createSkill = Effect.fn("SelfExtension.createSkill.call")(function* (input: CreateSkillInput) {
  const service = yield* Service
  return yield* service.createSkill(input)
})

export const createPlugin = Effect.fn("SelfExtension.createPlugin.call")(function* (input: CreatePluginInput) {
  const service = yield* Service
  return yield* service.createPlugin(input)
})

export const enablePlugin = Effect.fn("SelfExtension.enablePlugin.call")(function* (input: EnablePluginInput) {
  const service = yield* Service
  return yield* service.enablePlugin(input)
})

export const disablePlugin = Effect.fn("SelfExtension.disablePlugin.call")(function* (input: DisablePluginInput) {
  const service = yield* Service
  return yield* service.disablePlugin(input)
})

export const rollbackPlugin = Effect.fn("SelfExtension.rollbackPlugin.call")(function* (input: DisablePluginInput) {
  const service = yield* Service
  return yield* service.rollbackPlugin(input)
})

export const fakeVerifier = (result: VerificationResult): VerificationRunner => ({
  run: (command) => Effect.succeed(withCommand(result, command)),
})

export const contentHash = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`

const makeService = (dependencies: Dependencies): Interface =>
  Service.of({
    createSkill: Effect.fn("SelfExtension.createSkill")(function* (input: CreateSkillInput) {
      const name = yield* validateName(input.name, "createSkill")
      const description = yield* nonEmpty(input.description, "description", "createSkill", name)
      const workspaceId = yield* dependencies.resolveWorkspaceId(input.thread_id)
      const directory = join(dependencies.workspaceRoot, ".agents", "skills", name)
      const path = join(directory, "SKILL.md")
      yield* ensureMissing(dependencies, path, name, "createSkill")
      const content = skillTemplate(name, description, input.instructions)
      yield* dependencies.fileSystem.makeDirectory(directory)
      yield* dependencies.fileSystem.writeText(path, content)
      return yield* recordChange(dependencies, {
        kind: "skill",
        action: "create-skill",
        name,
        enabled: true,
        workspaceId,
        threadId: input.thread_id,
        files: [{ path: relativePath(dependencies.workspaceRoot, path), before: null, after: content }],
        trust: {
          model: "explicit-local",
          enabled: true,
          reason: "Skill instructions are inert until explicitly selected by the user or prompt.",
          verification: { status: "skipped" },
        },
      })
    }),
    createPlugin: Effect.fn("SelfExtension.createPlugin")(function* (input: CreatePluginInput) {
      const name = yield* validateName(input.name, "createPlugin")
      const description = yield* nonEmpty(input.description, "description", "createPlugin", name)
      const workspaceId = yield* dependencies.resolveWorkspaceId(input.thread_id)
      const directory = join(dependencies.workspaceRoot, ".rika", "plugins")
      const activePath = activePluginPath(dependencies.workspaceRoot, name)
      const disabledPath = disabledPluginPath(dependencies.workspaceRoot, name)
      yield* ensureMissing(dependencies, activePath, name, "createPlugin")
      yield* ensureMissing(dependencies, disabledPath, name, "createPlugin")
      const content = pluginTemplate(name, description)
      yield* dependencies.fileSystem.makeDirectory(directory)
      yield* dependencies.fileSystem.writeText(disabledPath, content)
      return yield* recordChange(dependencies, {
        kind: "plugin",
        action: "create-plugin",
        name,
        enabled: false,
        workspaceId,
        threadId: input.thread_id,
        files: [{ path: relativePath(dependencies.workspaceRoot, disabledPath), before: null, after: content }],
        trust: {
          model: "explicit-local",
          enabled: false,
          reason:
            "Generated executable plugins are written disabled until a verification command passes and the user enables them.",
          content_hash: contentHash(content),
          verification: { status: "skipped" },
        },
      })
    }),
    enablePlugin: Effect.fn("SelfExtension.enablePlugin")(function* (input: EnablePluginInput) {
      const name = yield* validateName(input.name, "enablePlugin")
      const command = yield* nonEmpty(input.verification_command, "verification_command", "enablePlugin", name)
      const workspaceId = yield* dependencies.resolveWorkspaceId(input.thread_id)
      const disabledPath = disabledPluginPath(dependencies.workspaceRoot, name)
      const activePath = activePluginPath(dependencies.workspaceRoot, name)
      yield* ensureMissing(dependencies, activePath, name, "enablePlugin")
      const before = yield* requireText(dependencies, disabledPath, name, "enablePlugin")
      const verification = yield* dependencies.verifier.run(command, dependencies.workspaceRoot)
      const passed = verification.status === "passed"
      if (passed) yield* dependencies.fileSystem.rename(disabledPath, activePath)
      return yield* recordChange(dependencies, {
        kind: "plugin",
        action: "enable-plugin",
        name,
        enabled: passed,
        workspaceId,
        threadId: input.thread_id,
        files: passed
          ? [
              { path: relativePath(dependencies.workspaceRoot, disabledPath), before, after: null },
              { path: relativePath(dependencies.workspaceRoot, activePath), before: null, after: before },
            ]
          : [{ path: relativePath(dependencies.workspaceRoot, disabledPath), before, after: before }],
        trust: {
          model: "explicit-local",
          enabled: passed,
          reason: passed
            ? "User explicitly enabled the plugin after verification passed."
            : "Plugin remained disabled because verification did not pass.",
          content_hash: contentHash(before),
          verification,
        },
      })
    }),
    disablePlugin: Effect.fn("SelfExtension.disablePlugin")(function* (input: DisablePluginInput) {
      return yield* disableOrRollback(dependencies, "disable-plugin", input)
    }),
    rollbackPlugin: Effect.fn("SelfExtension.rollbackPlugin")(function* (input: DisablePluginInput) {
      return yield* disableOrRollback(dependencies, "rollback-plugin", input)
    }),
  })

const disableOrRollback = (
  dependencies: Dependencies,
  action: "disable-plugin" | "rollback-plugin",
  input: DisablePluginInput,
) =>
  Effect.gen(function* () {
    const name = yield* validateName(input.name, action)
    const workspaceId = yield* dependencies.resolveWorkspaceId(input.thread_id)
    const activePath = activePluginPath(dependencies.workspaceRoot, name)
    const disabledPath = disabledPluginPath(dependencies.workspaceRoot, name)
    const active = yield* dependencies.fileSystem.readText(activePath)
    if (Option.isSome(active)) {
      yield* dependencies.fileSystem.rename(activePath, disabledPath)
      return yield* recordChange(dependencies, {
        kind: "plugin",
        action,
        name,
        enabled: false,
        workspaceId,
        threadId: input.thread_id,
        files: [
          { path: relativePath(dependencies.workspaceRoot, activePath), before: active.value, after: null },
          { path: relativePath(dependencies.workspaceRoot, disabledPath), before: null, after: active.value },
        ],
        trust: {
          model: "explicit-local",
          enabled: false,
          reason: input.reason ?? "User disabled the local plugin.",
          content_hash: contentHash(active.value),
          verification: { status: "skipped" },
        },
      })
    }
    const disabled = yield* dependencies.fileSystem.readText(disabledPath)
    if (Option.isSome(disabled)) {
      return yield* recordChange(dependencies, {
        kind: "plugin",
        action,
        name,
        enabled: false,
        workspaceId,
        threadId: input.thread_id,
        files: [
          {
            path: relativePath(dependencies.workspaceRoot, disabledPath),
            before: disabled.value,
            after: disabled.value,
          },
        ],
        trust: {
          model: "explicit-local",
          enabled: false,
          reason: input.reason ?? "Plugin was already disabled.",
          content_hash: contentHash(disabled.value),
          verification: { status: "skipped" },
        },
      })
    }
    return yield* new SelfExtensionError({ message: `Plugin ${name} does not exist`, operation: action, name })
  })

interface RecordInput {
  readonly kind: ExtensionKind
  readonly action: ExtensionAction
  readonly name: string
  readonly enabled: boolean
  readonly workspaceId: Ids.WorkspaceId
  readonly threadId: Ids.ThreadId | undefined
  readonly files: ReadonlyArray<FileChange>
  readonly trust: TrustDecision
}

const recordChange = (dependencies: Dependencies, input: RecordInput) =>
  Effect.gen(function* () {
    const artifactId = Ids.ArtifactId.make(yield* dependencies.idGenerator.next("artifact_extension"))
    const createdAt = yield* dependencies.time.nowMillis
    const change: ExtensionChange = {
      kind: input.kind,
      action: input.action,
      name: input.name,
      workspace_id: input.workspaceId,
      enabled: input.enabled,
      artifact_id: artifactId,
      files: [...input.files],
      trust: input.trust,
    }
    yield* dependencies.artifactStore
      .put({
        id: artifactId,
        thread_id: input.threadId ?? Ids.ThreadId.make("thread_self_extension"),
        workspace_id: input.workspaceId,
        kind: "other",
        title: `Self-extension ${input.action}: ${input.name}`,
        content: extensionChangeToJson(change),
        created_at: createdAt,
        metadata: {
          kind: "self-extension",
          extension_kind: input.kind,
          action: input.action,
          name: input.name,
          workspace_id: input.workspaceId,
          enabled: input.enabled,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SelfExtensionError({
              message: cause.message,
              operation: "recordArtifact",
              name: input.name,
            }),
        ),
      )
    return change
  })

const validateName = (name: string, operation: string) =>
  /^[a-z][a-z0-9-]*$/.test(name)
    ? Effect.succeed(name)
    : new SelfExtensionError({
        message: "Extension names must match /^[a-z][a-z0-9-]*$/",
        operation,
        name,
      })

const nonEmpty = (value: string, field: string, operation: string, name: string) => {
  const trimmed = value.trim()
  return trimmed.length === 0
    ? new SelfExtensionError({ message: `${field} is required`, operation, name })
    : Effect.succeed(trimmed)
}

const ensureMissing = (dependencies: Dependencies, path: string, name: string, operation: string) =>
  Effect.gen(function* () {
    if (yield* dependencies.fileSystem.exists(path)) {
      yield* new SelfExtensionError({ message: `Refusing to overwrite ${path}`, operation, path, name })
    }
  })

const requireText = (dependencies: Dependencies, path: string, name: string, operation: string) =>
  Effect.gen(function* () {
    const content = yield* dependencies.fileSystem.readText(path)
    if (Option.isSome(content)) return content.value
    return yield* new SelfExtensionError({ message: `Missing file ${path}`, operation, path, name })
  })

const skillTemplate = (name: string, description: string, instructions: string | undefined) => `---
name: ${name}
description: ${description}
---

# ${titleFromName(name)}

${instructions?.trim() || "Describe when to use this skill and the exact workflow Rika should follow."}
`

const pluginTemplate = (name: string, description: string) => `import type { PluginAPI } from "@rika/plugin"

export default function (rika: PluginAPI) {
	rika.registerCommand(
		${JSON.stringify(`${name}.hello`)},
		{
			title: ${JSON.stringify(titleFromName(name))},
			category: "generated",
			description: ${JSON.stringify(description)},
		},
		async (ctx) => {
			await ctx.ui.notify(${JSON.stringify(`${titleFromName(name)} plugin is enabled.`)})
		},
	)
}
`

const activePluginPath = (workspaceRoot: string, name: string) => join(workspaceRoot, ".rika", "plugins", `${name}.ts`)
const disabledPluginPath = (workspaceRoot: string, name: string) =>
  join(workspaceRoot, ".rika", "plugins", `${name}.ts.disabled`)

const titleFromName = (name: string) =>
  name
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")

const relativePath = (workspaceRoot: string, path: string) => relative(workspaceRoot, path).split(sep).join("/")

const workspaceResolver = (
  workspaceRoot: string,
  database: Database.Interface,
  projection: ThreadProjection.Interface,
) =>
  Effect.fn("SelfExtension.resolveWorkspaceId")(function* (threadId: Ids.ThreadId | undefined) {
    const workspaceId = Ids.WorkspaceId.make(workspaceRoot)
    if (threadId === undefined) return workspaceId
    const summary = yield* projection.getThread(threadId).pipe(
      Effect.provideService(Database.Service, database),
      Effect.mapError(
        (cause) =>
          new SelfExtensionError({
            message: cause.message,
            operation: "resolveWorkspace",
          }),
      ),
    )
    if (summary === undefined) {
      return yield* new SelfExtensionError({
        message: `Thread ${threadId} is not present in the workspace projection`,
        operation: "resolveWorkspace",
      })
    }
    if (summary.workspace_id !== workspaceId) {
      return yield* new SelfExtensionError({
        message: `Thread ${threadId} belongs to workspace ${summary.workspace_id}, not ${workspaceId}`,
        operation: "resolveWorkspace",
      })
    }
    return summary.workspace_id
  })

const unprojectedWorkspaceResolver = (workspaceRoot: string): Dependencies["resolveWorkspaceId"] =>
  Effect.fn("SelfExtension.resolveWorkspaceId.unprojected")(function* (threadId: Ids.ThreadId | undefined) {
    if (threadId !== undefined) {
      return yield* new SelfExtensionError({
        message: `Thread ${threadId} cannot be scoped without the thread projection`,
        operation: "resolveWorkspace",
      })
    }
    return Ids.WorkspaceId.make(workspaceRoot)
  })

const extensionChangeToJson = (change: ExtensionChange): Common.JsonValue => ({
  kind: change.kind,
  action: change.action,
  name: change.name,
  workspace_id: change.workspace_id,
  enabled: change.enabled,
  artifact_id: change.artifact_id,
  files: change.files.map((file): Common.JsonValue => ({ path: file.path, before: file.before, after: file.after })),
  trust: trustDecisionToJson(change.trust),
})

const trustDecisionToJson = (trust: TrustDecision): Common.JsonValue => ({
  model: trust.model,
  enabled: trust.enabled,
  reason: trust.reason,
  ...(trust.content_hash === undefined ? {} : { content_hash: trust.content_hash }),
  verification: verificationToJson(trust.verification),
})

const verificationToJson = (verification: VerificationResult): Common.JsonValue => ({
  status: verification.status,
  ...(verification.command === undefined ? {} : { command: verification.command }),
  ...(verification.exit_code === undefined ? {} : { exit_code: verification.exit_code }),
  ...(verification.stdout === undefined ? {} : { stdout: verification.stdout }),
  ...(verification.stderr === undefined ? {} : { stderr: verification.stderr }),
})

const withCommand = (result: VerificationResult, command: string): VerificationResult => ({
  ...result,
  command: result.command ?? command,
})

const skippedVerifier: VerificationRunner = {
  run: (command) => Effect.succeed({ status: "skipped", command }),
}

const bunVerifier: VerificationRunner = {
  run: (command, cwd) =>
    Effect.tryPromise({
      try: async () => {
        const process = Bun.spawn(["sh", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ])
        return {
          status: exitCode === 0 ? "passed" : "failed",
          command,
          exit_code: exitCode,
          stdout: cap(stdout),
          stderr: cap(stderr),
        } satisfies VerificationResult
      },
      catch: (cause) =>
        new SelfExtensionError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation: "verify",
        }),
    }),
}

const nodeFileSystem: FileSystemAdapter = {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<string>())),
      Effect.mapError((cause) => fileError("readText", path, cause)),
    ),
  writeText: (path, content) =>
    Effect.tryPromise({
      try: () => writeFile(path, content, "utf8"),
      catch: (cause) => fileError("writeText", path, cause),
    }),
  makeDirectory: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: (cause) => fileError("makeDirectory", path, cause),
    }).pipe(Effect.asVoid),
  rename: (from, to) =>
    Effect.tryPromise({
      try: () => rename(from, to),
      catch: (cause) => fileError("rename", from, cause),
    }),
  exists: (path) =>
    Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
      Effect.map((value) => value !== undefined),
      Effect.catch(() => Effect.succeed(false)),
    ),
}

const fileError = (operation: string, path: string, cause: unknown) =>
  new SelfExtensionError({
    message: `${operation} failed for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    operation,
    path,
  })

const isNotFound = (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const cap = (value: string) => (value.length > 8_000 ? `${value.slice(0, 8_000)}\n[truncated]` : value)
