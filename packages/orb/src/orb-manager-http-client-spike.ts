import { Codec, Ids, Orb } from "@rika/schema"
import { Effect, Layer } from "effect"
import * as OrbManager from "./orb-manager"

export interface LayerInput {
  readonly baseUrl: string
  readonly token?: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export const layer = (input: LayerInput): Layer.Layer<OrbManager.Service> => {
  const fetchImpl = input.fetch ?? fetch
  const request = (
    path: string,
    operation: string,
    body?: unknown,
  ): Effect.Effect<Orb.OrbRecord, OrbManager.OrbProvisionError> =>
    Effect.tryPromise({
      try: async () => {
        const headers = new Headers()
        if (input.token !== undefined) headers.set("authorization", `Bearer ${input.token}`)
        if (body !== undefined) headers.set("content-type", "application/json")
        const response = await fetchImpl(`${input.baseUrl}${path}`, {
          method: "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const payload = await response.json().catch(() => undefined)
        if (!response.ok) throw errorFromPayload(payload, operation)
        return Codec.decode(Orb.OrbRecord)(payload)
      },
      catch: (cause) =>
        cause instanceof OrbManager.OrbProvisionError
          ? cause
          : new OrbManager.OrbProvisionError({
              message: messageFromUnknown(cause),
              step: operation,
            }),
    })
  return Layer.succeed(
    OrbManager.Service,
    OrbManager.Service.of({
      provisionForThread: (provisionInput) =>
        request("/v1/orb-manager/provision", "provision_http", Codec.encode(OrbManager.ProvisionInput)(provisionInput)),
      pause: (orbId) => request(`/v1/orb-manager/orbs/${encodeURIComponent(orbId)}/pause`, "pause_http"),
      resume: (orbId) => request(`/v1/orb-manager/orbs/${encodeURIComponent(orbId)}/resume`, "resume_http"),
      kill: (orbId) => request(`/v1/orb-manager/orbs/${encodeURIComponent(orbId)}/kill`, "kill_http"),
    }),
  )
}

const errorFromPayload = (payload: unknown, operation: string) => {
  if (isRecord(payload) && typeof payload.message === "string") {
    return new OrbManager.OrbProvisionError({
      message: payload.message,
      step: typeof payload.step === "string" ? payload.step : operation,
      ...(typeof payload.orb_id === "string" ? { orb_id: Ids.OrbId.make(payload.orb_id) } : {}),
      ...(typeof payload.sandbox_id === "string" ? { sandbox_id: payload.sandbox_id } : {}),
    })
  }
  return new OrbManager.OrbProvisionError({
    message: "Hosted OrbManager request failed",
    step: operation,
  })
}

const messageFromUnknown = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  return JSON.stringify(cause)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
