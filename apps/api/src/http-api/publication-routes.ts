import { Schema } from "effect"
import { ThreadId } from "@rika/product/hosted-model"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Authorization, Conflict, Forbidden, NotFound, ServiceUnavailable, Unprocessable } from "./access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const OperationKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
)
const RepositoryPublicationRequest = strict(
  Schema.Struct({
    commit_sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    target_branch: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    body: Schema.String.check(Schema.isMaxLength(65_536)),
  }),
)
const RepositoryPublicationResponse = Schema.Struct({
  publicationId: Schema.String,
  state: Schema.Literals(["approved", "pushing", "pushed", "completed", "failed", "unknown"]),
  branch: Schema.String,
  ref: Schema.String,
  commitSha: Schema.String,
  targetBranch: Schema.String,
  targetCommitSha: Schema.String,
  targetProtected: Schema.Boolean,
  pushResult: Schema.NullOr(Schema.Unknown),
  pullRequestResult: Schema.NullOr(Schema.Unknown),
})

export class PublicationGroup extends HttpApiGroup.make("publication", { topLevel: true })
  .add(
    HttpApiEndpoint.post("publishRepository", "/api/v1/threads/:threadId/repository-publications", {
      params: { threadId: ThreadId },
      headers: { "idempotency-key": OperationKey },
      payload: RepositoryPublicationRequest,
      success: RepositoryPublicationResponse,
      error: [Forbidden, NotFound, Conflict, Unprocessable, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}
