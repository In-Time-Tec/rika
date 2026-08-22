import { expect, test } from "vitest"

const manifest = (await Bun.file("package.json").json()) as {
  readonly scripts: Readonly<Record<string, string>>
}

test("root operational commands point directly at their owners", () => {
  expect(manifest.scripts.package).toBe("bun run scripts/packaging/package-target.ts")
  expect(manifest.scripts["npm-package"]).toBe("bun run scripts/packaging/npm-package.ts")
  expect(manifest.scripts["release-smoke"]).toBe("bun run scripts/release/release-smoke.ts")
  expect(manifest.scripts["install-local"]).toBe("bun run scripts/installation/install-local.ts")
  expect(manifest.scripts["uninstall-local"]).toBe("bun run scripts/installation/uninstall-local.ts")
})

test("package target arguments remain forwarded by the root command", () => {
  expect(manifest.scripts.package).toContain("package-target.ts")
  expect(manifest.scripts.package).not.toContain("--target")
})
