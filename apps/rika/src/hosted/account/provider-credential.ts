import { Console, Effect, Redacted } from "effect"
import type { Credential as OpenAiAccountCredential } from "@rika/product/openai-auth-contract"
import { Http, type ModelProvider } from "../contract"
import { authenticated, selectedProfile } from "./session"

export const putProviderCredential = Effect.fn("HostedAccount.putProviderCredential")(function* (
  provider: ModelProvider,
  apiKey: string,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.putProviderCredential(profile.origin, profile.owner, provider, Redacted.make(apiKey), session),
  )
  yield* Console.log(`${result.provider} credential is ${result.state} at revision ${result.revision}`)
})

export const listProviderCredentials = Effect.fn("HostedAccount.listProviderCredentials")(function* (
  provider?: ModelProvider,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const statuses = yield* authenticated(profile, (session) =>
    http.listProviderCredentials(profile.origin, profile.owner, session),
  )
  const selected = provider === undefined ? statuses : statuses.filter((entry) => entry.provider === provider)
  if (selected.length === 0) {
    yield* Console.log(
      provider === undefined ? "No provider credentials configured" : `${provider} credential is missing`,
    )
    return
  }
  for (const entry of selected) {
    yield* Console.log(`${entry.provider}\t${entry.state}\trevision ${entry.revision}`)
  }
})

export const revokeProviderCredential = Effect.fn("HostedAccount.revokeProviderCredential")(function* (
  provider: ModelProvider,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.revokeProviderCredential(profile.origin, profile.owner, provider, session),
  )
  yield* Console.log(`${result.provider} credential is ${result.state} at revision ${result.revision}`)
})

export const putOpenAiAccount = Effect.fn("HostedAccount.putOpenAiAccount")(function* (
  credential: OpenAiAccountCredential,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.putOpenAiAccount(profile.origin, profile.owner, credential, session),
  )
  yield* Console.log(`OpenAI account is ${result.state}`)
})

export const getOpenAiAccount = Effect.fn("HostedAccount.getOpenAiAccount")(function* () {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.getOpenAiAccount(profile.origin, profile.owner, session),
  )
  yield* Console.log(
    result.state === "missing" ? "OpenAI account is not connected" : `OpenAI account is ${result.state}`,
  )
})

export const revokeOpenAiAccount = Effect.fn("HostedAccount.revokeOpenAiAccount")(function* () {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.revokeOpenAiAccount(profile.origin, profile.owner, session),
  )
  yield* Console.log(result.state === "missing" ? "OpenAI account is not connected" : "OpenAI account logged out")
})
