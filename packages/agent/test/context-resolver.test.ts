import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "@rika/core"
import { Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { ContextResolver, ThreadService } from "../src/index"

const threadId = Ids.ThreadId.make("thread_context")
const turnId = Ids.TurnId.make("turn_context")

const tempWorkspace = () => mkdtemp(join(tmpdir(), "rika-context-"))

const configLayer = (workspaceRoot: string) =>
  Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: join(workspaceRoot, ".rika"),
    default_mode: "smart",
  })

const run = <A, E>(workspaceRoot: string, effect: Effect.Effect<A, E, ContextResolver.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ContextResolver.layer),
      Effect.provide(
        Layer.mergeAll(
          configLayer(workspaceRoot),
          ThreadService.fakeLayer({
            reference: (input) =>
              Effect.succeed({
                thread_id: input.thread_id,
                rendered: `Referenced ${input.thread_id}`,
                entries: [`Referenced ${input.thread_id}`],
                total_chars: `Referenced ${input.thread_id}`.length,
                truncated: false,
              }),
          }),
        ),
      ),
    ),
  )

describe("ContextResolver", () => {
  test("loads workspace AGENTS.md, mentioned files, images, and thread references", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "AGENTS.md"), "Use Bun tests.\n")
    await writeFile(join(root, "README.md"), "# Rika\n")
    await writeFile(join(root, "screenshot.png"), new Uint8Array([137, 80, 78, 71]))

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Read @README.md and inspect @screenshot.png like @T-12345678-1234-1234-1234-123456789abc",
      }),
    )
    const entries = workspaceEntries(context)

    expect(entries.map((entry) => entry.kind)).toEqual(["guidance", "file", "image", "thread-reference"])
    expect(entries[0]).toMatchObject({ kind: "guidance", path: "AGENTS.md", content: "Use Bun tests.\n" })
    expect(entries[1]).toMatchObject({ kind: "file", path: "README.md", content: "# Rika\n" })
    expect(entries[2]).toMatchObject({ kind: "image", path: "screenshot.png", media_type: "image/png" })
    expect(entries[3]).toMatchObject({
      kind: "thread-reference",
      thread_reference: "T-12345678-1234-1234-1234-123456789abc",
      content: "Referenced T-12345678-1234-1234-1234-123456789abc",
    })
    expect(context.rendered).toContain("untrusted-workspace-and-user-content")
  })

  test("resolves Rika-generated thread ids as thread references", async () => {
    const root = await tempWorkspace()

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Continue from @thread_context and /threads/thread_context.",
      }),
    )

    expect(context.entries).toContainEqual(
      expect.objectContaining({
        kind: "thread-reference",
        thread_reference: "thread_context",
        content: "Referenced thread_context",
      }),
    )
  })

  test("does not parse thread-looking file mentions as thread references", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "thread_context.ts"), "export const threadContext = true\n")
    await mkdir(join(root, "thread_context"), { recursive: true })
    await writeFile(join(root, "thread_context", "file.ts"), "export const file = true\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Read @thread_context.ts and @thread_context/file.ts",
      }),
    )

    expect(context.entries.filter((entry) => entry.kind === "thread-reference")).toEqual([])
    expect(workspaceEntries(context).filter((entry) => entry.kind === "file")).toHaveLength(2)
  })

  test("uses AGENT.md or CLAUDE.md fallback when AGENTS.md is absent", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "AGENT.md"), "Fallback singular guidance.\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({ thread_id: threadId, turn_id: turnId, content: "hello" }),
    )

    expect(workspaceEntries(context)).toHaveLength(1)
    expect(workspaceEntries(context)[0]).toMatchObject({ kind: "guidance", path: "AGENT.md" })
  })

  test("includes subtree guidance only after a relevant file is mentioned", async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, "packages", "api", "src"), { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "Root guidance.\n")
    await writeFile(join(root, "packages", "api", "AGENTS.md"), "API guidance.\n")
    await writeFile(join(root, "packages", "api", "src", "handler.ts"), "export const handler = 1\n")

    const withoutMention = await run(
      root,
      ContextResolver.resolveContext({ thread_id: threadId, turn_id: turnId, content: "hello" }),
    )
    const withMention = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Read @packages/api/src/handler.ts",
      }),
    )

    expect(workspaceEntries(withoutMention).map((entry) => entry.path)).toEqual(["AGENTS.md"])
    expect(workspaceEntries(withMention).map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "packages/api/src/handler.ts",
    ])
  })

  test("applies frontmatter globs on AGENTS-mentioned guidance files", async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, "docs"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "See @docs/typescript.md and @docs/ruby.md\n")
    await writeFile(join(root, "docs", "typescript.md"), "---\nglobs:\n  - '**/*.ts'\n---\nUse TypeScript rules.\n")
    await writeFile(join(root, "docs", "ruby.md"), "---\nglobs:\n  - '**/*.rb'\n---\nUse Ruby rules.\n")
    await writeFile(join(root, "src", "main.ts"), "export const main = true\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({ thread_id: threadId, turn_id: turnId, content: "Open @src/main.ts" }),
    )

    expect(workspaceEntries(context).map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "docs/typescript.md",
      "src/main.ts",
    ])
    expect(context.rendered).toContain("Use TypeScript rules")
    expect(context.rendered).not.toContain("Use Ruby rules")
  })

  test("ignores @mentions inside code blocks", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "README.md"), "# hidden\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "```\n@README.md\n```",
      }),
    )

    expect(context.entries.filter((entry) => entry.kind !== "guidance")).toHaveLength(0)
  })
})

const workspaceEntries = (context: ContextResolver.ResolvedContext) =>
  context.entries.filter((entry) => entry.path === undefined || !entry.path.startsWith("/"))
