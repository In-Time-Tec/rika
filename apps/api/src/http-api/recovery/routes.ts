import { Schema } from "effect"
import { ThreadId } from "@rika/product/hosted-model"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { RecoveryOperation } from "../../hosted/execution/recovery"
import { Authorization, Conflict, Forbidden, NotFound, ServiceUnavailable, Unprocessable } from "../access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const OperationKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
)
const RecoveryOperationsResponse = Schema.Struct({ operations: Schema.Array(RecoveryOperation) })
const RecoveryResolutionRequest = strict(
  Schema.Union([
    Schema.Struct({ action: Schema.Literal("retry") }),
    Schema.Struct({ action: Schema.Literal("accept"), value: Schema.Unknown }),
    Schema.Struct({ action: Schema.Literal("abort"), reason: Schema.NonEmptyString }),
  ]),
)

export class RecoveryGroup extends HttpApiGroup.make("recovery", { topLevel: true })
  .add(
    HttpApiEndpoint.get("inspectRecovery", "/api/v1/threads/:threadId/runs/:runId/recovery", {
      params: { threadId: ThreadId, runId: Schema.NonEmptyString },
      success: RecoveryOperationsResponse,
      error: [Forbidden, NotFound, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("resolveRecovery", "/api/v1/threads/:threadId/runs/:runId/recovery/:operationId", {
      params: { threadId: ThreadId, runId: Schema.NonEmptyString, operationId: Schema.NonEmptyString },
      headers: { "idempotency-key": OperationKey },
      payload: RecoveryResolutionRequest,
      success: RecoveryOperation,
      error: [Forbidden, NotFound, Conflict, Unprocessable, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}
