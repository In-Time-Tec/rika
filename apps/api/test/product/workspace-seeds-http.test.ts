import { IdentityRuntimeError, type IdentityPrincipal, type IdentityRuntime } from "@rika/identity"
import type { EncodedArchive } from "@rika/workspace-input/contract"
import { WorkspaceSeedServiceError, type WorkspaceSeedService } from "../../src/product/workspace-seeds"
import {
  MaximumWorkspaceSeedRequestBytes,
  makeWorkspaceSeedsRequestHandler,
  type WorkspaceSeedsHttpOptions,
} from "../../src/product/workspace-seeds-http"
import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

const digest = `sha256:${"a".repeat(64)}` as const
const archive: EncodedArchive = { content: "AQ==", contentDigest: digest, sizeBytes: 1 }
const principal: IdentityPrincipal = { userId: "user", clientId: "client", dpopJkt: "thumbprint" }
const unused = () => Effect.die("Unexpected workspace-seed HTTP fixture call")
const handled = (response: Response | undefined) =>
  response === undefined ? Effect.die("Expected workspace-seed handler to own this route") : Effect.succeed(response)
const readJson = (response: Response) =>
  // ast-grep-ignore: effect-prefer-promise-composition -- Response.text() is a foreign Web boundary in the fixture.
  Effect.promise(() => response.text()).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))),
    Effect.orDie,
  )

const post = (body: Schema.Json, headers: Record<string, string> = {}) =>
  new Request("https://rika.test/api/v2/workspace-seeds", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "DPoP proof-bound-token",
      dpop: "request-proof",
      ...headers,
    },
    body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))(body),
  })
const postText = (body: string) =>
  new Request("https://rika.test/api/v2/workspace-seeds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })

const fixture = (
  input: {
    readonly identify?: IdentityRuntime["identify"]
    readonly authenticate?: WorkspaceSeedsHttpOptions["devices"]["authenticate"]
    readonly stage?: WorkspaceSeedService["stage"]
  } = {},
) => {
  const staged: Array<Parameters<WorkspaceSeedService["stage"]>[0]> = []
  const requests: Request[] = []
  const workspaceSeeds: WorkspaceSeedService = {
    stage: (value) => {
      staged.push(value)
      return input.stage?.(value) ?? Effect.succeed({ workspaceSeedId: "workspace-seed" })
    },
  }
  const options: WorkspaceSeedsHttpOptions = {
    workspaceSeeds,
    identity: {
      handle: unused,
      identify: (request) => {
        requests.push(request)
        return input.identify?.(request) ?? Effect.succeed(principal)
      },
      browserSession: unused,
      protectedResourceMetadata: Effect.succeed({}),
    },
    directory: {
      ready: Effect.void,
      account: () =>
        Effect.succeed({
          user: { id: "user", name: "Rika User", email: "rika@example.test", emailVerified: true, image: null },
          memberships: [],
        }),
    },
    devices: {
      register: unused,
      discard: unused,
      authenticate: input.authenticate ?? (() => Effect.succeed("device")),
      list: unused,
      revoke: unused,
      revokeAll: unused,
    },
  }
  return { handler: makeWorkspaceSeedsRequestHandler(options), requests, staged }
}

it.effect("stages personal, organization, and Project requests from the authenticated device", () =>
  Effect.gen(function* () {
    const test = fixture()
    for (const body of [
      { owner: { kind: "personal" }, archive },
      { owner: { kind: "organization", organization_id: "organization" }, archive },
      { owner: { kind: "organization", organization_id: "organization" }, projectId: "project", archive },
    ]) {
      const request = post(body)
      const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
      expect(response.status).toBe(201)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(yield* readJson(response)).toEqual({ workspaceSeedId: "workspace-seed" })
      expect(test.requests.at(-1)).toBe(request)
    }
    expect(test.staged).toMatchObject([
      { actor: { userId: "user", clientId: "client", deviceId: "device" }, owner: { _tag: "PersonalOwner" } },
      { owner: { _tag: "OrganizationOwner", organizationId: "organization" } },
      { owner: { _tag: "OrganizationOwner", organizationId: "organization" }, projectId: "project" },
    ])
  }),
)

it.effect("rejects missing DPoP, missing devices, and revoked devices before consuming the archive", () =>
  Effect.gen(function* () {
    const tests = [
      fixture({ identify: () => Effect.fail(IdentityRuntimeError.make({ kind: "invalid" })) }),
      fixture({ identify: () => Effect.succeed({ userId: "user" }) }),
      fixture({ authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)) }),
    ]
    for (const test of tests) {
      const request = post({ owner: { kind: "personal" }, archive })
      const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="rika"')
      expect(request.bodyUsed).toBe(false)
      expect(test.staged).toEqual([])
    }
  }),
)

it.effect("rejects wrong content types, malformed JSON, excess fields, and declared oversize without mutation", () =>
  Effect.gen(function* () {
    const test = fixture()
    const requests = [
      post({ owner: { kind: "personal" }, archive }, { "content-type": "text/plain" }),
      postText("{"),
      post({ owner: { kind: "personal", userId: "spoofed" }, archive }),
      post({ owner: { kind: "personal" }, archive: { ...archive, objectKey: "posted-descriptor" } }),
      post(
        { owner: { kind: "personal" }, archive },
        { "content-length": String(MaximumWorkspaceSeedRequestBytes + 1) },
      ),
    ]
    for (const [index, request] of requests.entries()) {
      const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
      expect(response.status).toBe(index === requests.length - 1 ? 413 : 400)
    }
    expect(test.staged).toEqual([])
  }),
)

it.effect("maps digest and tar failures without reflecting archive material", () =>
  Effect.gen(function* () {
    const secret = "private-archive-material"
    const test = fixture({
      stage: () =>
        Effect.fail(WorkspaceSeedServiceError.make({ kind: "invalid", message: "Workspace archive is invalid" })),
    })
    const response = yield* test
      .handler(post({ owner: { kind: "personal" }, archive: { ...archive, content: secret } }))
      .pipe(Effect.flatMap(handled))
    expect(response.status).toBe(400)
    // ast-grep-ignore: effect-prefer-promise-composition -- Response.text() is a foreign Web boundary in the fixture.
    expect(yield* Effect.promise(() => response.text())).not.toContain(secret)
  }),
)

it.effect("leaves other methods and paths untouched", () =>
  Effect.gen(function* () {
    const test = fixture()
    expect(yield* test.handler(new Request("https://rika.test/api/v2/workspace-seeds"))).toBeUndefined()
    expect(
      yield* test.handler(new Request("https://rika.test/api/v2/workspace-seeds/other", { method: "POST" })),
    ).toBeUndefined()
  }),
)
