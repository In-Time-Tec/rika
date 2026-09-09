/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this explicit host is the application composition root. */
/* oxlint-disable effecttsgo/async-function -- the host exposes the platform Fetch contract. */
import { Effect, Schema } from "effect"
import type { ApiV2ApplicationOptions, ApiV2ApplicationService } from "./application"
import { makeApiV2Application } from "./application"
import type { RuntimeRegistry } from "./rivet-actor"

class ApiV2LocalHostError extends Schema.TaggedError<ApiV2LocalHostError>()("RikaApiV2LocalHostError", {
  message: Schema.String,
}) {}

export interface ApiV2LocalHost {
  readonly application: ApiV2ApplicationService
  readonly registry: RuntimeRegistry
  // ast-grep-ignore: effect-prefer-effect-signatures -- Bun Fetch is the explicit local host boundary.
  readonly fetch: (request: Request) => Promise<Response>
  // ast-grep-ignore: effect-prefer-effect-signatures -- Bun registry shutdown is a foreign lifecycle boundary.
  readonly close: () => Promise<void>
}

export interface ApiV2LocalServer extends ApiV2LocalHost {
  readonly url: string
}

export interface ApiV2LocalServerOptions extends ApiV2LocalHostOptions {
  readonly port: number
  readonly hostname?: string
}

export interface ApiV2LocalHostOptions extends ApiV2ApplicationOptions {
  /** Warm the Rivet serverless registry before returning. Defaults to true for explicit local compositions. */
  readonly startRegistry?: boolean
}

const isRivetRequest = (request: Request) => {
  const pathname = new URL(request.url).pathname
  return pathname === "/api/rivet" || pathname.startsWith("/api/rivet/")
}

/**
 * Compose one explicit local host. Rika HTTP owns `/api/v2`; Rivet owns `/api/rivet`, and the default gateway uses the
 * same registry instance instead of a fake callback or a second execution protocol.
 */
export const makeApiV2LocalHost = (options: ApiV2LocalHostOptions) =>
  makeApiV2Application(options).pipe(
    Effect.flatMap((application) => {
      const start =
        options.startRegistry === false
          ? Effect.void
          : Effect.tryPromise(() => application.registry.handler(new Request("http://rivet.local/api/rivet/metadata"))).pipe(
              Effect.flatMap((response) =>
                response.ok
                  ? Effect.void
                  : Effect.fail(ApiV2LocalHostError.make({ message: `Rivet registry readiness failed: ${response.status}` })),
              ),
            )
      return start.pipe(
        Effect.as({
          application,
          registry: application.registry,
          // ast-grep-ignore: effect-prefer-program-construction -- Bun Fetch is the explicit local host boundary.
          fetch: async (request: Request) => {
            if (isRivetRequest(request)) return application.registry.handler(request)
            return Effect.runPromise(
              application.handle({
                authority: application.authority,
                gateway: application.gateway,
                environment: application.environment,
                request,
              }),
            )
          },
          close: () => application.registry.shutdown(),
        } satisfies ApiV2LocalHost),
      )
    }),
  )

/** Start the explicit Bun HTTP host used by local acceptance tests and development probes. */
export const serveApiV2LocalHost = (options: ApiV2LocalServerOptions) =>
  // ast-grep-ignore: effect-prefer-program-construction -- Bun Server is a foreign lifecycle API.
  Effect.tryPromise(async () => {
    const hostname = options.hostname ?? "127.0.0.1"
    const localOptions = { ...options, startRegistry: false }
    const registry = localOptions.registry
    const pool = { url: `http://${hostname}:${options.port}/api/rivet` }
    if (registry === undefined) Object.assign(localOptions, { registry: { configurePool: pool } })
    else if (registry.configurePool === undefined) Object.assign(localOptions, { registry: { ...registry, configurePool: pool } })
    const host = await Effect.runPromise(makeApiV2LocalHost(localOptions))
    const serveOptions = {
      port: options.port,
      fetch: host.fetch,
    }
    if (options.hostname !== undefined) Object.assign(serveOptions, { hostname: options.hostname })
    // ast-grep-ignore: effect-prefer-http -- Bun Fetch is the explicit local server interop boundary.
    const server = Bun.serve(serveOptions)
    const ready = await host.registry.handler(new Request(`http://${server.hostname}:${server.port}/api/rivet/metadata`))
    if (!ready.ok) {
      await server.stop(true)
      await host.close()
      throw new Error(`Rivet registry readiness failed: ${ready.status}`)
    }
    return {
      ...host,
      url: `http://${server.hostname}:${server.port}`,
      // ast-grep-ignore: effect-prefer-program-construction -- Bun Server is a foreign lifecycle API.
      close: async () => {
        await server.stop(true)
        await host.close()
      },
    } satisfies ApiV2LocalServer
  })
