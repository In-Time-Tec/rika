import { Instructions, Pins } from "generalist"
import { Schema } from "effect"

const boundedString = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)))
const identifier = Schema.String.pipe(Schema.check(Schema.isNonEmpty()), Schema.check(Schema.isMaxLength(512)))
const contentDigest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)))

export const ContentIdentity = Schema.Struct({
  codec: identifier,
  version: identifier,
  digest: contentDigest,
})
export type ContentIdentity = typeof ContentIdentity.Type

export const SecureCredentialReference = Schema.Struct({
  provider: identifier,
  reference: Schema.String.pipe(Schema.check(Schema.isPattern(/^credential:\/\/[A-Za-z0-9._:/-]+$/))),
})
export type SecureCredentialReference = typeof SecureCredentialReference.Type

export const WorkspaceBinding = Schema.Struct({
  workspaceId: identifier,
  lineageId: identifier,
  generation: identifier,
})
export type WorkspaceBinding = typeof WorkspaceBinding.Type

export const GuidanceFile = Schema.Struct({
  path: identifier,
  content: Schema.String,
})
export type GuidanceFile = typeof GuidanceFile.Type

export const SkillMetadata = Schema.Struct({
  name: identifier,
  description: boundedString(1024),
  whenToUse: Schema.optionalKey(boundedString(1024)),
  allowedTools: Schema.optionalKey(Schema.Array(identifier)),
  disableModelInvocation: Schema.optionalKey(Schema.Boolean),
  userInvocable: Schema.optionalKey(Schema.Boolean),
  contextFork: Schema.optionalKey(Schema.Boolean),
  paths: Schema.optionalKey(Schema.Array(identifier)),
  identity: ContentIdentity,
})
export type SkillMetadata = typeof SkillMetadata.Type

export const ActivatedSkill = Schema.Struct({
  name: identifier,
  metadataIdentity: ContentIdentity,
  bodyIdentity: ContentIdentity,
  capturedAt: identifier,
})
export type ActivatedSkill = typeof ActivatedSkill.Type

export const ModelSelection = Schema.Struct({
  provider: identifier,
  model: identifier,
  registrationKey: Schema.optionalKey(identifier),
})
export type ModelSelection = typeof ModelSelection.Type

export const ModelSettings = Schema.Struct({
  temperature: Schema.optionalKey(Schema.Finite),
  maxOutputTokens: Schema.optionalKey(Schema.Int),
  reasoningEffort: Schema.optionalKey(identifier),
  options: Schema.optionalKey(Schema.Record(identifier, Schema.Json)),
})
export type ModelSettings = typeof ModelSettings.Type

export const ModelConfiguration = Schema.Struct({
  selection: ModelSelection,
  settings: ModelSettings,
  credentialRefs: Schema.Array(SecureCredentialReference),
})
export type ModelConfiguration = typeof ModelConfiguration.Type

export const ToolGrant = Schema.Struct({
  name: identifier,
  pin: Schema.String,
  content: Schema.optionalKey(ContentIdentity),
})
export type ToolGrant = typeof ToolGrant.Type

export const PinnedRegistration: Schema.Struct<{
  readonly id: Schema.String
  readonly capability: typeof ToolGrant
  readonly payload: typeof Instructions.Snapshot.SnapshotPayload
}> = Schema.Struct({
  id: Schema.String,
  capability: ToolGrant,
  payload: Instructions.Snapshot.SnapshotPayload,
})
export type PinnedRegistration = typeof PinnedRegistration.Type

export const SessionMaterialization = Schema.Struct({
  schemaVersion: Schema.Literal("1"),
  sessionId: identifier,
  guidanceScope: identifier,
  workspace: WorkspaceBinding,
  guidance: Instructions.Snapshot.GuidanceSnapshot,
  registration: PinnedRegistration,
  skills: Schema.Array(SkillMetadata),
  activatedSkills: Schema.Array(ActivatedSkill),
  model: ModelConfiguration,
  modelPin: Schema.String,
  tools: Schema.Array(ToolGrant),
  settingsRevision: Schema.Int,
})
export type SessionMaterialization = typeof SessionMaterialization.Type

export const ActivateSkillCommand = Schema.TaggedStruct("ActivateSkill", {
  requestId: identifier,
  name: identifier,
  body: Schema.String,
  bodyIdentity: ContentIdentity,
  capturedAt: identifier,
})

export const ChangeSettingsCommand = Schema.TaggedStruct("ChangeSettings", {
  requestId: identifier,
  expectedRevision: Schema.Int,
  model: ModelConfiguration,
  modelPin: Schema.String,
})

export const SessionMaterializationCommand = Schema.Union([ActivateSkillCommand, ChangeSettingsCommand])
export type SessionMaterializationCommand = typeof SessionMaterializationCommand.Type

export const SettingsChangeReceipt = Schema.Struct({
  requestId: identifier,
  previousRevision: Schema.Int,
  revision: Schema.Int,
  modelPin: Schema.String,
})
export type SettingsChangeReceipt = typeof SettingsChangeReceipt.Type

export const Authorization = Schema.Struct({
  allowedTools: Schema.Array(identifier),
  allowedModels: Schema.Array(Schema.String),
  allowedCredentials: Schema.Array(SecureCredentialReference),
})
export type Authorization = typeof Authorization.Type

export const EffectiveAuthorization = Schema.Struct({
  allowedTools: Schema.Array(identifier),
  allowedModels: Schema.Array(Schema.String),
  allowedCredentials: Schema.Array(SecureCredentialReference),
  revokedTools: Schema.Array(identifier),
  revokedModels: Schema.Array(Schema.String),
  revokedCredentials: Schema.Array(SecureCredentialReference),
  canResume: Schema.Boolean,
})
export type EffectiveAuthorization = typeof EffectiveAuthorization.Type

export const ChildAttenuation = Schema.Struct({
  allowedTools: Schema.Array(identifier),
  allowedModels: Schema.Array(Schema.String),
})
export type ChildAttenuation = typeof ChildAttenuation.Type

export const skillMetadataIdentity = (input: Omit<SkillMetadata, "identity">): ContentIdentity => ({
  codec: "rika/context-v2/skill-metadata",
  version: "1",
  digest: Pins.digest({
    codec: "rika/context-v2/skill-metadata",
    version: "1",
    ...input,
  }),
})

export const skillBodyIdentity = (body: string): ContentIdentity => ({
  codec: "rika/context-v2/skill-body",
  version: "1",
  digest: Pins.digest({ codec: "rika/context-v2/skill-body", version: "1", body }),
})

export const modelPin = (model: ModelConfiguration): string => Pins.makeModel(model)
