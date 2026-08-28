import { MaximumArchiveBytes } from "@rika/remote-execution/workspace-archive"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { Authorization, ServiceUnavailable, Unauthorized, Unprocessable } from "../access"

const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SourceRepository = Schema.String.check(
  Schema.isPattern(/^[^/\s]{1,512}\/[^/\s]{1,512}$/),
  Schema.isMaxLength(1_025),
)
const Archive = Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(MaximumArchiveBytes)).pipe(
  HttpApiSchema.asUint8Array({ contentType: "application/vnd.rika.workspace-seed+zstd" }),
)
const WorkspaceSeedResponse = Schema.Struct({
  id: Schema.NonEmptyString,
  contentDigest: Digest,
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  expiresAt: Schema.String,
}).pipe(HttpApiSchema.status(201))

export class WorkspaceSeedsGroup extends HttpApiGroup.make("workspaceSeeds", { topLevel: true })
  .add(
    HttpApiEndpoint.post("stageWorkspaceSeed", "/api/v1/workspace-seeds", {
      headers: {
        "x-rika-content-digest": Digest,
        "x-rika-source-repository": Schema.optionalKey(SourceRepository),
      },
      payload: Archive,
      success: WorkspaceSeedResponse,
      error: [Unauthorized, Unprocessable, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}
