import { Effect, Layer } from "effect"
import type { Input } from "../command/root/hosted-command-dispatch"
import * as HostedAccount from "./hosted-account"
import * as HostedBrowser from "./hosted-browser"
import * as HostedCredentialStore from "./hosted-credential-store"
import * as HostedHttp from "./hosted-http"
import * as HostedForeground from "./hosted-foreground"
import * as HostedProfileStore from "./hosted-profile-store"

export const liveLayer = (home: string) =>
  Layer.mergeAll(
    HostedHttp.layer,
    HostedProfileStore.layer({ home }),
    HostedCredentialStore.layer(),
    HostedCredentialStore.receiptLayer(),
    HostedBrowser.layer(),
  )

const runWithServices = Effect.fn("HostedCli.run")(function* (input: Input) {
  if (input._tag === "Auth") {
    if (input.action === "login") return yield* HostedAccount.login(input)
    if (input.action === "status") return yield* HostedAccount.status(input.json)
    if (input.action === "logout") return yield* input.all === true ? HostedAccount.logoutAll() : HostedAccount.logout()
    if (input.action === "devices") return yield* HostedAccount.devices()
    return yield* HostedAccount.revokeDevice(input.device)
  }
  if (input._tag === "Organization") {
    if (input.action === "list") return yield* HostedAccount.listOrganizations()
    if (input.action === "use") return yield* HostedAccount.useOrganization(input.organization)
    return yield* HostedAccount.invite(input.email)
  }
  if (input._tag === "RemoteRun") return yield* HostedAccount.runThread(input.threadId, input.request)
  if (input._tag === "LocalThread") return yield* HostedAccount.createLocalThread()
  if (input._tag === "LocalForeground") return yield* HostedForeground.run(input)
  return yield* HostedAccount.createRemoteThread()
})

export const run = runWithServices
