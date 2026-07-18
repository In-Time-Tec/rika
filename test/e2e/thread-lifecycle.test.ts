import { expect, test } from "vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { run, runTest, sandbox } from "./process"

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const ThreadsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      pinned: Schema.Boolean,
      labels: Schema.Array(Schema.String),
    }),
  ),
)

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
            const created = Schema.decodeUnknownSync(ThreadJson)((yield* run(context, ["threads", "new"])).stdout)
            yield* run(context, ["threads", "rename", created.id, "Durable thread"])
            yield* run(context, ["threads", "label", created.id, "local", "durable"])
            yield* run(context, ["threads", "pin", created.id])
            const listed = Schema.decodeUnknownSync(ThreadsJson)((yield* run(context, ["threads", "list"])).stdout)
            expect(listed).toHaveLength(1)
            expect(listed[0]!.title).toBe("Durable thread")
            expect(listed[0]!.pinned).toBe(true)
            yield* run(context, ["threads", "archive", created.id])
            expect(Schema.decodeUnknownSync(ThreadsJson)((yield* run(context, ["threads", "list"])).stdout)).toEqual([])
            const searched = Schema.decodeUnknownSync(ThreadsJson)(
              (yield* run(context, ["threads", "search", "durable", "--include-archived"])).stdout,
            )
            expect(searched[0]!.labels).toEqual(["local", "durable"])
            yield* run(context, ["threads", "unarchive", created.id])
            yield* run(context, ["threads", "delete", created.id])
            expect(
              Schema.decodeUnknownSync(ThreadsJson)(
                (yield* run(context, ["threads", "list", "--include-archived"])).stdout,
              ),
            ).toEqual([])
          }),
        (context) => context.dispose,
      ),
    ),
  30_000,
)
