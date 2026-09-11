import { BunCrypto } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Agent, Approvals, Permissions, ToolContext } from "generalist"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { Host } from "generalist/host"
import { ExecutableResolver, LocalScheduler, RunStore } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"
import { WorkspaceBinding, workspaceComponentLayer } from "@rika/execution"
import { bash } from "@rika/execution/tools"
import { layer as runnerLayer } from "../src/workspace"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "cancellation-workspace",
  assignmentId: "cancellation-assignment",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "cancellation-workspace", checkoutFingerprint: "cancellation-checkout" },
  buildId: "cancellation-build",
  protocolVersion: 1,
})

const toolkit = Toolkit.make(bash)
const agent = Agent.make({
  name: "runner-cancellation",
  input: Schema.String,
  output: Schema.String,
  instructions: "Start the requested Bash command.",
  toolkit,
  toolExecution: "background",
})

it.live(
  "zero-wait Bash remains running through completion and cancellation cleans descendants before acknowledgement",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const runtime = durabilityLayer({
        environment: "cancellation-test",
        tenant: "owner",
        partition: "thread-cancellation",
        maxStateBytes: 64 * 1024 * 1024,
        addresses: [],
      }).pipe(
        Layer.provide(ExecutableResolver.layerStatic([])),
        Layer.provide(DurabilityTesting.layer(bucket)),
        Layer.provide(BunCrypto.layer),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "rika-cancellation-" })
          yield* fs.writeFileString(
            `${checkout}/tree.py`,
            [
              "import json, os, pathlib, subprocess",
              "child = subprocess.Popen(['python3', '-c', 'import time; time.sleep(60)'])",
              "pathlib.Path('owned-pids.json').write_text(json.dumps([os.getpid(), child.pid]))",
              "child.wait()",
            ].join("\n"),
          )
          const host = yield* Host.make({
            agents: { [agent.name]: agent },
            revision: "cancellation-test",
            tools: [bash],
          }).pipe(
            Effect.provide(
              yield* Layer.build(
                Layer.mergeAll(
                  TestModel.layer([
                    TestModel.turn([
                      TestModel.toolCall("bash", { command: "sh finite.sh", timeout_ms: 0 }, { id: "finite" }),
                    ]),
                    TestModel.turn([TestModel.text("finite-started")]),
                    TestModel.turn([
                      TestModel.toolCall("bash", { command: "python3 tree.py", timeout_ms: 0 }, { id: "tree" }),
                    ]),
                    TestModel.turn([TestModel.text("started")]),
                  ]),
                  Permissions.layerAllowAll,
                  Approvals.layerAutoApprove,
                  workspaceComponentLayer,
                  runnerLayer({ checkout, binding }),
                  toolkit.toLayer({ bash: () => Effect.die("Bash bypassed the Runner ToolExecutor") }),
                ).pipe(Layer.provide(ToolContext.layerDefault)),
              ),
            ),
          )
          yield* activate
          const session = yield* host.sessions.create({ id: "session:cancellation", agent: agent.name })
          const scheduler = yield* LocalScheduler.LocalScheduler
          yield* fs.writeFileString(
            `${checkout}/finite.sh`,
            "printf before\nprintf started > finite-state.txt\nwhile [ ! -f release-finite ]; do sleep 0.01; done\nprintf finished >> finite-state.txt\nprintf after\n",
          )
          const finiteParent = yield* host.runs.start(session.id, agent, "start finite command")
          yield* scheduler.drain({ fuel: 32 })
          expect(yield* finiteParent.await.pipe(Effect.timeout("5 seconds"))).toBe("finite-started")
          const finiteChildren = yield* host.runs.children(finiteParent.id)
          expect(finiteChildren).toHaveLength(1)
          const finiteChild = finiteChildren[0]!
          yield* Effect.gen(function* () {
            while (!(yield* fs.exists(`${checkout}/finite-state.txt`))) yield* Effect.sleep("10 millis")
          }).pipe(Effect.timeout("5 seconds"))
          expect(yield* fs.readFileString(`${checkout}/finite-state.txt`)).toBe("started")
          expect((yield* host.runs.inspect(finiteChild.childRunId)).status).toBe("running")
          const finiteTool = yield* host.tools.get(bash, finiteChild.childRunId)
          expect((yield* Effect.result(finiteTool.await.pipe(Effect.timeout("25 millis"))))._tag).toBe("Failure")
          yield* fs.writeFileString(`${checkout}/release-finite`, "release\n")
          expect(yield* finiteTool.await.pipe(Effect.timeout("5 seconds"))).toMatchObject({
            text: "beforeafter",
            exitCode: 0,
            running: false,
          })
          expect((yield* host.runs.inspect(finiteChild.childRunId)).status).toBe("succeeded")
          expect(yield* fs.readFileString(`${checkout}/finite-state.txt`)).toBe("startedfinished")

          const parent = yield* host.runs.start(session.id, agent, "start owned process tree")
          yield* scheduler.drain({ fuel: 32 })
          expect(yield* parent.await.pipe(Effect.timeout("5 seconds"))).toBe("started")
          const children = yield* host.runs.children(parent.id)
          expect(children).toHaveLength(1)
          const child = children[0]!
          yield* Effect.gen(function* () {
            while (!(yield* fs.exists(`${checkout}/owned-pids.json`))) yield* Effect.sleep("10 millis")
          }).pipe(Effect.timeout("5 seconds"))
          const pids = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Int)))(
            yield* fs.readFileString(`${checkout}/owned-pids.json`),
          )
          expect(pids).toHaveLength(2)
          const observe = spawner.string(ChildProcess.make("ps", ["-p", pids.join(","), "-o", "pid="]))
          for (const pid of pids) expect(yield* observe).toContain(String(pid))
          expect((yield* host.runs.inspect(child.childRunId)).status).toBe("running")
          yield* host.runs.cancel(child.childRunId, "cancel-owned-tree")
          yield* scheduler.drain({ fuel: 32 })
          const tool = yield* host.tools.get(bash, child.childRunId)
          expect((yield* Effect.result(tool.await.pipe(Effect.timeout("5 seconds"))))._tag).toBe("Failure")
          expect((yield* host.runs.inspect(child.childRunId)).status).toBe("cancelled")
          expect((yield* observe).trim()).toBe("")
          const store = yield* RunStore.RunStore
          const journal = yield* store.recoveryJournal(child.childRunId)
          expect(journal.operations.map((operation) => operation.status)).toEqual(["cancelled"])
          yield* host.runs.cancel(child.childRunId, "cancel-owned-tree")
          expect((yield* store.recoveryJournal(child.childRunId)).operations).toEqual(journal.operations)
        }).pipe(Effect.provide(yield* Layer.build(Layer.merge(runtime, BunServices.layer)))),
      )
    }),
  30_000,
)
