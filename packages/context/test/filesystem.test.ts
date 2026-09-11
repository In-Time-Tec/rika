import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { WorkspaceBinding } from "@rika/execution"
import { filesystemWorkspaceReader } from "../src/filesystem"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace-1",
  assignmentId: "assignment-1",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace-1", checkoutFingerprint: "checkout-1" },
  buildId: "build-1",
  protocolVersion: 1,
})

const otherBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace-1",
  assignmentId: "assignment-2",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace-1", checkoutFingerprint: "checkout-1" },
  buildId: "build-1",
  protocolVersion: 1,
})

const document = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\nallowed-tools: [read]\n---\n${body}`

it.layer(BunServices.layer)((test) => {
  test.effect("reads the supported root guidance convention without exposing unrelated files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-reader-" })
        const checkout = `${root}/checkout`
        yield* fileSystem.makeDirectory(checkout)
        yield* fileSystem.writeFileString(`${checkout}/AGENT.md`, "fallback guidance")
        yield* fileSystem.writeFileString(`${checkout}/.env`, "ignored")
        const reader = yield* filesystemWorkspaceReader({ checkout, binding })
        expect(yield* reader.readGuidance(binding)).toEqual([{ path: "AGENT.md", content: "fallback guidance" }])
        yield* fileSystem.writeFileString(`${checkout}/AGENTS.md`, "primary guidance")
        expect(yield* reader.readGuidance(binding)).toEqual([{ path: "AGENTS.md", content: "primary guidance" }])
      }),
    ),
  )

  test.effect("returns bounded skill metadata while keeping the body lazy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-reader-" })
        const checkout = `${root}/checkout`
        const skill = `${checkout}/.agents/skills/review/SKILL.md`
        yield* fileSystem.makeDirectory(`${checkout}/.agents/skills/review`, { recursive: true })
        yield* fileSystem.writeFileString(skill, document("review", "before listing"))
        const reader = yield* filesystemWorkspaceReader({ checkout, binding })
        const skills = yield* reader.listSkills(binding)
        expect(skills.map((entry) => [entry.name, entry.description, entry.allowedTools])).toEqual([
          ["review", "review skill", ["read"]],
        ])
        const review = skills[0]
        expect(review).toBeDefined()
        if (review === undefined) return
        yield* fileSystem.writeFileString(skill, document("review", "after listing"))
        expect(yield* review.instructions).toBe("after listing")
        yield* fileSystem.writeFileString(skill, document("review", "x".repeat(65_536)))
        const oversized = yield* Effect.flip(review.instructions)
        expect(oversized.message).toContain("size limit")
      }),
    ),
  )

  test.effect("rejects bindings other than the explicitly supplied binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-reader-" })
        const reader = yield* filesystemWorkspaceReader({ checkout, binding })
        const guidanceError = yield* Effect.flip(reader.readGuidance(otherBinding))
        const skillsError = yield* Effect.flip(reader.listSkills(otherBinding))
        const relativeCheckoutError = yield* Effect.flip(filesystemWorkspaceReader({ checkout: ".", binding }))
        expect(guidanceError.reason).toBe("binding")
        expect(skillsError.reason).toBe("binding")
        expect(relativeCheckoutError.reason).toBe("forbidden")
      }),
    ),
  )

  test.effect("rejects guidance and skill symlinks that escape the checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-reader-" })
        const checkout = `${root}/checkout`
        const outside = `${root}/outside`
        yield* fileSystem.makeDirectory(`${checkout}/.agents/skills/review`, { recursive: true })
        yield* fileSystem.makeDirectory(outside)
        yield* fileSystem.writeFileString(`${outside}/AGENTS.md`, "outside guidance")
        yield* fileSystem.writeFileString(`${outside}/SKILL.md`, document("review", "outside skill"))
        yield* fileSystem.symlink(`${outside}/AGENTS.md`, `${checkout}/AGENTS.md`)
        yield* fileSystem.symlink(`${outside}/SKILL.md`, `${checkout}/.agents/skills/review/SKILL.md`)
        const reader = yield* filesystemWorkspaceReader({ checkout, binding })
        const guidanceError = yield* Effect.flip(reader.readGuidance(binding))
        const skillError = yield* Effect.flip(reader.listSkills(binding))
        expect(guidanceError.reason).toBe("forbidden")
        expect(skillError.reason).toBe("forbidden")
      }),
    ),
  )

  test.effect("rejects oversized guidance and bounded skill listings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-reader-" })
        const checkout = `${root}/checkout`
        yield* fileSystem.makeDirectory(`${checkout}/.agents/skills`, { recursive: true })
        yield* fileSystem.writeFileString(`${checkout}/AGENTS.md`, "x".repeat(65_537))
        for (let index = 0; index <= 64; index += 1) {
          const name = `skill-${String(index).padStart(2, "0")}`
          yield* fileSystem.makeDirectory(`${checkout}/.agents/skills/${name}`)
          yield* fileSystem.writeFileString(`${checkout}/.agents/skills/${name}/SKILL.md`, document(name, "body"))
        }
        const reader = yield* filesystemWorkspaceReader({ checkout, binding })
        const guidanceError = yield* Effect.flip(reader.readGuidance(binding))
        const skillError = yield* Effect.flip(reader.listSkills(binding))
        expect(guidanceError.reason).toBe("forbidden")
        expect(skillError.reason).toBe("forbidden")
      }),
    ),
  )
})
