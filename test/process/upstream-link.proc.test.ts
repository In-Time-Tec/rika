import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import { expect, test } from "vitest"
import { packedTarballName, tarballDirectory, tarballPrefix } from "../../scripts/upstream/upstream-package-contract"
import { extractedDigest, packSibling } from "../../scripts/upstream/upstream-sibling-pack"
import { directoryDigest } from "../../scripts/upstream/upstream-content-digest"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

const sibling = async (directory: string, marker: string) => {
  await mkdir(join(directory, "dist"), { recursive: true })
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "@upstream-fixture/library", version: "1.2.3", main: "dist/library.js", files: ["dist"] }, undefined, 2)}\n`,
  )
  await writeFile(join(directory, "dist", "library.js"), `export const marker = "${marker}"\n`)
}

const pack = async (source: string, destination: string) => {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const packed = await run(packSibling(source, destination))
  expect(packed).toBeDefined()
  return packed!
}

const installedMarker = async (consumer: string) =>
  await readFile(join(consumer, "node_modules", "@upstream-fixture", "library", "dist", "library.js"), "utf8")

const install = async (consumer: string, specifier: string) => {
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "upstream-fixture-consumer", version: "0.0.0", dependencies: { "@upstream-fixture/library": specifier } }, undefined, 2)}\n`,
  )
  const child = Bun.spawn(["bun", "install"], { cwd: consumer, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`bun install failed\n${stderr}`)
}

test("re-linking a rebuilt sibling installs the rebuilt content instead of the previously cached copy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rika-upstream-link-"))
  try {
    const source = join(workspace, "sibling")
    const consumer = join(workspace, "consumer")
    const artifacts = join(consumer, tarballDirectory)
    const staging = join(workspace, "staging")
    await mkdir(artifacts, { recursive: true })
    await sibling(source, "BEFORE_REBUILD")

    const first = await pack(source, staging)
    expect(first.name.startsWith(tarballPrefix("@upstream-fixture/library"))).toBe(true)
    const firstName = packedTarballName(first)
    await Bun.write(join(artifacts, firstName), Bun.file(first.file))
    await install(consumer, `file:${tarballDirectory}/${firstName}`)
    expect(await installedMarker(consumer)).toContain("BEFORE_REBUILD")

    await sibling(source, "AFTER_REBUILD")
    const second = await pack(source, staging)
    const secondName = packedTarballName(second)
    expect(secondName).not.toBe(firstName)

    // The defect: Bun keys its install cache on the tarball path, so reinstalling the rebuilt
    // sibling under the previous name replays the previous extraction.
    await Bun.write(join(artifacts, firstName), Bun.file(second.file))
    await install(consumer, `file:${tarballDirectory}/${firstName}`)
    expect(await installedMarker(consumer)).toContain("BEFORE_REBUILD")

    await Bun.write(join(artifacts, secondName), Bun.file(second.file))
    await install(consumer, `file:${tarballDirectory}/${secondName}`)
    expect(await installedMarker(consumer)).toContain("AFTER_REBUILD")

    const packedDigest = await run(extractedDigest(join(artifacts, secondName), staging))
    const installed = await run(directoryDigest(join(consumer, "node_modules", "@upstream-fixture", "library")))
    expect(installed).toBe(packedDigest)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("a content digest separates rebuilt bytes from an unchanged tree at identical file paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rika-upstream-digest-"))
  try {
    const tree = join(workspace, "tree")
    await sibling(tree, "BEFORE_REBUILD")
    const before = await run(directoryDigest(tree))
    expect(await run(directoryDigest(tree))).toBe(before)

    // Same file paths, different bytes: this is exactly the stale install the status gate must see.
    await writeFile(join(tree, "dist", "library.js"), `export const marker = "AFTER_REBUILD"\n`)
    expect(await run(directoryDigest(tree))).not.toBe(before)

    await writeFile(join(tree, "dist", "library.js"), `export const marker = "BEFORE_REBUILD"\n`)
    expect(await run(directoryDigest(tree))).toBe(before)

    await writeFile(join(tree, "dist", "extra.js"), "export const extra = 1\n")
    expect(await run(directoryDigest(tree))).not.toBe(before)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("packing an unchanged sibling twice keeps the same name so re-linking is idempotent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rika-upstream-pack-"))
  try {
    const source = join(workspace, "sibling")
    await sibling(source, "STABLE")
    const first = await pack(source, join(workspace, "first"))
    const second = await pack(source, join(workspace, "second"))
    expect(packedTarballName(second)).toBe(packedTarballName(first))

    await sibling(source, "CHANGED")
    const third = await pack(source, join(workspace, "third"))
    expect(packedTarballName(third)).not.toBe(packedTarballName(first))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
