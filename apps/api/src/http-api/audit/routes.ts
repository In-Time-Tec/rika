import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ToolAuditRecord } from "../../hosted/execution/tool-policy"
import { Authorization, ConnectionOwner, Forbidden, ServiceUnavailable } from "../access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const ToolAuditListRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  }),
)
const ToolAuditListResponse = Schema.Struct({ records: Schema.Array(ToolAuditRecord) })

export class AuditGroup extends HttpApiGroup.make("audit", { topLevel: true })
  .add(
    HttpApiEndpoint.post("listToolAudit", "/api/v1/tool-audit-records/list", {
      payload: ToolAuditListRequest,
      success: ToolAuditListResponse,
      error: [Forbidden, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}
