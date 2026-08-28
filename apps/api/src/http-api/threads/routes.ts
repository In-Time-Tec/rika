import { Schema } from "effect"
import { ThreadId } from "@rika/product/hosted-model"
import { ThreadSummary } from "@rika/product/thread-summary"
import { Unit } from "@rika/transcript/transcript-unit"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Authorization, ConnectionOwner, Forbidden, NotFound, ServiceUnavailable, Unauthorized } from "../access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const ThreadListRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    project_id: Schema.optionalKey(Schema.NonEmptyString),
  }),
)
const ThreadListResponse = Schema.Struct({ threads: Schema.Array(ThreadSummary) })
const ThreadPreviewResponse = Schema.Struct({ units: Schema.Array(Unit) })

export class ThreadsGroup extends HttpApiGroup.make("thread-list", { topLevel: true })
  .add(
    HttpApiEndpoint.post("listThreads", "/api/v1/threads/list", {
      payload: ThreadListRequest,
      success: ThreadListResponse,
      error: [Unauthorized, Forbidden, ServiceUnavailable],
    }),
    HttpApiEndpoint.get("previewThread", "/api/v1/threads/:threadId/preview", {
      params: { threadId: ThreadId },
      success: ThreadPreviewResponse,
      error: [Unauthorized, Forbidden, NotFound, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}
