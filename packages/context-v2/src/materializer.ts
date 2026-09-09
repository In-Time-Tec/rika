/* oxlint-disable anti-slop/no-unknown-parameters -- unknown values are parsed by the boundary schema before capture. */
/* oxlint-disable anti-slop/no-runtime-typeof -- defensive error and JSON traversal checks protect fail-closed paths. */
/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional Generalist metadata remains absent when unset. */
/* oxlint-disable effecttsgo/instance-of-schema -- tagged materialization errors are checked before external failures. */
/* oxlint-disable effecttsgo/missing-pipeable-signature -- these helpers intentionally expose direct component operations. */
/* oxlint-disable effecttsgo/prefer-typed-schema-decoder -- materialization boundaries validate runtime snapshots. */
/* oxlint-disable effecttsgo/schema-sync-in-effect -- component state construction is synchronous and bounded. */
/* oxlint-disable effecttsgo/schema-number -- model settings preserve provider-defined numeric configuration. */
/* oxlint-disable effecttsgo/unnecessary-fail-yieldable-error -- explicit failures keep error reasons at this boundary. */
import { Context, Effect, Layer, Schema } from "effect"
import { Instructions, Pins, SkillCatalog } from "generalist"
import {
  ActivatedSkill,
  Authorization,
  ChildAttenuation,
  ContentIdentity,
  EffectiveAuthorization,
  GuidanceFile,
  ModelConfiguration,
  SessionMaterialization,
  SettingsChangeReceipt,
  SkillMetadata,
  WorkspaceBinding,
  skillBodyIdentity,
  skillMetadataIdentity,
  modelPin,
  type SessionMaterializationCommand,
  type ToolGrant,
} from "./contract"
import { WorkspaceReader, validateBinding, type WorkspaceReaderService } from "./workspace"

const defaultLimits = {
  maxSkills: 40,
  maxDescriptionChars: 1024,
  maxSkillListingTokens: 2048,
} as const

const guidanceEntryId = (kind: "workspace" | "skill", value: string) =>
  `${kind}-${Pins.digest({ kind, value }).slice(0, 48)}`

const canonicalGuidanceScope = (scope: string) => {
  const normalized = scope.replace(/[^A-Za-z0-9._:-]/g, "-")
  return normalized.length === 0 ? "rika-context" : normalized.slice(0, 512)
}

export interface MaterializerLimits {
  readonly maxSkills?: number
  readonly maxDescriptionChars?: number
  readonly maxSkillListingTokens?: number
}

export interface DiscoverInput {
  readonly sessionId: string
  readonly guidanceScope: string
  readonly binding: WorkspaceBinding
  readonly capturedAt: string
  readonly model: ModelConfiguration
  readonly tools: ReadonlyArray<ToolGrant>
  readonly limits?: MaterializerLimits
}

export interface ActivateSkillInput {
  readonly materialization: SessionMaterialization
  readonly requestId: string
  readonly name: string
  readonly capturedAt: string
}

export interface ContextMaterializerService {
  readonly discover: (input: DiscoverInput) => Effect.Effect<SessionMaterialization, ContextMaterializationError>
  readonly activateSkill: (input: ActivateSkillInput) => Effect.Effect<SessionMaterialization, ContextMaterializationError>
  readonly restore: (materialization: SessionMaterialization) => Effect.Effect<SessionMaterialization, ContextMaterializationError>
  readonly effectiveAuthorization: (
    materialization: SessionMaterialization,
    authorization: Authorization,
  ) => Effect.Effect<EffectiveAuthorization, ContextMaterializationError>
  readonly attenuateChild: (
    materialization: SessionMaterialization,
    requested: ChildAttenuation,
  ) => Effect.Effect<ChildAttenuation, ContextMaterializationError>
}

export class ContextMaterializationError extends Schema.TaggedError<ContextMaterializationError>()(
  "RikaContextMaterializationError",
  {
    reason: Schema.Literals([
      "binding",
      "reader",
      "guidance",
      "duplicate-skill",
      "skill-not-found",
      "skill-not-invocable",
      "skill-body",
      "content-missing",
      "settings",
      "revoked",
      "attenuation",
    ]),
    message: Schema.String,
  },
) {}

