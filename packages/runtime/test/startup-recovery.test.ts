import { Agent, type Client, PromptAssembler, Tool } from "@relayfx/sdk"
import { expect, test } from "vitest"
import { Effect, Layer, Schema } from "effect"
import * as StartupRecovery from "../src/startup-recovery"

const decodeAgent = Schema.decodeUnknownSync(Agent.Definition)
const decodeTool = Schema.decodeUnknownSync(Tool.Definition)

const agent = (metadata?: Record<string, string>) =>
  decodeAgent({
    name: "rika-turn-recovery",
    instructions: "Follow the pinned instructions.",
    model: { provider: "test", model: "test", metadata: { rika_agent_depth: 0 } },
    tool_names: ["alpha", "beta"],
    permissions: [],
    child_run_presets: {},
    ...(metadata === undefined ? {} : { metadata }),
  })

const tool = (name: string, description: string) =>
  decodeTool({
    name,
    description,
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    permissions: [{ name: `${name}.run`, value: true }],
  })

const tools = [tool("beta", "Second tool."), tool("alpha", "First tool.")]

const stubClient = (events: ReadonlyArray<{ readonly type: string }>) =>
  Effect.succeed({
    executions: { replay: () => Effect.succeed({ events }) },
  } as unknown as Client.Interface)

const assemble = (client: Effect.Effect<Client.Interface>, input: PromptAssembler.AssembleInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(StartupRecovery.assemblerLayer(client))
      return yield* PromptAssembler.assemble(input).pipe(Effect.provide(context))
    }),
  )

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.orDie(effect))

test("startup replay detection requires a duplicate startup and started work", () => {
  const started = { type: "execution.started" }
  const prepared = { type: "model.input.prepared" }
  const toolCall = { type: "tool.call.requested" }
  const spawned = { type: "child_run.spawned" }
  expect(StartupRecovery.unsafeStartupReplay([started, prepared, toolCall, spawned])).toBe(false)
  expect(StartupRecovery.unsafeStartupReplay([started, prepared, started, prepared])).toBe(false)
  expect(StartupRecovery.unsafeStartupReplay([started, prepared, toolCall, spawned, started, prepared])).toBe(true)
  expect(StartupRecovery.unsafeStartupReplay([started, spawned, started])).toBe(true)
})

test("context baseline assembly is byte-identical across runtime instances and tool orderings", () =>
  run(
    Effect.gen(function* () {
      const input = { agent: agent(), tools, input: [{ type: "text" as const, text: "hello" }] }
      const shuffled = { ...input, tools: [...tools].toReversed() }
      const redescribed = {
        ...input,
        tools: [tool("beta", "Second tool, rewritten in a newer resident."), tool("alpha", "First tool, rewritten.")],
      }
      const first = yield* assemble(stubClient([]), input)
      const second = yield* assemble(stubClient([]), shuffled)
      const third = yield* assemble(stubClient([]), redescribed)
      expect(second.system).toBe(first.system)
      expect(third.system).toBe(first.system)
      expect(StartupRecovery.baselineDigest(second.system)).toBe(StartupRecovery.baselineDigest(first.system))
      expect(first.system).toContain("Agent: rika-turn-recovery")
      expect(first.system).toContain("Follow the pinned instructions.")
      expect(first.system.indexOf('"alpha"')).toBeLessThan(first.system.indexOf('"beta"'))
    }),
  ))

test("assembly without a pinned execution id skips the replay guard", () =>
  run(
    Effect.gen(function* () {
      const failing = Effect.succeed({
        executions: { replay: () => Effect.die(new Error("replay must not be called")) },
      } as unknown as Client.Interface)
      const assembled = yield* assemble(failing, {
        agent: agent(),
        tools,
        input: [{ type: "text" as const, text: "hello" }],
      })
      expect(assembled.system.length).toBeGreaterThan(0)
    }),
  ))

test("recovery before the first checkpoint with started work fails instead of replaying startup", () =>
  run(
    Effect.gen(function* () {
      const pinned = agent({ rika_execution_id: "execution:turn-guard" })
      const replayed = [
        { type: "execution.started" },
        { type: "model.input.prepared" },
        { type: "tool.call.requested" },
        { type: "child_run.spawned" },
        { type: "execution.started" },
        { type: "model.input.prepared" },
      ]
      const outcome = yield* assemble(stubClient(replayed), {
        agent: pinned,
        tools,
        input: [{ type: "text" as const, text: "hello" }],
      }).pipe(Effect.flip)
      expect(outcome).toBeInstanceOf(PromptAssembler.PromptAssemblerError)
      expect(outcome.message).toContain("execution:turn-guard")
      expect(outcome.message).toContain("recovered before its first durable checkpoint")
    }),
  ))

test("a fresh startup with started work in the same attempt is not rejected", () =>
  run(
    Effect.gen(function* () {
      const pinned = agent({ rika_execution_id: "execution:turn-fresh" })
      const fresh = [{ type: "execution.started" }, { type: "model.input.prepared" }, { type: "tool.call.requested" }]
      const assembled = yield* assemble(stubClient(fresh), {
        agent: pinned,
        tools,
        input: [{ type: "text" as const, text: "hello" }],
      })
      expect(assembled.system.length).toBeGreaterThan(0)
    }),
  ))
