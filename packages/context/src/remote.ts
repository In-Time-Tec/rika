import {
  HandshakeRequest,
  NativeOperationIntent,
  maxDispatchBytes,
  maxHandshakeBytes,
  maxReceiptBytes,
  sameBinding,
  validateEvidence,
  validateHandshake,
  type ExecutorEvidence,
  type WorkspaceExecutorService,
  WorkspaceBinding,
} from "@rika/execution"
import { Effect, Option, Schema } from "effect"
import { NestedOperation, Pins, SkillCatalog, ToolContext } from "generalist"
import {
  ContentIdentity,
  GuidanceFile,
  SkillMetadata,
  skillBodyIdentity,
  skillMetadataIdentity,
  type SkillMetadata as SkillMetadataType,
} from "./contract"
import { WorkspaceReaderError, type WorkspaceReaderService, validateBinding } from "./workspace"

export const workspaceContextToolName = "rika_workspace_context"

const SkillName = Schema.String.pipe(Schema.check(Schema.isNonEmpty()), Schema.check(Schema.isMaxLength(512)))

export const WorkspaceContextRequest = Schema.Union([
  Schema.TaggedStruct("ReadGuidance", {}),
  Schema.TaggedStruct("ListSkills", {}),
  Schema.TaggedStruct("ReadSkill", { name: SkillName }),
])
export type WorkspaceContextRequest = typeof WorkspaceContextRequest.Type

export const WorkspaceContextDispatch = Schema.Struct({
  binding: WorkspaceBinding,
  request: WorkspaceContextRequest,
})
export type WorkspaceContextDispatch = typeof WorkspaceContextDispatch.Type

export const WorkspaceContextResponse = Schema.Union([
  Schema.TaggedStruct("Guidance", { files: Schema.Array(GuidanceFile) }),
  Schema.TaggedStruct("Skills", { skills: Schema.Array(SkillMetadata) }),
  Schema.TaggedStruct("Skill", {
    name: SkillName,
    body: Schema.String,
    identity: ContentIdentity,
  }),
])
export type WorkspaceContextResponse = typeof WorkspaceContextResponse.Type

export interface WorkspaceContextHandlerOptions {
  readonly reader: WorkspaceReaderService
  readonly binding: WorkspaceBinding
}

export interface RemoteWorkspaceReaderOptions {
  readonly binding: WorkspaceBinding
  readonly workspace: WorkspaceExecutorService
}

type BoundedWireValue = Schema.Json | ExecutorEvidence

const failure = (reason: WorkspaceReaderError["reason"], message: string) =>
  WorkspaceReaderError.make({ reason, message })

const unavailable = () => failure("unavailable", "Workspace context transport is unavailable")

const safeReaderError = (error: WorkspaceReaderError, message: string) => failure(error.reason, message)

const skillFailure = (message: string) => SkillCatalog.SkillCatalogError.make({ source: "workspace", message })

const within = (value: BoundedWireValue, limit: number): boolean => {
  try {
    const encoded = JSON.stringify(value)
    return encoded !== undefined && new TextEncoder().encode(encoded).byteLength <= limit
  } catch {
    return false
  }
}

const sameIdentity = (
  left: { readonly codec: string; readonly version: string; readonly digest: string },
  right: { readonly codec: string; readonly version: string; readonly digest: string },
) => left.codec === right.codec && left.version === right.version && left.digest === right.digest

type SkillListing = Pick<
  SkillCatalog.Skill,
  | "name"
  | "description"
  | "whenToUse"
  | "allowedTools"
  | "disableModelInvocation"
  | "userInvocable"
  | "contextFork"
  | "paths"
>

