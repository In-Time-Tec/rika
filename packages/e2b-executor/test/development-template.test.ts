import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  developmentTemplateSourceDigest,
  isReadyDevelopmentTemplate,
  type DevelopmentTemplateIdentity,
} from "../src/development-template"

const identity: DevelopmentTemplateIdentity = {
  sourceDigest: `sha256:${"a".repeat(64)}`,
  templateId: "template",
  buildId: "build",
}

const status = {
  templateID: "template",
  buildID: "build",
  status: "ready" as const,
  logEntries: [],
  logs: [],
}

describe("development E2B template", () => {
  it.effect("hashes the exact Docker build definition", () =>
    Effect.gen(function* () {
      const repositoryRoot = new URL("../../..", import.meta.url).pathname
      const first = yield* Effect.tryPromise(() => developmentTemplateSourceDigest(repositoryRoot))
      const second = yield* Effect.tryPromise(() => developmentTemplateSourceDigest(repositoryRoot))
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(second).toBe(first)
    }),
  )

  it("accepts only the cached ready build for the current source", () => {
    expect(isReadyDevelopmentTemplate(identity, identity.sourceDigest, status)).toBe(true)
    expect(isReadyDevelopmentTemplate(identity, `sha256:${"b".repeat(64)}`, status)).toBe(false)
    expect(isReadyDevelopmentTemplate(identity, identity.sourceDigest, { ...status, buildID: "other" })).toBe(false)
    expect(isReadyDevelopmentTemplate(identity, identity.sourceDigest, { ...status, status: "error" })).toBe(false)
  })
})
