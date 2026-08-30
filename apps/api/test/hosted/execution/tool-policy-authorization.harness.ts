import { expect } from "@effect/vitest"
import { ActorAttribution } from "@rika/product/hosted-model"
import { rikaHostedToolAuditRecords, rikaTranscriptCheckpoints, rikaTurns } from "@rika/product-store/database-schema"
import { Effect, Schema } from "effect"
import { count, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import type { HostedToolPolicyService, RecordDecisionInput } from "../../../src/hosted/execution/tool-policy"

type Policy = HostedToolPolicyService
type Database = ReturnType<typeof drizzle>
const runAuthorizationAssertions = (policy: Policy, db: Database, personalActor: ActorAttribution, rawMarker: string) =>
  Effect.gen(function* () {
    const Json = Schema.fromJsonString(Schema.Json)
    const authorizationProjectionState = {
      authorizations: [
        [
          "internal-approval",
          {
            authorizationId: "internal-approval",
            rawRunId: "personal-turn",
            approvalId: "personal-approval",
            unitKey: "personal-authorization",
          },
        ],
      ],
    }
    const authorizationState = yield* Schema.encodeEffect(Json)(authorizationProjectionState)
    yield* Effect.tryPromise(() =>
      db.insert(rikaTurns).values({
        id: "personal-turn",
        threadId: "personal-thread",
        prompt: "prompt",
        status: "waiting",
        executionRouteJson: "{}",
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    yield* Effect.tryPromise(() =>
      db.insert(rikaTranscriptCheckpoints).values({
        turnId: "personal-turn",
        threadId: "personal-thread",
        revision: 0,
        projectionVersion: 6,
        stateJson: "{}",
        projectorVersion: 6,
        projectorCursor: "current-cursor",
        projectorState: authorizationState,
        updatedAt: 1,
      }),
    )
    expect(
      yield* Effect.result(
        policy.recordDecision({
          ownerId: "personal-owner",
          threadId: "personal-thread",
          turnId: "personal-turn",
          actor: personalActor,
          authorizationId: "wrong-authorization",
          checkpoint: { version: 6, cursor: "wrong", state: "wrong" },
          decision: "approved",
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { kind: "conflict" } })
    const checkpointState = yield* Schema.encodeEffect(Json)({
      ...authorizationProjectionState,
      marker: `checkpoint-with-${rawMarker}`,
    })
    const authorizationDecision: RecordDecisionInput = {
      ownerId: "personal-owner",
      threadId: "personal-thread",
      turnId: "personal-turn",
      actor: personalActor,
      authorizationId: "internal-approval",
      checkpoint: {
        version: 6,
        cursor: "checkpoint-cursor",
        state: checkpointState,
      },
      decision: "approved",
    }
    const conflictingState = yield* Schema.encodeEffect(Json)({
      authorizations: [
        [
          "internal-approval",
          {
            authorizationId: "internal-approval",
            rawRunId: "different-run",
            approvalId: "different-approval",
            unitKey: "different-authorization",
          },
        ],
      ],
    })
    expect(
      yield* Effect.result(
        policy.recordDecision({
          ...authorizationDecision,
          checkpoint: {
            ...authorizationDecision.checkpoint,
            state: conflictingState,
          },
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { kind: "conflict" } })
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .select({ count: count() })
          .from(rikaHostedToolAuditRecords)
          .where(eq(rikaHostedToolAuditRecords.phase, "decision")),
      ))[0]?.count,
    ).toBe(0)
    yield* policy.recordDecision(authorizationDecision)
    yield* policy.recordDecision(authorizationDecision)
    expect(
      yield* Effect.result(
        policy.recordDecision({
          ...authorizationDecision,
          decision: "denied",
        }),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { kind: "conflict" },
    })
  })

export const authorizationAssertions = { run: runAuthorizationAssertions }
