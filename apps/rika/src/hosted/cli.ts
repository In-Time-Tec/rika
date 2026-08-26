import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ProductOperation from "@rika/product/product-operation"
import { Crypto, Effect, Layer } from "effect"
import type { Input } from "../command/root/hosted"
import * as HostedAccount from "./account"
import * as HostedBrowser from "./browser"
import { Browser, CredentialStore, HostedError, Http, ProfileStore, ThreadClient } from "./contract"
import * as HostedCredentialStore from "./credential-store"
import * as HostedHttp from "./http"
import * as HostedProfileStore from "./profile-store"
import * as HostedThreadClient from "./thread-client"
import * as OpenAiProviderAuth from "../provider/openai/auth"

export const liveLayer = (home: string) =>
  Layer.mergeAll(
    HostedHttp.layer,
    HostedThreadClient.layer.pipe(Layer.provide(BunSocket.layerWebSocketConstructor)),
    HostedProfileStore.layer({ home }),
    HostedCredentialStore.layer({ lockPath: `${home}/.config/rika/hosted-refresh.lock` }),
    HostedBrowser.layer(),
    OpenAiProviderAuth.layer,
  )

const openAiFailure = (error: { readonly message: string }) =>
  HostedError.make({ kind: "protocol", message: error.message })

const loginOpenAiAccount = (deviceCode: boolean) =>
  Effect.gen(function* () {
    const auth = yield* OpenAiAuth.Service
    const credential = yield* (deviceCode ? auth.loginDevice : auth.loginBrowser()).pipe(Effect.mapError(openAiFailure))
    yield* HostedAccount.putOpenAiAccount(credential)
  })

const operation = (
  input: Input,
): Effect.Effect<
  void,
  HostedError,
  Browser | CredentialStore | Crypto.Crypto | Http | OpenAiAuth.Service | ProfileStore | ThreadClient
> => {
  if (input._tag === "Auth") {
    if (input.action === "login") return HostedAccount.login(input)
    if (input.action === "status") return HostedAccount.status(input.json)
    if (input.action === "logout") return input.all === true ? HostedAccount.logoutAll() : HostedAccount.logout()
    if (input.action === "devices") return HostedAccount.devices()
    return HostedAccount.revokeDevice(input.device)
  }
  if (input._tag === "Organization") {
    if (input.action === "list") return HostedAccount.listOrganizations()
    if (input.action === "personal") return HostedAccount.usePersonalOwner()
    if (input.action === "use") return HostedAccount.useOrganization(input.organization)
    return HostedAccount.invite(input.email)
  }
  if (input._tag === "Project") {
    if (input.action === "list") return HostedAccount.listProjects()
    if (input.action === "create") return HostedAccount.createProject(input.name)
    return HostedAccount.useProject(input.project)
  }
  if (input._tag === "RemoteRun") return HostedAccount.runThread(input.threadId, input.request)
  if (input._tag === "Credential") {
    if (input.action === "put") return HostedAccount.putProviderCredential(input.provider, input.apiKey)
    if (input.action === "list") return HostedAccount.listProviderCredentials(input.provider)
    return HostedAccount.revokeProviderCredential(input.provider)
  }
  if (input._tag === "Provider") {
    if (input.action === "login") return loginOpenAiAccount(input.deviceCode)
    if (input.action === "status") return HostedAccount.getOpenAiAccount()
    return HostedAccount.revokeOpenAiAccount()
  }
  if (input._tag === "Secret") {
    if (input.action === "put")
      return HostedAccount.putSecret(
        input.name,
        input.value,
        input.scope,
        input.phase === undefined ? ["setup", "runtime"] : [input.phase],
      )
    return HostedAccount.revokeSecret(input.name, input.scope)
  }
  if (input._tag === "ThreadService") {
    if (input.action === "ensure") return HostedAccount.ensureRepositoryService(input.threadId, input.service)
    return HostedAccount.stopRepositoryService(input.threadId, input.serviceId)
  }
  if (input._tag === "ThreadPortal") return HostedAccount.openThreadPortal(input.threadId, input.port)
  if (input._tag === "ThreadSync") return HostedAccount.syncRepository(input)
  return HostedAccount.createRemoteThread()
}

export const run = Effect.fn("HostedCli.run")(function* (input: Input) {
  return yield* operation(input).pipe(
    Effect.mapError((error) =>
      error.kind === "invalid-input"
        ? ProductOperation.InvalidInput.make({ message: error.message })
        : ProductOperation.OperationUnavailable.make({ operation: input._tag, message: error.message }),
    ),
  )
})
