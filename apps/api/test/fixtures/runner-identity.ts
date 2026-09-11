import { Clock, Effect } from "effect"
import type { RunnerConnectionOptions } from "../../src/executor/runner-connection"

export const runnerIdentityFixture = Effect.gen(function* () {
  const state = { expiresAt: (yield* Clock.currentTimeMillis) + 60_000, revoked: false, generation: "1" }
  const requests: Request[] = []
  const unused = () => Effect.die("Unexpected Runner identity fixture call")
  const options: RunnerConnectionOptions = {
    environment: "test",
    identity: {
      identify: (request) =>
        Effect.sync(() => {
          requests.push(request)
          if (
            request.headers.get("authorization") !== "DPoP fixture-runner" ||
            request.headers.get("dpop") !== "fixture-proof"
          )
            return undefined
          return { userId: "user", clientId: "client", dpopJkt: "fixture-thumbprint", expiresAt: state.expiresAt }
        }),
      handle: unused,
      browserSession: unused,
      protectedResourceMetadata: Effect.succeed({}),
    },
    directory: {
      ready: Effect.void,
      account: () =>
        Effect.succeed({
          user: { id: "user", name: "User", email: "user@example.test", image: null, emailVerified: true },
          memberships: [],
        }),
    },
    devices: {
      register: unused,
      discard: unused,
      list: unused,
      revoke: unused,
      revokeAll: unused,
      authenticate: () => Effect.sync(() => (state.revoked ? undefined : "device")),
    },
    product: {
      threadAuthority: (_userId, threadId) =>
        Effect.succeed(
          threadId !== "hosted-runner"
            ? undefined
            : {
                ownerId: "owner",
                kind: "personal",
                userId: "user",
                organizationId: null,
                membershipId: null,
                createdByUserId: "user",
                executorKind: "runner",
                inheritProjectGrants: false,
                threadRole: null,
                projectRole: null,
              },
        ),
      threadExecutionContext: () =>
        Effect.sync(() => ({
          assignmentId: "assignment",
          workspaceId: "workspace",
          title: "Thread",
          hasTurns: false,
          executorKind: "runner",
          generation: state.generation,
          lifecycle: "pending",
          executorInstanceId: null,
          providerInstanceId: null,
          checkout: null,
          localRepository: null,
          placement: {
            _tag: "RunnerPlacement",
            deviceId: "device",
            requestingDeviceId: "device",
            checkoutFingerprint: "checkout",
            executorPolicy: { buildId: "build", protocolVersion: 1 },
          },
        })),
    },
  }
  return { options, state, requests }
})
