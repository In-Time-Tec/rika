import {
  WorkspaceSeedStageReceipt,
  WorkspaceSeedStageRequest,
  type WorkspaceSeedStageReceipt as WorkspaceSeedStageReceiptValue,
  type WorkspaceSeedStageRequestEncoded,
} from "@rika/workspace-input/workspace-seed-http-contract"
import { Effect, Schema } from "effect"
import { ProductClientError, type ProductRequestHeaders, type ProductTransport } from "./product"

export interface WorkspaceSeedClient {
  readonly stage: (
    input: WorkspaceSeedStageRequestEncoded,
  ) => Effect.Effect<WorkspaceSeedStageReceiptValue, ProductClientError>
}

const protocol = (message: string, status?: number) =>
  status === undefined
    ? ProductClientError.make({ kind: "protocol", message })
    : ProductClientError.make({ kind: "protocol", message, status })
const network = () => ProductClientError.make({ kind: "network", message: "Workspace seed request could not be sent" })

const statusFailure = (response: Response) => {
  if (response.status === 401)
    return ProductClientError.make({
      kind: "unauthorized",
      message: "Workspace seed request was not authorized",
      status: response.status,
    })
  if (response.status === 403)
    return ProductClientError.make({
      kind: "forbidden",
      message: "Workspace seed request was forbidden",
      status: response.status,
    })
  return protocol("Workspace seed request returned an unexpected status", response.status)
}

const endpoint = (baseUrl: string | URL) =>
  Effect.try({
    try: () => {
      const base = new URL(baseUrl)
      if (
        (base.protocol !== "http:" && base.protocol !== "https:") ||
        base.username.length > 0 ||
        base.password.length > 0 ||
        base.search.length > 0 ||
        base.hash.length > 0
      )
        throw new Error("invalid base URL")
      return new URL("api/v2/workspace-seeds", `${base.toString().replace(/\/$/, "")}/`).toString()
    },
    catch: () => protocol("Workspace seed base URL is invalid"),
  })

const readReceipt = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: () => protocol("Workspace seed response was invalid", response.status),
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(WorkspaceSeedStageReceipt))),
    Effect.mapError(() => protocol("Workspace seed response was invalid", response.status)),
  )

export const makeWorkspaceSeedClient = (options: {
  readonly baseUrl: string | URL
  readonly transport: ProductTransport
  readonly requestHeaders: ProductRequestHeaders
}): WorkspaceSeedClient => {
  const stage: WorkspaceSeedClient["stage"] = (input) =>
    Effect.gen(function* () {
      const validated = yield* Schema.decodeEffect(WorkspaceSeedStageRequest)(input).pipe(
        Effect.mapError(() => protocol("Workspace seed request was invalid")),
      )
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceSeedStageRequest))(validated).pipe(
        Effect.mapError(() => protocol("Workspace seed request was invalid")),
      )
      const url = yield* endpoint(options.baseUrl)
      const headers = new Headers(yield* options.requestHeaders({ method: "POST", url }))
      headers.set("content-type", "application/json")
      const request = yield* Effect.try({
        try: () => new Request(url, { method: "POST", headers, body }),
        catch: () => protocol("Workspace seed request could not be constructed"),
      })
      const response = yield* options.transport.request(request).pipe(Effect.mapError(network))
      if (response.status !== 201) return yield* statusFailure(response)
      return yield* readReceipt(response)
    })
  return { stage }
}
