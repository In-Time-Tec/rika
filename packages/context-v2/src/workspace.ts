import { Context, Effect, Layer, Schema } from "effect"
import { SkillCatalog } from "generalist"
import { WorkspaceBinding } from "@rika/execution-v2"
import type { GuidanceFile } from "./contract"

export class WorkspaceReaderError extends Schema.TaggedError<WorkspaceReaderError>()("RikaContextWorkspaceReaderError", {
  reason: Schema.Literals(["binding", "unavailable", "forbidden", "malformed"]),
  message: Schema.String,
}) {}

export interface WorkspaceReaderService {
  readonly readGuidance: (binding: WorkspaceBinding) => Effect.Effect<ReadonlyArray<GuidanceFile>, WorkspaceReaderError>
  readonly listSkills: (
    binding: WorkspaceBinding,
  ) => Effect.Effect<ReadonlyArray<SkillCatalog.Skill>, WorkspaceReaderError>
}

export class WorkspaceReader extends Context.Service<WorkspaceReader, WorkspaceReaderService>()(
  "@rika/context-v2/workspace/WorkspaceReader",
) {}

export const layerTest = (service: WorkspaceReaderService): Layer.Layer<WorkspaceReader> =>
  Layer.succeed(WorkspaceReader, service)

export const validateBinding = (binding: WorkspaceBinding): Effect.Effect<WorkspaceBinding, WorkspaceReaderError> =>
  Schema.decodeEffect(WorkspaceBinding)(binding).pipe(
    Effect.mapError(() => WorkspaceReaderError.make({ reason: "binding", message: "Workspace binding is invalid" })),
  )
