import { expect } from "@effect/vitest"
import { identityMember } from "@rika/identity"
import { ActorAttribution } from "@rika/product/hosted-model"
import type { AccessWire, BindingRequest } from "@rika/remote-execution/protocol"
import { Crypto, Effect } from "effect"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import {
  type HostedToolPolicyService,
  argumentsDigest,
  organizationOwner,
  policyFor,
} from "../../../src/hosted/execution/tool-policy"

type Policy = HostedToolPolicyService
type Database = ReturnType<typeof drizzle>
const runOrganizationAssertions = (
  policy: Policy,
  db: Database,
  organizationActor: ActorAttribution,
  crypto: Crypto.Crypto,
  access: (assignmentId: string, instanceId: string) => AccessWire,
) =>
  Effect.gen(function* () {
    const organizationRequest = {
      module: "workspace",
      operation: "read",
      input: { path: "README.md" },
      sessionId: "organization-thread",
      cellId: "organization-call",
    } satisfies BindingRequest
    const organizationAdmission = yield* policy.begin({
      threadId: "organization-thread",
      turnId: "organization-turn",
      workspaceId: "organization-workspace",
      operationKey: "organization-operation",
      callId: "organization-call",
      request: organizationRequest,
      access: access("organization-assignment", "organization-instance"),
      policy: policyFor(organizationRequest),
      argumentsDigest: yield* argumentsDigest(organizationRequest.input).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      ),
    })
    yield* policy.outcome({
      ...organizationAdmission,
      outcome: "succeeded",
    })
    expect(
      yield* policy.list({
        principal: { userId: "organization-user" },
        owner: organizationOwner("organization-1"),
        limit: 100,
      }),
    ).toHaveLength(2)
    yield* Effect.tryPromise(() => db.delete(identityMember).where(eq(identityMember.id, "organization-member")))
    expect(
      yield* Effect.result(
        policy.list({
          principal: { userId: "organization-user" },
          owner: organizationOwner("organization-1"),
          limit: 100,
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })
  })

export const organizationAssertions = { run: runOrganizationAssertions }
