/* oxlint-disable anti-slop -- Rivet's public raw client is an I/O boundary and returns untyped JSON payloads. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread */
/* oxlint-disable anti-slop/no-chained-type-assertions -- the released factory hides its structural driver type. */
/* oxlint-disable effecttsgo/async-function -- ClientRaw and registry.handler are Promise-based public APIs. */
/* oxlint-disable effecttsgo/strict-boolean-expressions -- Web Fetch body/nullability is normalized at this adapter boundary. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Rivet's public ClientRaw constructor intentionally hides its driver interface. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- response.json() is intentionally treated as an untrusted payload. */
import { Effect } from "effect"
import type { ThreadPartition } from "./partition"
import {
  RuntimeGatewayError,
  type RootSessionReceipt,
  type RuntimeGateway,
  type RuntimeWebSocket,
} from "./runtime-gateway"
import { createRawRivetClient, type RawRivetClient, type RuntimeRegistry } from "./rivet-actor"
export { RIVET_ORIGINAL_REQUEST_URL } from "./rivet-protocol"

export interface RawRivetRegistry {
  readonly handler: RuntimeRegistry["handler"]
}

export interface RawRivetClientOptions {
  /** Origin used for requests passed to the registry handler. */
  readonly endpoint?: string
}

export interface RawRivetGatewayOptions extends RawRivetClientOptions {
  readonly registry: RawRivetRegistry
}

export interface RawRivetClientGateway {
  readonly client: RawRivetClient
  readonly ensureActor: (
    key: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly actorId: string; readonly created: boolean }, RuntimeGatewayError>
}

interface ActorOutput {
  readonly actorId: string
  readonly name: string
  readonly key: string
  readonly created?: boolean
}

interface ActorsResponse {
  readonly actors?: ReadonlyArray<{
    readonly actor_id?: unknown
    readonly name?: unknown
    readonly key?: unknown
  }>
  readonly actor?: {
    readonly actor_id?: unknown
    readonly name?: unknown
    readonly key?: unknown
  }
  readonly created?: unknown
}

const actorKey = (key: ReadonlyArray<string>) => {
  if (key.length === 0) return "/"
  return key
    .map((part) => {
      if (part === "") return "\\0"
      return part.replaceAll("\\", "\\\\").replaceAll("/", "\\/")
    })
    .join("/")
}

const actorOutput = (value: unknown): ActorOutput | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const actor = value as ActorsResponse["actor"]
  if (typeof actor?.actor_id !== "string" || typeof actor.name !== "string" || typeof actor.key !== "string")
    return undefined
  return { actorId: actor.actor_id, name: actor.name, key: actor.key }
}

