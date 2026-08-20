import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AccountSchema, type AccountAccess, type AccountGatewayRequest } from "../account-gateway"

const accountUrl = (input: { readonly domain: string; readonly port: string }) =>
  new URL("/api/account", `http://${input.domain}:${input.port}`).href

const abortWhen = (signal: AbortSignal) =>
  Effect.callback<never, "request aborted">((resume) => {
    const abort = () => resume(Effect.fail("request aborted" as const))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })

export const makeApiAccountGateway = (input: {
  readonly domain: string
  readonly port: string
  readonly client: HttpClient.HttpClient
  readonly timeout?: number
}) => ({
  account: ({ cookie, signal }: AccountGatewayRequest): Effect.Effect<AccountAccess> =>
    input.client
      .execute(
        HttpClientRequest.get(accountUrl(input), {
          headers: cookie === undefined ? undefined : { cookie },
        }),
      )
      .pipe(
        Effect.raceFirst(abortWhen(signal)),
        Effect.timeoutOption(input.timeout ?? 2_000),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed({ _tag: "unavailable" } as const),
            onSome: (response) => {
              if (response.status === 401) return Effect.succeed({ _tag: "anonymous" } as const)
              if (response.status < 200 || response.status >= 300)
                return Effect.succeed({ _tag: "unavailable" } as const)
              return HttpClientResponse.schemaBodyJson(AccountSchema)(response).pipe(
                Effect.map((account): AccountAccess => ({ _tag: "account", account })),
                Effect.orElseSucceed((): AccountAccess => ({ _tag: "unavailable" })),
              )
            },
          }),
        ),
        Effect.orElseSucceed((): AccountAccess => ({ _tag: "unavailable" })),
      ),
})
