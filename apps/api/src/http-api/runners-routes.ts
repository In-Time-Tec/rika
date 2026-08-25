import { Schema } from "effect"
import { ThreadId } from "@rika/product/hosted-model"
import { ClientTicketResponse } from "@rika/product/client-protocol"
import {
  CheckoutFingerprint,
  RemoteThreadCreationPreference,
  RunnerPollRequest,
  RunnerPollResult,
  RunnerProfile,
} from "@rika/product/runner-registration"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { Authorization, Conflict, Forbidden, NotFound, ServiceUnavailable, Unauthorized } from "./access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const ThreadTicketResponse = ClientTicketResponse.pipe(HttpApiSchema.status(201))
const RunnerAdmissionRequest = strict(
  Schema.Struct({
    workspace_fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
)
const RunnerAdmissionResponse = Schema.Struct({
  assignmentId: Schema.String,
  admissionId: Schema.String,
  ticket: Schema.String,
  expiresAt: Schema.Finite,
  executorUrl: Schema.String,
  workspaceIdentity: Schema.String,
}).pipe(HttpApiSchema.status(201))

export class RunnersGroup extends HttpApiGroup.make("runners", { topLevel: true })
  .add(
    HttpApiEndpoint.post("issueThreadTicket", "/api/v1/thread-sessions", {
      success: ThreadTicketResponse,
      error: [Unauthorized, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("admitRunner", "/api/v1/threads/:threadId/runner-admissions", {
      params: { threadId: ThreadId },
      payload: RunnerAdmissionRequest,
      success: RunnerAdmissionResponse,
      error: [Forbidden, NotFound, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("registerRunner", "/api/v1/runners/:checkoutFingerprint", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      payload: RunnerProfile,
      success: HttpApiSchema.NoContent,
      error: [Forbidden, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("setRemoteThreadCreation", "/api/v1/runners/:checkoutFingerprint/remote-thread-creation", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      payload: RemoteThreadCreationPreference,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("pollRunner", "/api/v1/runners/:checkoutFingerprint/admissions", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      payload: RunnerPollRequest,
      success: RunnerPollResult,
      error: [Forbidden, Conflict, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}
