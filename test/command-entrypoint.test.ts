import { Effect, Schema } from "effect"
import { expect, test } from "vitest"
import { live, readText } from "./support/platform"

const Manifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
const manifest = await Effect.runPromise(
  live(Effect.flatMap(readText("package.json"), Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest)))),
)

test("root operational commands point directly at their owners", () => {
  expect(manifest.scripts.dev).toBe("bun run scripts/development/stack.ts local")
  expect(manifest.scripts["dev:remote"]).toBe("bun run scripts/development/stack.ts remote")
  expect(manifest.scripts["dev:remote:destroy"]).toBe("bun run scripts/development/stack.ts destroy")
  expect(manifest.scripts.package).toBe("bun run scripts/packaging/package-target.ts")
  expect(manifest.scripts["npm-package"]).toBe("bun run scripts/packaging/npm-package.ts")
})

test("package target arguments remain forwarded by the root command", () => {
  expect(manifest.scripts.package).toContain("package-target.ts")
  expect(manifest.scripts.package).not.toContain("--target")
})