// ast-grep-ignore: effect-prefer-program-construction -- foreign Fetch response adapter.
const responseBody = async (response: Response) => {
  try {
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

// ast-grep-ignore: effect-prefer-program-construction -- foreign Fetch response adapter.
const responseError = async (response: Response) => {
  const body = await responseBody(response)
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string")
    return body.message
  return `${response.status} ${response.statusText}`
}

// ast-grep-ignore: effect-prefer-program-construction -- foreign Fetch request adapter.
const requestBody = async (request: Request) => {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  if (!request.body) return undefined
  return new Uint8Array(await request.arrayBuffer())
}

// ast-grep-ignore: effect-prefer-program-construction -- Rivet registry's Promise-based handler adapter.
const makeRegistryRequest = async (registry: RawRivetRegistry, endpoint: string, path: string, init: RequestInit = {}) => {
  const body = init.body
  const request = new Request(new URL(path, endpoint).toString(), {
    ...init,
    ...(body === undefined ? {} : { body }),
  })
  return registry.handler(request)
}

// ast-grep-ignore: effect-prefer-program-construction -- Rivet registry's Promise-based handler adapter.
const engineActorRequest = async (registry: RawRivetRegistry, endpoint: string, input: {
  readonly method: "GET" | "PUT" | "POST"
  readonly path: string
  readonly body?: unknown
}) => {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body)
  const response = await makeRegistryRequest(registry, endpoint, input.path, {
    method: input.method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body,
  })
  if (!response.ok) throw new Error(await responseError(response))
  return responseBody(response)
}

const outputFromResponse = (value: unknown) => {
  if (typeof value !== "object" || value === null) return undefined
  const response = value as ActorsResponse
  const actor = response.actor ?? response.actors?.[0]
  const output = actorOutput(actor)
  if (output === undefined) return undefined
  return response.created === undefined || typeof response.created !== "boolean"
    ? output
    : { ...output, created: response.created }
}

const runtimeError = (error: unknown, kind: RuntimeGatewayError["kind"] = "unknown") =>
  RuntimeGatewayError.make({ kind, message: error instanceof Error ? error.message : String(error) })

/**
 * A small adapter around Rivet's released raw client. The adapter owns no actor identity: every operation resolves the
 * canonical actor by the stable key, and the registry remains the authority for actor creation and routing.
 */
export const makeRawRivetClient = (options: RawRivetGatewayOptions): RawRivetClientGateway => {
  const endpoint = options.endpoint ?? "http://rivet.local"
  // ast-grep-ignore: effect-prefer-program-construction -- released Rivet driver contract is Promise-based.
  const getWithKey = async (input: { readonly name: string; readonly key: ReadonlyArray<string> }) => {
    const value = await engineActorRequest(options.registry, endpoint, {
      method: "GET",
      path: `/actors?name=${encodeURIComponent(input.name)}&key=${encodeURIComponent(actorKey(input.key))}`,
    })
    return outputFromResponse(value)
  }
  // ast-grep-ignore: effect-prefer-program-construction -- released Rivet driver contract is Promise-based.
  const getOrCreateWithKey = async (input: { readonly name: string; readonly key: ReadonlyArray<string> }) => {
    const value = await engineActorRequest(options.registry, endpoint, {
      method: "PUT",
      path: "/actors",
      body: {
        name: input.name,
        key: actorKey(input.key),
        crash_policy: "sleep",
        runner_name_selector: "default",
      },
    })
    const output = outputFromResponse(value)
    if (output === undefined) throw new Error("Rivet did not return an actor identity")
    return output
  }
  // ast-grep-ignore: effect-prefer-program-construction -- released Rivet driver contract is Promise-based.
  const sendRequest = async (
    target:
      | { readonly directId: string }
      | { readonly getForKey: { readonly name: string; readonly key: ReadonlyArray<string> } },
    actorRequest: Request,
  ) => {
    const targetActor =
      "directId" in target
        ? target.directId
        : (await getWithKey({ name: target.getForKey.name, key: target.getForKey.key }))?.actorId
    if (targetActor === undefined) throw new Error("Rivet actor was not found for the canonical key")
    const actorUrl = new URL(actorRequest.url)
    const path = `${actorUrl.pathname}${actorUrl.search}`
    const body = await requestBody(actorRequest)
    const init: RequestInit = {
      method: actorRequest.method,
      headers: actorRequest.headers,
      signal: actorRequest.signal,
    }
    if (body !== undefined) Object.assign(init, { body })
    const response = await makeRegistryRequest(options.registry, endpoint, `/gateway/${encodeURIComponent(targetActor)}${path}`, init)
    return response
  }

  // The public raw-client factory takes an intentionally non-exported driver type, so the structural adapter is
  // narrowed at this one boundary while retaining normal Rivet raw-client request construction.
  const driver = { getWithKey, getOrCreateWithKey, sendRequest }
  const client = createRawRivetClient(driver as never)
  const ensureActor = (key: ReadonlyArray<string>): Effect.Effect<
    { readonly actorId: string; readonly created: boolean },
    RuntimeGatewayError
  > =>
    Effect.tryPromise({
      // ast-grep-ignore: effect-prefer-program-construction -- released Rivet driver contract is Promise-based.
      try: async () => {
        const existing = await getWithKey({ name: "rikaRuntime", key })
        if (existing !== undefined) return { actorId: existing.actorId, created: false }
        const created = await getOrCreateWithKey({ name: "rikaRuntime", key })
        return { actorId: created.actorId, created: created.created ?? true }
      },
      catch: (error) => runtimeError(error, "unavailable"),
    })
  return { client, ensureActor }
}

/** Build a RuntimeGateway that forwards existing Generalist Server routes through a concrete Rivet actor. */
export const makeRawRivetGateway = (options: RawRivetGatewayOptions): RuntimeGateway => {
  const raw = makeRawRivetClient(options)
  const actorFor = (partition: ThreadPartition) => raw.client.get("rikaRuntime", [...partition.actorKey])

  return {
    ensureRootSession: (partition, _commandId): Effect.Effect<RootSessionReceipt, RuntimeGatewayError> =>
      raw.ensureActor(partition.actorKey).pipe(
        Effect.map((result) => ({ sessionId: partition.rootSessionId, created: result.created })),
      ),
    handle: (partition, request, _websocket?: RuntimeWebSocket): Effect.Effect<Response, RuntimeGatewayError> =>
      Effect.tryPromise({
        try: () => actorFor(partition).fetch(request),
        catch: (error) => runtimeError(error, "unavailable"),
      }),
  }
}
