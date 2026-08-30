import { expect } from "@effect/vitest"
import { ActorAttribution } from "@rika/product/hosted-model"
import { rikaHostedClientAuthorities, rikaHostedToolAuditRecords } from "@rika/product-store/database-schema"
import type { AccessWire } from "@rika/remote-execution/protocol"
import { DateTime, Effect } from "effect"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { inspect } from "node:util"
import { type HostedToolPolicyService, personalOwner, policyFor } from "../../../src/hosted/execution/tool-policy"

type Policy = HostedToolPolicyService
type Database = ReturnType<typeof drizzle>
const runAuditAssertions = (
  policy: Policy,
  db: Database,
  personalActor: ActorAttribution,
  rawMarker: string,
  request: Parameters<Policy["begin"]>[0]["request"],
  admission: Effect.Success<ReturnType<Policy["begin"]>>,
  access: (assignmentId: string, instanceId: string) => AccessWire,
) =>
  Effect.gen(function* () {
    const records = yield* policy.list({
      principal: { userId: "personal-user" },
      owner: personalOwner("personal-user"),
      limit: 100,
    })
    expect(
      records.map(({ phase, decision, outcome }) => ({
        phase,
        decision,
        outcome,
      })),
    ).toEqual([
      { phase: "outcome", decision: "pending", outcome: "succeeded" },
      { phase: "decision", decision: "approved", outcome: "admitted" },
      { phase: "outcome", decision: "pending", outcome: "suspended" },
      { phase: "admission", decision: "pending", outcome: "admitted" },
    ])
    expect(records.find(({ phase }) => phase === "decision")).toMatchObject({
      authorizationId: "internal-approval",
      authorizationCheckpoint: {
        version: 6,
        cursor: "checkpoint-cursor",
      },
    })
    const stored = inspect(yield* Effect.tryPromise(() => db.select().from(rikaHostedToolAuditRecords)), {
      depth: null,
    })
    expect(stored).not.toContain(rawMarker)
    expect(stored).not.toContain("command")
    const mutation = yield* Effect.result(
      Effect.tryPromise(() =>
        db
          .update(rikaHostedToolAuditRecords)
          .set({ outcome: "failed" })
          .where(eq(rikaHostedToolAuditRecords.sequence, 1)),
      ),
    )
    expect(mutation._tag).toBe("Failure")
    const deletion = yield* Effect.result(
      Effect.tryPromise(() => db.delete(rikaHostedToolAuditRecords).where(eq(rikaHostedToolAuditRecords.sequence, 1))),
    )
    expect(deletion._tag).toBe("Failure")
    const foreign = yield* Effect.result(
      policy.list({
        principal: { userId: "foreign-user" },
        owner: personalOwner("personal-user"),
        limit: 100,
      }),
    )
    expect(foreign).toMatchObject({
      _tag: "Failure",
      failure: { kind: "forbidden" },
    })
    const revokedAt = DateTime.toDate(DateTime.nowUnsafe())
    yield* Effect.tryPromise(() =>
      db
        .update(rikaHostedClientAuthorities)
        .set({ revokedAt })
        .where(
          and(
            eq(rikaHostedClientAuthorities.clientId, "personal-client"),
            eq(rikaHostedClientAuthorities.ownerId, "personal-owner"),
          ),
        ),
    )
    expect(
      yield* Effect.result(
        policy.begin({
          threadId: "personal-thread",
          turnId: "personal-turn",
          workspaceId: "personal-workspace",
          operationKey: "revoked-operation",
          callId: "revoked-call",
          request,
          access: access("personal-assignment", "personal-instance"),
          policy: policyFor(request),
          argumentsDigest: admission.argumentsDigest,
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })
  })

export const auditAssertions = { run: runAuditAssertions }
