import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import * as SkillFileSystem from "../../src/skill/file-system"
import { provideLayer } from "../support/extension-test-layer"

const document = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

test("workspace skills override global skills and activation lazily loads contained resources", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skills-" })
      const globalRoot = `${root}/global`
      const workspaceRoot = `${root}/workspace`
      yield* fileSystem.makeDirectory(`${globalRoot}/review`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspaceRoot}/review/references`, { recursive: true })
      yield* fileSystem.makeDirectory(`${globalRoot}/build`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/review/SKILL.md`, document("review", "global", "global body"))
      yield* fileSystem.writeFileString(
        `${workspaceRoot}/review/SKILL.md`,
        document("review", "workspace", "workspace body"),
      )
      yield* fileSystem.writeFileString(`${workspaceRoot}/review/references/checklist.md`, "check")
      yield* fileSystem.writeFileString(`${globalRoot}/build/SKILL.md`, document("build", "build things", "build body"))
      const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot, descriptionCap: 20 })
      const selected = yield* registry.source.get("review")
      const activated = yield* registry.activate("review")
      return { registry, selected, activated }
    }).pipe(provideLayer(SkillFileSystem.fileSystemLayer)),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* program
      const second = yield* program
      expect(first.registry.listings).toEqual(["- build: build things", "- review: workspace"])
      expect(first.selected?.description).toBe("workspace")
      expect(first.activated).toEqual({
        body: "workspace body",
        resources: [{ path: "references/checklist.md", content: "check" }],
      })
      expect(first.registry.digest).toHaveLength(64)
      expect(first.registry.digest).toBe(second.registry.digest)
    }).pipe(provideLayer(BunServices.layer)),
  )
})

test("rejects a resource symlink that escapes the selected skill directory", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-symlink-" })
        const globalRoot = `${root}/global`
        const workspaceRoot = `${root}/workspace`
        const skillRoot = `${workspaceRoot}/review`
        const outside = `${root}/outside.txt`
        yield* fileSystem.makeDirectory(skillRoot, { recursive: true })
        yield* fileSystem.writeFileString(`${skillRoot}/SKILL.md`, document("review", "review", "body"))
        yield* fileSystem.writeFileString(outside, "outside")
        yield* fileSystem.symlink(outside, `${skillRoot}/outside.txt`)
        const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
        const error = yield* Effect.flip(registry.activate("review"))
        expect(error.operation).toBe("activate")
        expect(error.message).toBe("Resource path escapes skill directory")
      }).pipe(provideLayer(SkillFileSystem.fileSystemLayer)),
    ).pipe(provideLayer(BunServices.layer)),
  ))

test("rejects a manifest symlink that escapes the selected skill directory", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-manifest-symlink-" })
        const globalRoot = `${root}/global`
        const workspaceRoot = `${root}/workspace`
        const skillRoot = `${workspaceRoot}/review`
        const outside = `${root}/SKILL.md`
        yield* fileSystem.makeDirectory(skillRoot, { recursive: true })
        yield* fileSystem.writeFileString(outside, document("review", "review", "outside"))
        yield* fileSystem.symlink(outside, `${skillRoot}/SKILL.md`)
        const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
        const error = yield* Effect.flip(registry.activate("review"))
        expect(error.operation).toBe("activate")
        expect(error.message).toBe("Skill manifest escapes skill directory")
      }).pipe(provideLayer(SkillFileSystem.fileSystemLayer)),
    ).pipe(provideLayer(BunServices.layer)),
  ))

test("returns a typed error for missing activation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* SkillRegistry.discover({ globalRoot: "/global", workspaceRoot: "/workspace" })
      const result = yield* Effect.flip(registry.activate("missing"))
      expect(result._tag).toBe("@rika/extensions/SkillRegistryError")
    }).pipe(
      provideLayer(
        Layer.merge(
          SkillFileSystem.fileSystemTestLayer({}, {}).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      ),
    ),
  ))