const metadataInput = (skill: SkillListing): Omit<SkillMetadataType, "identity"> => {
  const input: Omit<SkillMetadataType, "identity"> = { name: skill.name, description: skill.description }
  if (skill.whenToUse !== undefined) Object.assign(input, { whenToUse: skill.whenToUse })
  if (skill.allowedTools !== undefined) Object.assign(input, { allowedTools: skill.allowedTools })
  if (skill.disableModelInvocation !== undefined)
    Object.assign(input, { disableModelInvocation: skill.disableModelInvocation })
  if (skill.userInvocable !== undefined) Object.assign(input, { userInvocable: skill.userInvocable })
  if (skill.contextFork !== undefined) Object.assign(input, { contextFork: skill.contextFork })
  if (skill.paths !== undefined) Object.assign(input, { paths: skill.paths })
  return input
}

const metadataFor = (skill: SkillCatalog.Skill): Effect.Effect<SkillMetadataType, WorkspaceReaderError> => {
  const input = metadataInput(skill)
  return Schema.decodeEffect(SkillMetadata)({ ...input, identity: skillMetadataIdentity(input) }).pipe(
    Effect.mapError(() => failure("malformed", "Workspace skill metadata is invalid")),
  )
}

const responseFor = (
  reader: WorkspaceReaderService,
  binding: WorkspaceBinding,
  request: WorkspaceContextRequest,
): Effect.Effect<WorkspaceContextResponse, WorkspaceReaderError> => {
  switch (request._tag) {
    case "ReadGuidance":
      return reader.readGuidance(binding).pipe(
        Effect.mapError((error) => safeReaderError(error, "Workspace guidance is unavailable")),
        Effect.map((files) => ({ _tag: "Guidance" as const, files })),
      )
    case "ListSkills":
      return reader.listSkills(binding).pipe(
        Effect.mapError((error) => safeReaderError(error, "Workspace skill metadata is unavailable")),
        Effect.flatMap((skills) => Effect.forEach(skills, metadataFor)),
        Effect.flatMap((skills) =>
          new Set(skills.map((skill) => skill.name)).size === skills.length
            ? Effect.succeed({ _tag: "Skills" as const, skills })
            : Effect.fail(failure("malformed", "Workspace skill names are not unique")),
        ),
      )
    case "ReadSkill":
      return reader.listSkills(binding).pipe(
        Effect.mapError((error) => safeReaderError(error, "Workspace skill is unavailable")),
        Effect.flatMap((skills) => {
          const selected = skills.filter((skill) => skill.name === request.name)
          if (selected.length !== 1) return Effect.fail(failure("unavailable", "Workspace skill is unavailable"))
          const skill = selected[0]
          if (skill === undefined) return Effect.fail(failure("unavailable", "Workspace skill is unavailable"))
          return skill.instructions.pipe(
            Effect.mapError(() => failure("malformed", "Workspace skill body is unavailable")),
            Effect.map((body) => ({
              _tag: "Skill" as const,
              name: request.name,
              body,
              identity: skillBodyIdentity(body),
            })),
          )
        }),
      )
  }
}

const decodeDispatch = (input: Schema.Json): Effect.Effect<WorkspaceContextDispatch, WorkspaceReaderError> => {
  if (!within(input, maxDispatchBytes))
    return Effect.fail(failure("forbidden", "Workspace context request exceeds the byte limit"))
  return Schema.decodeUnknownEffect(WorkspaceContextDispatch)(input).pipe(
    Effect.mapError(() => failure("malformed", "Workspace context request is invalid")),
  )
}

const encodeResponse = (response: WorkspaceContextResponse): Effect.Effect<Schema.Json, WorkspaceReaderError> =>
  Schema.encodeEffect(WorkspaceContextResponse)(response).pipe(
    Effect.mapError(() => failure("malformed", "Workspace context response is invalid")),
    Effect.flatMap((encoded) =>
      within(encoded, maxReceiptBytes)
        ? Effect.succeed(encoded)
        : Effect.fail(failure("forbidden", "Workspace context response exceeds the byte limit")),
    ),
  )