type MaterializationReason =
  | "binding"
  | "reader"
  | "guidance"
  | "duplicate-skill"
  | "skill-not-found"
  | "skill-not-invocable"
  | "skill-body"
  | "content-missing"
  | "settings"
  | "revoked"
  | "attenuation"

const failure = (reason: MaterializationReason, message: string) =>
  ContextMaterializationError.make({ reason, message })

const asError = (error: unknown, reason: ContextMaterializationError["reason"]) => {
  if (error instanceof ContextMaterializationError) return error
  return failure(reason, "Context materialization failed")
}

const nonSecretKey = /(?:secret|token|password|api[-_]?key|private[-_]?key|authorization|access[-_]?key)/i

const containsCredentialValue = (value: unknown, key?: string): boolean => {
  if (key !== undefined && nonSecretKey.test(key) && key !== "credentialRefs") return true
  if (Array.isArray(value)) return value.some((item) => containsCredentialValue(item))
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(([entryKey, entryValue]) => containsCredentialValue(entryValue, entryKey))
  return false
}

const validateModel = (model: ModelConfiguration): Effect.Effect<ModelConfiguration, ContextMaterializationError> =>
  Effect.try({
    try: () => {
      if (containsCredentialValue(model.settings.options)) throw new Error("Model settings contain a credential value")
      return Schema.decodeUnknownSync(ModelConfiguration)(model)
    },
    catch: () => failure("settings", "Model configuration must contain secure credential references only"),
  })