test("an executable manifest that points outside its skill directory is refused", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      // A package manifest declares runnable content, so one reached by following a link out of the
      // skill directory would run something the roots were meant to bound. The listing beside it is
      // text a model reads and is not the boundary this guards.
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skills-escape-" })
      const workspaceRoot = `${root}/workspace`
      yield* fileSystem.makeDirectory(`${root}/outside`, { recursive: true })
      yield* fileSystem.makeDirectory(`${root}/global`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspaceRoot}/sneak`, { recursive: true })
      yield* fileSystem.writeFileString(`${workspaceRoot}/sneak/SKILL.md`, document("sneak", "escapes", "body"))
      yield* fileSystem.writeFileString(`${root}/outside/package.json`, '{ "name": "sneak" }')
      yield* fileSystem.symlink(`${root}/outside/package.json`, `${workspaceRoot}/sneak/package.json`)
      const discovered = yield* Effect.exit(SkillRegistry.discover({ globalRoot: `${root}/global`, workspaceRoot }))
      expect(discovered._tag).toBe("Failure")
    }),
  )
  return Effect.runPromise(
    provideLayer(
      program,
      Layer.mergeAll(SkillFileSystem.fileSystemLayer.pipe(Layer.provide(BunServices.layer)), BunServices.layer),
    ),
  )
})

test("a skill directory reached by a link out of the root is refused", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      // Discovery reads its root recursively and follows what it finds, so a link inside the root
      // can name a directory outside it. A skill is executable content.
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skills-link-" })
      const workspaceRoot = `${root}/workspace`
      yield* fileSystem.makeDirectory(`${root}/outside/secret`, { recursive: true })
      yield* fileSystem.makeDirectory(`${root}/global`, { recursive: true })
      yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true })
      yield* fileSystem.writeFileString(`${root}/outside/secret/SKILL.md`, document("secret", "outside", "body"))
      yield* fileSystem.writeFileString(`${root}/outside/secret/package.json`, '{ "name": "secret" }')
      yield* fileSystem.symlink(`${root}/outside/secret`, `${workspaceRoot}/secret`)
      const discovered = yield* Effect.exit(SkillRegistry.discover({ globalRoot: `${root}/global`, workspaceRoot }))
      expect(discovered._tag).toBe("Failure")
    }),
  )
  return Effect.runPromise(
    provideLayer(
      program,
      Layer.mergeAll(SkillFileSystem.fileSystemLayer.pipe(Layer.provide(BunServices.layer)), BunServices.layer),
    ),
  )
})

test("serves a nested skill's own resources rather than a flat directory of the same name", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      // Discovery reads its root recursively, so a skill can live below it. Deriving its directory
      // from its name instead reads whatever sits at the top with that name.
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skills-nested-" })
      const workspaceRoot = `${root}/workspace`
      yield* fileSystem.makeDirectory(`${root}/global`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspaceRoot}/nested/deep`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspaceRoot}/deep`, { recursive: true })
      yield* fileSystem.writeFileString(
        `${workspaceRoot}/nested/deep/SKILL.md`,
        document("deep", "the real one", "REAL BODY"),
      )
      yield* fileSystem.writeFileString(`${workspaceRoot}/nested/deep/own.md`, "REAL RESOURCE")
      yield* fileSystem.writeFileString(
        `${workspaceRoot}/deep/SKILL.md`,
        document("deep", "the impostor", "IMPOSTOR BODY"),
      )
      yield* fileSystem.writeFileString(`${workspaceRoot}/deep/notes.md`, "IMPOSTOR RESOURCE")
      const registry = yield* SkillRegistry.discover({ globalRoot: `${root}/global`, workspaceRoot })
      const activated = yield* registry.activate("deep")
      expect(activated.resources.map((resource) => resource.content)).toEqual(["REAL RESOURCE"])
    }),
  )
  return Effect.runPromise(
    provideLayer(
      program,
      Layer.mergeAll(SkillFileSystem.fileSystemLayer.pipe(Layer.provide(BunServices.layer)), BunServices.layer),
    ),
  )
})