export const handleWorkspaceContextRequest = Effect.fn("WorkspaceContext.handle")(function* (
  options: WorkspaceContextHandlerOptions,
  input: Schema.Json,
) {
  const expected = yield* validateBinding(options.binding)
  if (!sameBinding(expected, expected)) return yield* failure("binding", "Workspace binding is invalid")
  const dispatch = yield* decodeDispatch(input)
  const received = yield* validateBinding(dispatch.binding)
  if (!sameBinding(expected, received)) return yield* failure("binding", "Workspace binding does not match this reader")
  return yield* responseFor(options.reader, received, dispatch.request).pipe(Effect.flatMap(encodeResponse))
})

const decodeResponse = (value: Schema.Json): Effect.Effect<WorkspaceContextResponse, WorkspaceReaderError> => {
  if (!within(value, maxReceiptBytes))
    return Effect.fail(failure("forbidden", "Workspace context response exceeds the byte limit"))
  return Schema.decodeUnknownEffect(WorkspaceContextResponse)(value).pipe(
    Effect.mapError(() => failure("malformed", "Workspace context response is invalid")),
  )
}

const decodeFailure = (value: Schema.Json): Effect.Effect<never, WorkspaceReaderError> => {
  if (!within(value, maxReceiptBytes)) return Effect.fail(unavailable())
  return Schema.decodeUnknownEffect(WorkspaceReaderError)(value).pipe(
    Effect.mapError(() => failure("malformed", "Workspace context failure is invalid")),
    Effect.flatMap((error) => Effect.fail(safeReaderError(error, "Workspace context read failed"))),
  )
}

const dispatchRequest = (
  options: RemoteWorkspaceReaderOptions,
  request: WorkspaceContextRequest,
): Effect.Effect<WorkspaceContextResponse, WorkspaceReaderError> =>
  Effect.gen(function* () {
    const operations = yield* Effect.serviceOption(NestedOperation.Operations)
    const toolContext = yield* Effect.serviceOption(ToolContext.ToolContext)
    if (Option.isNone(operations) || Option.isNone(toolContext))
      return yield* failure("unavailable", "Workspace context requires a Generalist durable Tool operation context")
    const operationKey = toolContext.value.operationKey?.trim()
    if (operationKey === undefined || operationKey.length === 0)
      return yield* failure("unavailable", "Workspace context requires a stable Tool operation key")
    const binding = yield* validateBinding(options.binding)
    const current = yield* validateBinding(options.workspace.binding)
    if (!sameBinding(binding, binding) || !sameBinding(binding, current))
      return yield* failure("binding", "Workspace binding does not match the current executor")
    const payload = yield* Schema.encodeEffect(WorkspaceContextDispatch)({ binding, request }).pipe(
      Effect.mapError(() => failure("malformed", "Workspace context request is invalid")),
    )
    if (!within(payload, maxDispatchBytes))
      return yield* failure("forbidden", "Workspace context request exceeds the byte limit")
    const requestDigest = Pins.digest(payload)
    const intent = yield* Schema.decodeEffect(NativeOperationIntent)({
      operationId: `workspace-context:${Pins.digest({ operationKey, requestDigest })}`,
      tool: workspaceContextToolName,
      inputDigest: requestDigest,
      binding,
    }).pipe(Effect.mapError(() => failure("malformed", "Workspace context operation identity is invalid")))
    if (!within(intent, maxDispatchBytes))
      return yield* failure("forbidden", "Workspace context operation exceeds the byte limit")
    const handshakeRequest = HandshakeRequest.make({ binding })
    if (!within(handshakeRequest, maxHandshakeBytes))
      return yield* failure("forbidden", "Workspace context handshake exceeds the byte limit")
    const execution = Effect.gen(function* () {
      const handshake = yield* options.workspace.handshake(handshakeRequest).pipe(Effect.mapError(unavailable))
      yield* validateHandshake(binding, handshake).pipe(
        Effect.mapError(() => failure("binding", "Workspace context handshake did not match the binding")),
      )
      const evidence = yield* options.workspace.dispatch(intent, payload, handshake).pipe(Effect.mapError(unavailable))
      if (!within(evidence, maxReceiptBytes))
        return yield* failure("forbidden", "Workspace context evidence exceeds the byte limit")
      const verified = yield* validateEvidence(intent, evidence).pipe(
        Effect.mapError(() => failure("binding", "Workspace context evidence did not match the request")),
      )
      switch (verified.outcome._tag) {
        case "Completed":
          return yield* decodeResponse(verified.outcome.result)
        case "DomainFailure":
          return yield* decodeFailure(verified.outcome.failure)
        case "Accepted":
        case "Unknown":
          return yield* failure("unavailable", "Workspace context read did not return an immediate result")
      }
    })
    return yield* NestedOperation.run(
      {
        kind: "rika.workspace.context",
        payload,
        replayPolicy: "provider-idempotent",
        success: WorkspaceContextResponse,
        failure: WorkspaceReaderError,
      },
      execution,
    ).pipe(
      Effect.provideService(NestedOperation.Operations, operations.value),
      Effect.provideService(ToolContext.ToolContext, toolContext.value),
      Effect.mapError((error) =>
        Schema.is(WorkspaceReaderError)(error)
          ? safeReaderError(error, "Workspace context read failed")
          : failure("unavailable", "Workspace context durable operation failed"),
      ),
    )
  })

