import { expect, test } from "vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { run, runTest, sandbox } from "./process"

const ThreadJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    pinned: Schema.Boolean,
    archived: Schema.Boolean,
    labels: Schema.Array(Schema.String),
  }),
)
const ThreadsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      pinned: Schema.Boolean,
      archived: Schema.Boolean,
      labels: Schema.Array(Schema.String),
    }),
  ),
)
const UsageJson = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    turns: Schema.Number,
    statuses: Schema.Record(Schema.String, Schema.Number),
  }),
)

const decodeThread = (stdout: string) => Schema.decodeUnknownSync(ThreadJson)(stdout)
const decodeThreads = (stdout: string) => Schema.decodeUnknownSync(ThreadsJson)(stdout)

test(
  "packaged thread lifecycle persists across processes",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const database = path.join(context.root, "nested", "rika.db")
            context.env.RIKA_DATABASE = database
            context.env.RIKA_RELAY_DATABASE = path.join(context.root, "nested", "relay.db")
            yield* run(context, ["--help"])
            expect(yield* fileSystem.exists(path.dirname(database))).toBe(false)
            const created = decodeThread((yield* run(context, ["threads", "create"])).stdout)
            const second = decodeThread((yield* run(context, ["threads", "create"])).stdout)
            yield* run(context, ["threads", "rename", created.id, "Durable thread"])
            const labeled = yield* run(context, ["threads", "label", created.id, "local", "durable", "local"])
            expect(decodeThread(labeled.stdout).labels).toEqual(["local", "durable"])
            yield* run(context, ["threads", "pin", created.id])
            const listed = decodeThreads((yield* run(context, ["threads", "list", "--limit", "1"])).stdout)
            expect(listed).toHaveLength(1)
            expect(listed[0]!.title).toBe("Durable thread")
            expect(listed[0]!.pinned).toBe(true)
            expect(decodeThreads((yield* run(context, ["threads", "list", "--limit", "200"])).stdout)).toHaveLength(2)
            expect(decodeThread((yield* run(context, ["last"])).stdout).id).toBe(created.id)
            expect(decodeThread((yield* run(context, ["top"])).stdout).id).toBe(created.id)
            expect((yield* run(context, ["threads", "continue", created.id])).exitCode).toBe(0)
            expect((yield* run(context, ["threads", "continue", "--last"])).exitCode).toBe(0)
            const usage = Schema.decodeUnknownSync(UsageJson)(
              (yield* run(context, ["threads", "usage", created.id])).stdout,
            )
            expect(usage).toMatchObject({ threadId: created.id, turns: 0 })
            expect(usage.statuses.completed).toBe(0)
            const jsonExport = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
              (yield* run(context, ["threads", "export", created.id])).stdout,
            )
            expect(jsonExport).toMatchObject({ thread: { id: created.id, title: "Durable thread" }, turns: [] })
            const markdown = yield* run(context, ["threads", "export", created.id, "--format", "markdown"])
            expect(markdown.stdout).toContain("# Durable thread")
            expect(markdown.stdout).toContain("- Labels: local, durable")
            const forked = decodeThread((yield* run(context, ["threads", "fork", created.id])).stdout)
            expect(forked.id).not.toBe(created.id)
            expect(
              decodeThreads((yield* run(context, ["threads", "search", "durable", "local", "--limit", "1"])).stdout),
            ).toHaveLength(1)
            yield* run(context, ["threads", "archive", created.id])
            expect(
              decodeThreads((yield* run(context, ["threads", "search", "durable"])).stdout).map((thread) => thread.id),
            ).toEqual([forked.id])
            const searched = decodeThreads(
              (yield* run(context, ["threads", "search", "durable", "--include-archived"])).stdout,
            )
            expect(searched[0]!.labels).toEqual(["local", "durable"])
            expect(searched[0]!.archived).toBe(true)
            yield* run(context, ["threads", "unarchive", created.id])
            yield* run(context, ["threads", "delete", created.id])
            expect(
              decodeThreads((yield* run(context, ["threads", "search", created.id, "--include-archived"])).stdout),
            ).toEqual([])
            expect(
              decodeThreads((yield* run(context, ["threads", "list", "--include-archived"])).stdout).map(
                (thread) => thread.id,
              ),
            ).toEqual([forked.id, second.id])
            for (const args of [
              ["threads", "rename", "missing", "No"],
              ["threads", "label", "missing", "no"],
              ["threads", "pin", "missing"],
              ["threads", "archive", "missing"],
              ["threads", "unarchive", "missing"],
              ["threads", "delete", "missing"],
              ["threads", "usage", "missing"],
              ["threads", "fork", "missing"],
              ["threads", "fork", second.id, "--at-turn", "missing"],
              ["threads", "export", "missing"],
            ]) {
              const missing = yield* run(context, args)
              expect(missing.exitCode, args.join(" ")).not.toBe(0)
              expect(`${missing.stdout}${missing.stderr}`, args.join(" ")).toMatch(/missing|does not exist/i)
            }
          }),
        (context) => context.dispose,
      ),
    ),
  30_000,
)
