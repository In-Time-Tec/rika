import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ProductOperation from "@rika/product/product-operation"
import { Crypto, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type { Input } from "../command/root/hosted"
import * as HostedAccount from "./account"
import * as HostedBrowser from "./browser"
import { Browser, CredentialStore, HostedError, Http, ProfileStore } from "./contract"
import * as HostedCredentialStore from "./credential-store"
import * as HostedHttp from "./http"
import * as HostedProfileStore from "./profile-store"
import * as OpenAiProviderAuth from "../provider/openai/auth"

export const liveLayer = (home: string) =>
  Layer.mergeAll(
    HostedHttp.layer,
    HostedProfileStore.layer({ home }),
    HostedCredentialStore.layer({
      filename: `${home}/.config/rika/hosted-credential.json`,
      lockPath: `${home}/.config/rika/hosted-refresh.lock`,
    }),
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

const authOperation = (input: Extract<Input, { readonly _tag: "Auth" }>) => {
  if (input.action === "login") return HostedAccount.login(input)
  if (input.action === "status") return HostedAccount.status(input.json)
  if (input.action === "logout") return input.all === true ? HostedAccount.logoutAll() : HostedAccount.logout()
  if (input.action === "devices") return HostedAccount.devices()
  return HostedAccount.revokeDevice(input.device)
}

const organizationOperation = (input: Extract<Input, { readonly _tag: "Organization" }>) => {
  if (input.action === "list") return HostedAccount.listOrganizations()
  if (input.action === "personal") return HostedAccount.usePersonalOwner()
  if (input.action === "use") return HostedAccount.useOrganization(input.organization)
  return HostedAccount.invite(input.email)
}

const projectOperation = (input: Extract<Input, { readonly _tag: "Project" }>) => {
  if (input.action === "list") return HostedAccount.listProjects()
  if (input.action === "create") return HostedAccount.createProject(input.name)
  return HostedAccount.useProject(input.project)
}

const credentialOperation = (input: Extract<Input, { readonly _tag: "Credential" }>) => {
  if (input.action === "put") return HostedAccount.putProviderCredential(input.provider, input.apiKey)
  if (input.action === "list") return HostedAccount.listProviderCredentials(input.provider)
  return HostedAccount.revokeProviderCredential(input.provider)
}

const providerOperation = (input: Extract<Input, { readonly _tag: "Provider" }>) => {
  if (input.action === "login") return loginOpenAiAccount(input.deviceCode)
  if (input.action === "status") return HostedAccount.getOpenAiAccount()
  return HostedAccount.revokeOpenAiAccount()
}

const secretOperation = (input: Extract<Input, { readonly _tag: "Secret" }>) =>
  input.action === "put"
    ? HostedAccount.putSecret(
        input.name,
        input.value,
        input.scope,
        input.phase === undefined ? ["setup", "runtime"] : [input.phase],
      )
    : HostedAccount.revokeSecret(input.name, input.scope)

const operation = (
  input: Input,
): Effect.Effect<
  void,
  HostedError,
  | Browser
  | ChildProcessSpawner.ChildProcessSpawner
  | CredentialStore
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Http
  | OpenAiAuth.Service
  | ProfileStore
> => {
  if (input._tag === "Auth") return authOperation(input)
  if (input._tag === "Organization") return organizationOperation(input)
  if (input._tag === "Project") return projectOperation(input)
  if (input._tag === "Credential") return credentialOperation(input)
  if (input._tag === "Provider") return providerOperation(input)
  if (input._tag === "Secret") return secretOperation(input)
  return Effect.fail(HostedError.make({ kind: "protocol", message: `${input._tag} requires the V2 client` }))
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