const remoteSkill = (
  metadata: SkillMetadataType,
  dispatch: (request: WorkspaceContextRequest) => Effect.Effect<WorkspaceContextResponse, WorkspaceReaderError>,
): SkillCatalog.Skill => ({
  ...metadataInput(metadata),
  instructions: dispatch({ _tag: "ReadSkill", name: metadata.name }).pipe(
    Effect.flatMap((response) => {
      if (response._tag !== "Skill" || response.name !== metadata.name)
        return Effect.fail(skillFailure("Workspace skill response is invalid"))
      return sameIdentity(response.identity, skillBodyIdentity(response.body))
        ? Effect.succeed(response.body)
        : Effect.fail(skillFailure("Workspace skill body identity is invalid"))
    }),
    Effect.mapError(() => skillFailure("Workspace skill body is unavailable")),
  ),
  tools: [],
})

export const remoteWorkspaceReader = (options: RemoteWorkspaceReaderOptions): WorkspaceReaderService => {
  const dispatch = (request: WorkspaceContextRequest) => dispatchRequest(options, request)
  return {
    readGuidance: (binding) =>
      validateBinding(binding).pipe(
        Effect.flatMap((received) =>
          sameBinding(options.binding, received)
            ? dispatch({ _tag: "ReadGuidance" }).pipe(
                Effect.flatMap((response) =>
                  response._tag === "Guidance"
                    ? Effect.succeed(response.files)
                    : Effect.fail(failure("malformed", "Workspace guidance response is invalid")),
                ),
              )
            : Effect.fail(failure("binding", "Workspace binding does not match this reader")),
        ),
      ),
    listSkills: (binding) =>
      validateBinding(binding).pipe(
        Effect.flatMap((received) =>
          sameBinding(options.binding, received)
            ? dispatch({ _tag: "ListSkills" }).pipe(
                Effect.flatMap((response) => {
                  if (response._tag !== "Skills")
                    return Effect.fail(failure("malformed", "Workspace skill response is invalid"))
                  if (new Set(response.skills.map((skill) => skill.name)).size !== response.skills.length)
                    return Effect.fail(failure("malformed", "Workspace skill names are not unique"))
                  if (
                    !response.skills.every((skill) =>
                      sameIdentity(skill.identity, skillMetadataIdentity(metadataInput(skill))),
                    )
                  )
                    return Effect.fail(failure("malformed", "Workspace skill metadata identity is invalid"))
                  return Effect.succeed(response.skills.map((skill) => remoteSkill(skill, dispatch)))
                }),
              )
            : Effect.fail(failure("binding", "Workspace binding does not match this reader")),
        ),
      ),
  }
}
