import { Crypto, Effect, Exit, Inspectable, Layer, Redacted, Ref, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { WorkspaceBinding } from "@rika/execution"
import { BoxId } from "@rika/box-executor"
import { threadPartition, type ThreadExecutionBinding } from "../../src/runtime/partition"
import { makeBoxEnrollmentAuthority, type BoxEnrollmentTicket } from "../../src/executor/box-enrollment"

const boxId = Schema.decodeSync(BoxId)("bx_23456789")
const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace",
  assignmentId: "assignment",
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
  buildId: "build",
  protocolVersion: 1,
})
const threadBinding: ThreadExecutionBinding = {
  partition: threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "orb" }),
  placement: binding.placement,
  workspaceBinding: binding,
}

const changedBindings = [
  { ...binding, assignmentId: "replacement" },
  { ...binding, generation: 2 },
  { ...binding, buildId: "other-build" },
  { ...binding, protocolVersion: 2 },
  { ...binding, placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "other-lineage" } },
  { ...binding, workspaceId: "other-workspace" },
].map((value) => Schema.decodeUnknownSync(WorkspaceBinding)(value))

const withCrypto = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunCrypto.layer).pipe(Effect.flatMap((services) => Effect.provide(effect, services))))

const incoming = (grant: BoxEnrollmentTicket) =>
  new Request(`https://rika.test/api/v2/boxes/${boxId}/executor`, {
    headers: { authorization: `Bearer ${Redacted.value(grant.ticket)}` },
  })

const fixture = Effect.gen(function* () {
  const current = yield* Ref.make<ThreadExecutionBinding | undefined>(threadBinding)
  const reads = yield* Ref.make(0)
  const authority = yield* makeBoxEnrollmentAuthority({
    publicUrl: "https://rika.test",
    crypto: yield* Crypto.Crypto,
    current: (receivedBox) =>
      Ref.update(reads, (value) => value + 1).pipe(
        Effect.andThen(Ref.get(current)),
        Effect.map((value) => (receivedBox === boxId ? value : undefined)),
      ),
  })
  return { current, reads, authority }
})

it.effect("issues redacted, single-use Box tickets without invoking identity or a provider", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    expect(yield* Ref.get(test.reads)).toBe(0)
    const grant = yield* test.authority.issue(boxId, binding)
    expect(grant).toMatchObject({
      url: `wss://rika.test/api/v2/boxes/${boxId}/executor`,
      expiresAtMillis: 60_000,
    })
    expect(Inspectable.toStringUnknown(grant)).not.toContain(Redacted.value(grant.ticket))
    const attempts = yield* Effect.all(
      [test.authority.authorize(incoming(grant), boxId), test.authority.authorize(incoming(grant), boxId)].map(
        Effect.result,
      ),
      { concurrency: 2 },
    )
    expect(attempts.filter((result) => result._tag === "Success")).toHaveLength(1)
    expect(attempts.filter((result) => result._tag === "Failure")).toHaveLength(1)
  }).pipe(withCrypto),
)

it.effect("rejects wrong origins, Box paths, methods, and credentials without consuming the current grant", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const grant = yield* test.authority.issue(boxId, binding)
    const request = incoming(grant)
    const invalid = [
      new Request(`https://other.test/api/v2/boxes/${boxId}/executor`, { headers: request.headers }),
      new Request(`https://rika.test/api/v2/threads/thread/executor`, { headers: request.headers }),
      new Request(request.url, { method: "POST", headers: request.headers }),
      new Request(request.url, { headers: { authorization: "DPoP unrelated", dpop: "unrelated" } }),
    ]
    for (const input of invalid) {
      const result = yield* Effect.result(test.authority.authorize(input, boxId))
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "unauthorized" } })
      expect(Inspectable.toStringUnknown(result)).not.toContain(Redacted.value(grant.ticket))
    }
    const authorized = yield* test.authority.authorize(request, boxId)
    expect(authorized.binding).toEqual(threadBinding)
  }).pipe(withCrypto),
)

it.effect("expires and rotates unused bootstrap tickets while keeping the established fence independently valid", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const first = yield* test.authority.issue(boxId, binding)
    const second = yield* test.authority.issue(boxId, binding)
    expect(yield* Effect.result(test.authority.authorize(incoming(first), boxId))).toMatchObject({ _tag: "Failure" })
    yield* TestClock.adjust("60 seconds")
    expect(yield* Effect.result(test.authority.authorize(incoming(second), boxId))).toMatchObject({ _tag: "Failure" })
    const third = yield* test.authority.issue(boxId, binding)
    const authorized = yield* test.authority.authorize(incoming(third), boxId)
    yield* TestClock.adjust("61 seconds")
    yield* authorized.validate
    yield* Ref.set(test.current, undefined)
    expect(yield* Effect.result(authorized.validate)).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })
  }).pipe(withCrypto),
)

it.effect("rejects stale fences before issue and rechecks all immutable binding fields on the connection", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    expect(yield* Effect.result(test.authority.issue(boxId, changedBindings[1]!))).toMatchObject({
      _tag: "Failure",
    })
    for (const replacement of changedBindings) {
      yield* Ref.set(test.current, threadBinding)
      const grant = yield* test.authority.issue(boxId, binding)
      const authorized = yield* test.authority.authorize(incoming(grant), boxId)
      yield* Ref.set(test.current, { ...threadBinding, workspaceBinding: replacement })
      expect(yield* Effect.result(authorized.validate)).toMatchObject({ _tag: "Failure" })
    }
  }).pipe(withCrypto),
)

it.effect("invalidates pending tickets and established authorizations with their process scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const test = yield* fixture.pipe(Scope.provide(scope))
    const grant = yield* test.authority.issue(boxId, binding)
    const authorized = yield* test.authority.authorize(incoming(grant), boxId)
    const pending = yield* test.authority.issue(boxId, binding)
    yield* Scope.close(scope, Exit.void)
    expect(yield* Effect.result(test.authority.authorize(incoming(pending), boxId))).toMatchObject({ _tag: "Failure" })
    expect(yield* Effect.result(authorized.validate)).toMatchObject({ _tag: "Failure" })
    expect(yield* Effect.result(test.authority.issue(boxId, binding))).toMatchObject({ _tag: "Failure" })
  }).pipe(withCrypto),
)

it.effect("rejects insecure nonlocal or credential-bearing enrollment origins before minting", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    for (const publicUrl of [
      "http://rika.test",
      "https://user:password@rika.test",
      "https://rika.test?secret=example",
      "https://rika.test#fragment",
      "https://rika.test/api",
    ]) {
      const result = yield* Effect.result(
        makeBoxEnrollmentAuthority({ publicUrl, crypto, current: () => Effect.succeed(threadBinding) }),
      )
      expect(result).toMatchObject({ _tag: "Failure" })
      expect(Inspectable.toStringUnknown(result)).not.toContain(publicUrl)
    }
  }).pipe(withCrypto),
)
