import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServiceUnavailable } from "../access"

const Status = Schema.Struct({ status: Schema.String })

export class PublicGroup extends HttpApiGroup.make("public", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/healthz", { success: Status }),
  HttpApiEndpoint.get("ready", "/readyz", { success: Status, error: ServiceUnavailable }),
) {}
