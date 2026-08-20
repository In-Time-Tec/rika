import * as ProductOperation from "@rika/product/product-operation"
import { Effect, Layer } from "effect"
import type { Input } from "../command/root/hosted-command-dispatch"
import * as HostedAccount from "./hosted-account"
import * as HostedBrowser from "./hosted-browser"
import * as HostedCredentialStore from "./hosted-credential-store"
import * as HostedHttp from "./hosted-http"
import * as HostedProfileStore from "./hosted-profile-store"

export const liveLayer = (home: string) =>
  Layer.mergeAll(
    HostedHttp.layer,
    HostedProfileStore.layer({ home }),
    HostedCredentialStore.layer(),
    HostedBrowser.layer(),
  )

const operation = (input: Input) => {
  if (input._tag === "Auth") {
    if (input.action === "login") return HostedAccount.login(input)
    if (input.action === "status") return HostedAccount.status(input.json)
    if (input.action === "logout") return input.all === true ? HostedAccount.logoutAll() : HostedAccount.logout()
    if (input.action === "devices") return HostedAccount.devices()
    return HostedAccount.revokeDevice(input.device)
  }
  if (input._tag === "Organization") {
    if (input.action === "list") return HostedAccount.listOrganizations()
    if (input.action === "use") return HostedAccount.useOrganization(input.organization)
    return HostedAccount.invite(input.email)
  }
  if (input._tag === "RemoteRun") return HostedAccount.runThread(input.threadId, input.request)
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
