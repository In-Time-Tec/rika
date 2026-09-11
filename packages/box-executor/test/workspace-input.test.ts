import { expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"

import { BoxId } from "../src/contract"
import type { BoxTransport } from "../src/provider"
import { makeBoxWorkspaceInputClient } from "../src/workspace-input"
import {
  BoxWorkspaceInputPolicy,
  BoxWorkspaceInputReceipt,
  boxWorkspaceInputPaths,
} from "../src/workspace-input-contract"

const boxId = Schema.decodeSync(BoxId)("bx_23456789")
const policy = Schema.decodeSync(BoxWorkspaceInputPolicy)({
  workspaceId: "workspace-box-input",
  placement: { _tag: "Orb", workspaceId: "workspace-box-input", lineageId: "lineage-box-input" },
  buildId: "runner-build-1",
  protocolVersion: 1,
  checkout: null,
  seed: {
    id: "seed-1",
    sourceRepository: null,
    archiveDigest: `sha256:${"2".repeat(64)}`,
    archiveSizeBytes: 64,
  },
})
const paths = boxWorkspaceInputPaths(policy)
const receipt = Schema.encodeSync(Schema.fromJsonString(BoxWorkspaceInputReceipt))({
  version: 1,
  policyDigest: paths.policyDigest,
})
const credentials = "fleet-provider-secret"

const readWith = (acknowledgedPath: string, content = receipt): BoxTransport => ({
  request: () =>
    Effect.succeed(
      Response.json(
        {
          ok: true,
          type: "file.read",
          success: true,
          path: acknowledgedPath,
          encoding: "utf8",
          size: new TextEncoder().encode(content).byteLength,
          content,
        },
        { headers: { "content-type": "application/json" } },
      ),
    ),
})

const client = (transport: BoxTransport) =>
  makeBoxWorkspaceInputClient({
    baseUrl: "https://ascii.test/api/box/v1",
    apiKey: Redacted.make(credentials, { label: "box-fleet" }),
    transport,
  })

it.effect("accepts the absolute receipt acknowledgement", () =>
  Effect.gen(function* () {
    expect(yield* client(readWith(paths.receipt)).inspect({ boxId, policy })).toBe(true)
  }),
)

it.effect("accepts the escaped acknowledgement used for paths outside the workspace home", () =>
  Effect.gen(function* () {
    expect(yield* client(readWith(`../..${paths.receipt}`)).inspect({ boxId, policy })).toBe(true)
  }),
)

it.effect("accepts the home-relative acknowledgement returned for paths beneath the workspace home", () =>
  Effect.gen(function* () {
    expect(
      yield* client(readWith("workspace/.rika/secrets/workspace-input.json")).inspect({ boxId, policy }),
    ).toBe(true)
  }),
)

it.effect("rejects a foreign path acknowledgement", () =>
  Effect.gen(function* () {
    const exit = yield* client(readWith("/etc/passwd")).inspect({ boxId, policy }).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

it.effect("rejects a receipt published under a different policy", () =>
  Effect.gen(function* () {
    const foreign = yield* Schema.encodeEffect(Schema.fromJsonString(BoxWorkspaceInputReceipt))({
      version: 1,
      policyDigest: "0".repeat(64),
    })
    const exit = yield* client(readWith(paths.receipt, foreign)).inspect({ boxId, policy }).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)