const truncate = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`)
const boundedValues = (values: ReadonlyArray<string>) => values.slice(0, 64).map((value) => truncate(value, 512))

const skillMetadata = (skill: SkillCatalog.Skill, maxDescriptionChars: number): SkillMetadata => {
  const input = {
    name: skill.name,
    description: truncate(skill.description, maxDescriptionChars),
    ...(skill.whenToUse === undefined ? {} : { whenToUse: truncate(skill.whenToUse, maxDescriptionChars) }),
    ...(skill.allowedTools === undefined ? {} : { allowedTools: boundedValues(skill.allowedTools) }),
    ...(skill.disableModelInvocation === undefined ? {} : { disableModelInvocation: skill.disableModelInvocation }),
    ...(skill.userInvocable === undefined ? {} : { userInvocable: skill.userInvocable }),
    ...(skill.contextFork === undefined ? {} : { contextFork: skill.contextFork }),
    ...(skill.paths === undefined ? {} : { paths: boundedValues(skill.paths) }),
  }
  return { ...input, identity: skillMetadataIdentity(input) }
}

const guidanceEntry = (file: GuidanceFile, scope: string, capturedAt: string): Instructions.Entry.GuidanceEntry => ({
  title: file.path,
  content: file.content,
  path: file.path,
  source: "workspace",
  createdAt: capturedAt,
  updatedAt: capturedAt,
  version: 1,
  id: guidanceEntryId("workspace", file.path),
  kind: "prompt",
  scope,
})

const skillEntry = (skill: SkillMetadata, scope: string, capturedAt: string): Instructions.Entry.GuidanceEntry => ({
  title: skill.name,
  content: JSON.stringify({
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
    ...(skill.disableModelInvocation === undefined ? {} : { disableModelInvocation: skill.disableModelInvocation }),
    ...(skill.userInvocable === undefined ? {} : { userInvocable: skill.userInvocable }),
    ...(skill.contextFork === undefined ? {} : { contextFork: skill.contextFork }),
    ...(skill.paths === undefined ? {} : { paths: skill.paths }),
  }),
  source: "workspace",
  createdAt: capturedAt,
  updatedAt: capturedAt,
  version: 1,
  id: guidanceEntryId("skill", skill.name),
  kind: "skill",
  scope,
})

const registrationFor = (scope: string, entries: ReadonlyArray<Instructions.Entry.GuidanceEntry>) => {
  const state = Instructions.State.make({ scope, entries })
  const snapshot = Instructions.Snapshot.make(state)
  const registration = Instructions.Registration.make(state, "rika/context-v2")
  return { state, snapshot, registration }
}

type GuidanceSnapshot = Instructions.Snapshot.GuidanceSnapshot

const guidanceEntries = (snapshot: GuidanceSnapshot) => snapshot.payload.entries

const metadataByName = (materialization: SessionMaterialization, name: string) =>
  materialization.skills.find((skill) => skill.name === name)

const readerSkill = (reader: WorkspaceReaderService, binding: WorkspaceBinding, name: string) =>
  reader.listSkills(binding).pipe(
    Effect.map((skills) => skills.find((skill) => skill.name === name)),
    Effect.mapError((error) => asError(error, "reader")),
  )

const discoverWithReader = (reader: WorkspaceReaderService, input: DiscoverInput) =>
  Effect.gen(function* () {
    const binding = yield* validateBinding(input.binding).pipe(Effect.mapError((error) => asError(error, "binding")))
    const model = yield* validateModel(input.model)
    const files = yield* reader.readGuidance(binding).pipe(Effect.mapError((error) => asError(error, "reader")))
    const discoveredSkills = yield* reader.listSkills(binding).pipe(Effect.mapError((error) => asError(error, "reader")))
    const limits = {
      maxSkills: Math.max(0, Math.floor(input.limits?.maxSkills ?? defaultLimits.maxSkills)),
      maxDescriptionChars: Math.max(1, Math.floor(input.limits?.maxDescriptionChars ?? defaultLimits.maxDescriptionChars)),
      maxSkillListingTokens: Math.max(0, Math.floor(input.limits?.maxSkillListingTokens ?? defaultLimits.maxSkillListingTokens)),
    }
    const selectedSkills = SkillCatalog.selectListings(
      discoveredSkills.toSorted((left, right) => left.name.localeCompare(right.name)),
      limits.maxSkillListingTokens,
      [],
    ).slice(0, limits.maxSkills)
    const skills = selectedSkills.map((skill) => skillMetadata(skill, limits.maxDescriptionChars))
    if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
      return yield* Effect.fail(failure("duplicate-skill", "Workspace skill names must be unique"))
    if (new Set(files.map((file) => file.path)).size !== files.length)
      return yield* Effect.fail(failure("guidance", "Workspace guidance paths must be unique"))
    const guidanceScope = canonicalGuidanceScope(input.guidanceScope)
    const entries = [
      ...files.map((file) => guidanceEntry(file, guidanceScope, input.capturedAt)),
      ...skills.map((skill) => skillEntry(skill, guidanceScope, input.capturedAt)),
    ]
    const { snapshot, registration } = registrationFor(guidanceScope, entries)
    const pin = modelPin(model)
    return Schema.decodeUnknownSync(SessionMaterialization)({
      schemaVersion: "1",
      sessionId: input.sessionId,
      guidanceScope,
      workspace: binding,
      guidance: snapshot,
      registration: {
        id: registration.id,
        capability: registration.capability,
        payload: registration.payload,
      },
      skills,
      activatedSkills: [],
      model,
      modelPin: pin,
      tools: input.tools,
      settingsRevision: 0,
    })
  }).pipe(Effect.mapError((error) => asError(error, "guidance")))

const activateWithReader = (reader: WorkspaceReaderService, input: ActivateSkillInput) =>
  Effect.gen(function* () {
    const existing = metadataByName(input.materialization, input.name)
    if (existing === undefined) return yield* Effect.fail(failure("skill-not-found", "Selected skill is not pinned"))
    if (existing.disableModelInvocation === true)
      return yield* Effect.fail(failure("skill-not-invocable", "Selected skill cannot be activated by the model"))
    const skill = yield* readerSkill(reader, input.materialization.workspace, input.name)
    if (skill === undefined) return yield* Effect.fail(failure("skill-not-found", "Selected skill is unavailable"))
    const body = yield* skill.instructions.pipe(
      Effect.mapError((error) => failure("skill-body", error.message)),
    )
    const bodyIdentity = skillBodyIdentity(body)
    const activated: ActivatedSkill = {
      name: input.name,
      metadataIdentity: existing.identity,
      bodyIdentity,
      capturedAt: input.capturedAt,
    }
    const entries = guidanceEntries(input.materialization.guidance).map((entry) =>
      entry.id === guidanceEntryId("skill", input.name)
        ? { ...entry, content: body, updatedAt: input.capturedAt, version: entry.version + 1 }
        : entry,
    )
    const { snapshot, registration } = registrationFor(input.materialization.guidanceScope, entries)
    const activatedSkills = [...input.materialization.activatedSkills.filter((item) => item.name !== input.name), activated]
    return Schema.decodeUnknownSync(SessionMaterialization)({
      ...input.materialization,
      guidance: snapshot,
      registration: { id: registration.id, capability: registration.capability, payload: registration.payload },
      activatedSkills,
    })
  }).pipe(Effect.mapError((error) => asError(error, "skill-body")))

const restoreWithReader = (materialization: SessionMaterialization) =>
  Effect.gen(function* () {
    const decoded = yield* Instructions.Snapshot.decode(materialization.registration.id, materialization.registration.payload).pipe(
      Effect.mapError(() => failure("content-missing", "Pinned guidance content cannot be reconstructed")),
    )
    const expectedSnapshot = Instructions.Snapshot.make(decoded)
    if (
      decoded.scope !== materialization.guidanceScope ||
      materialization.guidance.id !== materialization.registration.id ||
      expectedSnapshot.id !== materialization.guidance.id
    )
      return yield* Effect.fail(failure("content-missing", "Pinned guidance registration does not match the Session"))
    const pinnedRegistration = Instructions.Registration.make(decoded, "rika/context-v2")
    if (
      pinnedRegistration.capability.pin !== materialization.registration.capability.pin ||
      pinnedRegistration.capability.content?.digest !== materialization.registration.capability.content?.digest
    )
      return yield* Effect.fail(failure("content-missing", "Pinned guidance capability does not match the Session"))
    for (const activated of materialization.activatedSkills) {
      const entry = Instructions.State.allEntries(decoded).find(
        (candidate) => candidate.id === guidanceEntryId("skill", activated.name),
      )
      if (entry === undefined || skillBodyIdentity(entry.content).digest !== activated.bodyIdentity.digest)
        return yield* Effect.fail(failure("content-missing", "Pinned activated skill content cannot be reconstructed"))
    }
    if (modelPin(materialization.model) !== materialization.modelPin)
      return yield* Effect.fail(failure("settings", "Pinned model configuration does not match the Session"))
    return materialization
  })

const effectiveAuthorization = (materialization: SessionMaterialization, authorization: Authorization) =>
  Effect.sync(() => {
    const toolNames = new Set(materialization.tools.map((tool) => tool.name))
    const allowedToolSet = new Set(authorization.allowedTools)
    const allowedTools = materialization.tools.map((tool) => tool.name).filter((name) => allowedToolSet.has(name))
    const revokedTools = [...toolNames].filter((name) => !allowedToolSet.has(name))
    const allowedModels = authorization.allowedModels.includes(materialization.modelPin) ? [materialization.modelPin] : []
    const revokedModels = allowedModels.length === 0 ? [materialization.modelPin] : []
    const credentialRefs = materialization.model.credentialRefs
    const allowedCredentials = credentialRefs.filter((candidate) =>
      authorization.allowedCredentials.some(
        (allowed) => allowed.provider === candidate.provider && allowed.reference === candidate.reference,
      ),
    )
    const revokedCredentials = credentialRefs.filter(
      (candidate) => !allowedCredentials.some((allowed) => allowed.provider === candidate.provider && allowed.reference === candidate.reference),
    )
    return {
      allowedTools,
      allowedModels,
      allowedCredentials,
      revokedTools,
      revokedModels,
      revokedCredentials,
      canResume: allowedModels.length > 0 && revokedCredentials.length === 0,
    }
  })

const attenuateChild = (materialization: SessionMaterialization, requested: ChildAttenuation) =>
  Effect.gen(function* () {
    const parentTools = new Set(materialization.tools.map((tool) => tool.name))
    const parentModels = new Set([materialization.modelPin])
    if (requested.allowedTools.some((name) => !parentTools.has(name)))
      return yield* Effect.fail(failure("attenuation", "Child tools must be a subset of parent tools"))
    if (requested.allowedModels.some((pin) => !parentModels.has(pin)))
      return yield* Effect.fail(failure("attenuation", "Child models must be a subset of parent models"))
    return requested
  })

const componentTransition = (state: SessionMaterialization, command: SessionMaterializationCommand): SessionMaterialization => {
  if (command._tag === "ActivateSkill") {
    const skill = metadataByName(state, command.name)
    if (skill === undefined || skill.disableModelInvocation === true) throw new Error("Selected skill is not activatable")
    if (
      command.bodyIdentity.codec !== skillBodyIdentity(command.body).codec ||
      command.bodyIdentity.version !== skillBodyIdentity(command.body).version ||
      command.bodyIdentity.digest !== skillBodyIdentity(command.body).digest
    )
      throw new Error("Skill body identity mismatch")
    const entries = guidanceEntries(state.guidance).map((entry) =>
      entry.id === guidanceEntryId("skill", command.name)
        ? { ...entry, content: command.body, updatedAt: command.capturedAt, version: entry.version + 1 }
        : entry,
    )
    const { snapshot, registration } = registrationFor(state.guidanceScope, entries)
    const activated = {
      name: command.name,
      metadataIdentity: skill.identity,
      bodyIdentity: command.bodyIdentity,
      capturedAt: command.capturedAt,
    }
    return {
      ...state,
      guidance: snapshot,
      registration: { id: registration.id, capability: registration.capability, payload: registration.payload },
      activatedSkills: [...state.activatedSkills.filter((item) => item.name !== command.name), activated],
    }
  }
  if (command.expectedRevision !== state.settingsRevision) throw new Error("Settings revision conflict")
  if (modelPin(command.model) !== command.modelPin) throw new Error("Model configuration identity mismatch")
  return { ...state, model: command.model, modelPin: command.modelPin, settingsRevision: state.settingsRevision + 1 }
}

export const transition = componentTransition

export const settingsReceipt = (
  state: SessionMaterialization,
  command: Extract<SessionMaterializationCommand, { readonly _tag: "ChangeSettings" }>,
): SettingsChangeReceipt => ({
  requestId: command.requestId,
  previousRevision: state.settingsRevision,
  revision: state.settingsRevision + 1,
  modelPin: command.modelPin,
})

export const makeContextMaterializer = (reader: WorkspaceReaderService): ContextMaterializerService => ({
  discover: (input) => discoverWithReader(reader, input),
  activateSkill: (input) => activateWithReader(reader, input),
  restore: restoreWithReader,
  effectiveAuthorization,
  attenuateChild,
})

export class ContextMaterializer extends Context.Service<ContextMaterializer, ContextMaterializerService>()(
  "@rika/context-v2/materializer/ContextMaterializer",
) {}

export const layer = Layer.effect(
  ContextMaterializer,
  Effect.gen(function* () {
    const reader = yield* WorkspaceReader
    return ContextMaterializer.of(makeContextMaterializer(reader))
  }),
)

export const discover = (
  input: DiscoverInput,
): Effect.Effect<SessionMaterialization, ContextMaterializationError, ContextMaterializer> =>
  Effect.gen(function* () {
    const materializer = yield* ContextMaterializer
    return yield* materializer.discover(input)
  })

export const activateSkill = (
  input: ActivateSkillInput,
): Effect.Effect<SessionMaterialization, ContextMaterializationError, ContextMaterializer> =>
  Effect.gen(function* () {
    const materializer = yield* ContextMaterializer
    return yield* materializer.activateSkill(input)
  })

export const restore = (
  materialization: SessionMaterialization,
): Effect.Effect<SessionMaterialization, ContextMaterializationError, ContextMaterializer> =>
  Effect.gen(function* () {
    const materializer = yield* ContextMaterializer
    return yield* materializer.restore(materialization)
  })

export const resolveAuthorization = (materialization: SessionMaterialization, authorization: Authorization) =>
  Effect.gen(function* () {
    const materializer = yield* ContextMaterializer
    return yield* materializer.effectiveAuthorization(materialization, authorization)
  })

export const attenuate = (materialization: SessionMaterialization, requested: ChildAttenuation) =>
  Effect.gen(function* () {
    const materializer = yield* ContextMaterializer
    return yield* materializer.attenuateChild(materialization, requested)
  })

export type { ContentIdentity }
