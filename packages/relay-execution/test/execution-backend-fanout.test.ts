import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"
import { expect, it } from "@effect/vitest"

import { Effect, Ref } from "effect"

import * as ExecutionBackend from "@rika/product/execution-service"

import { createFanOut, start } from "./current-execution-route"

import { fixture as testSupport } from "./execution-backend-fixture"
const { routeFor, selection, relayEvent, makeClient, provideConfiguredBackend } = testSupport
it.effect("durably carries workspace, route, token budget, and compaction through fan-out", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    const fanOutInputs: Array<any> = []
    Object.assign(fixture.implementation.childRuns, {
      createFanOut: (input: any) => {
        fanOutInputs.push(input)
        return Effect.succeed({
          fan_out_id: input.fan_out_id,
          parent_execution_id: input.parent_execution_id,
          state: "running",
          max_concurrency: input.max_concurrency,
          join: input.join,
          members: [],
        })
      },
    })
    const oracleSelection = {
      provider: "oracle-provider",
      model: "oracle-model",
      registrationKey: "sol:high:normal",
    }
    const summarySelection = {
      provider: "summary-provider",
      model: "summary-model",
      registrationKey: "terra:low:normal",
    }
    const mainCompaction = { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 }
    const oracleCompaction = { contextWindow: 1_000_000, reserveTokens: 128_000, keepRecentTokens: 64_000 }
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const route = {
        version: 1 as const,
        mode: "test" as const,
        compactionSummary: routeFor("compaction", summarySelection, mainCompaction),
        main: routeFor("main", selection, mainCompaction),
        oracle: routeFor("oracle", oracleSelection, oracleCompaction),
        agents: {
          librarian: routeFor("librarian", selection, mainCompaction),
          painter: routeFor("painter", selection, mainCompaction),
          review: routeFor("review", selection, mainCompaction),
          readThread: routeFor("readThread", selection, mainCompaction),
          surgeon: routeFor("surgeon", selection, mainCompaction),
          task: routeFor("task", selection, mainCompaction),
        },
      }
      yield* start(backend, {
        threadId: "thread",
        turnId: "other-turn",
        prompt: "prompt",
        executionRoute: route,
      })
      yield* createFanOut(backend, {
        fanOutId: "fan",
        parentTurnId: "turn",
        workspace: "/client/workspace",
        executionRoute: route,
        children: [
          { childId: "oracle", profile: "Oracle", prompt: "inspect" },
          { childId: "task", profile: "Task", prompt: "work" },
        ],
        maxConcurrency: 2,
        join: "all",
        createdAt: 2,
      })
    }).pipe(
      provideConfiguredBackend(fixture.implementation, {
        selection,
        oracleSelection,
        compaction: mainCompaction,
        oracleCompaction,
        additionalToolkit: ThreadToolkits.ThreadContract.allToolkit,
        resolveWorkspace: (execution) => Effect.succeed(execution.includes("other-turn") ? "/configured" : "/plain"),
      }),
    )
    const registered = (yield* Ref.get(fixture.registrations)).at(-1) as any
    expect(registered.model).toEqual({
      provider: selection.provider,
      model: selection.model,
      registration_key: "default",
    })
    expect(registered.compaction_policy).toEqual({
      context_window: 372_000,
      reserve_tokens: 128_000,
      keep_recent_tokens: 32_000,
      summary_model: {
        provider: "summary-provider",
        model: "summary-model",
        registration_key: "terra:low:normal",
      },
    })
    expect(registered.child_run_presets["Task:1"]).toMatchObject({
      model: {
        provider: selection.provider,
        model: selection.model,
        registration_key: "default",
        metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      },
      metadata: { product_profile: "Task", rika_agent_depth: 1, rika_reasoning_effort: "medium" },
    })
    expect(registered.child_run_presets["Task:1"].tool_names).toContain("web_search")
    const rootToolNames = registered.tools.map((tool: { readonly name: string }) => tool.name)
    expect(rootToolNames).toEqual(
      expect.arrayContaining(["find_thread", "create_thread", "thread_interact", "wait_for_threads"]),
    )
    expect(rootToolNames).not.toContain("search_threads")
    expect(rootToolNames).not.toContain("read_thread_transcript")
    expect(registered.permissions).toEqual(
      expect.arrayContaining([
        { name: "thread.read", value: true },
        { name: "thread.coordinate", value: true },
        { name: "thread.control", value: true },
      ]),
    )
    expect(registered.child_run_presets["ReadThread:1"]).toMatchObject({
      permissions: ["thread.read"],
      tool_names: ["search_threads", "read_thread_transcript"],
    })
    expect(registered.child_run_presets["Oracle:1"]).toMatchObject({
      model: {
        provider: oracleSelection.provider,
        model: oracleSelection.model,
        registration_key: oracleSelection.registrationKey,
        metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      },
    })
    const oraclePolicy = {
      context_window: 1_000_000,
      reserve_tokens: 128_000,
      keep_recent_tokens: 64_000,
      summary_model: {
        provider: "summary-provider",
        model: "summary-model",
        registration_key: "terra:low:normal",
      },
    }
    expect(fanOutInputs[0].children[0].override.model).toMatchObject({
      provider: oracleSelection.provider,
      model: oracleSelection.model,
      registration_key: oracleSelection.registrationKey,
      metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
    })
    expect(fanOutInputs[0].children[0].override.compaction_policy).toEqual(oraclePolicy)
    expect(fanOutInputs[0].children[0].override.tool_names).toContain("web_search")
    expect(fanOutInputs[0].children[0].override.tool_names).not.toContain("read_web_page")
    expect(fanOutInputs[0].children[1].override.model).toMatchObject({
      provider: selection.provider,
      model: selection.model,
      registration_key: "default",
      metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
    })
    expect(fanOutInputs[0].children[1].override.compaction_policy).toEqual(registered.compaction_policy)
    expect(fanOutInputs[0].children[0].metadata).toMatchObject({
      rika_workspace: "/client/workspace",
    })
    expect(fanOutInputs[0].children[0].metadata.rika_execution_route).toEqual({
      version: 1,
      mode: "test",
      compactionSummary: routeFor("compaction", summarySelection, mainCompaction),
      main: routeFor("main", selection, mainCompaction),
      oracle: routeFor("oracle", oracleSelection, oracleCompaction),
      agents: {
        librarian: routeFor("librarian", selection, mainCompaction),
        painter: routeFor("painter", selection, mainCompaction),
        review: routeFor("review", selection, mainCompaction),
        readThread: routeFor("readThread", selection, mainCompaction),
        surgeon: routeFor("surgeon", selection, mainCompaction),
        task: routeFor("task", selection, mainCompaction),
      },
    })
  }),
)
it.effect("keeps Surgeon on the main route when Agent routes are omitted in fixed-selection mode", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient()
    const fanOutInputs: Array<any> = []
    Object.assign(fixture.implementation.childRuns, {
      createFanOut: (input: any) => {
        fanOutInputs.push(input)
        return Effect.succeed({
          fan_out_id: input.fan_out_id,
          parent_execution_id: input.parent_execution_id,
          state: "running",
          max_concurrency: input.max_concurrency,
          join: input.join,
          members: [],
        })
      },
    })
    const mainSelection = { provider: "main-provider", model: "main-model" }
    const oracleSelection = { provider: "oracle-provider", model: "oracle-model" }
    const mainCompaction = { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 }
    const oracleCompaction = { contextWindow: 1_000_000, reserveTokens: 128_000, keepRecentTokens: 64_000 }
    const route = {
      version: 1 as const,
      mode: "test" as const,
      main: routeFor("main", mainSelection, mainCompaction),
      oracle: routeFor("oracle", oracleSelection, oracleCompaction),
    }

    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      yield* createFanOut(backend, {
        fanOutId: "surgeon-route",
        parentTurnId: "turn",
        executionRoute: route,
        children: [
          { childId: "surgeon", profile: "Surgeon", prompt: "diagnose" },
          { childId: "oracle", profile: "Oracle", prompt: "review" },
        ],
        maxConcurrency: 2,
        join: "all",
        createdAt: 2,
      })
    }).pipe(
      provideConfiguredBackend(fixture.implementation, {
        selection: mainSelection,
        oracleSelection,
        modelVariantPolicy: "fixed-selection",
        compaction: mainCompaction,
        oracleCompaction,
      }),
    )

    expect(fanOutInputs[0].children[0].override).toMatchObject({
      model: { provider: "main-provider", model: "main-model" },
      compaction_policy: {
        context_window: mainCompaction.contextWindow,
        reserve_tokens: mainCompaction.reserveTokens,
        keep_recent_tokens: mainCompaction.keepRecentTokens,
      },
    })
    expect(fanOutInputs[0].children[1].override).toMatchObject({
      model: { provider: "oracle-provider", model: "oracle-model" },
      compaction_policy: {
        context_window: oracleCompaction.contextWindow,
        reserve_tokens: oracleCompaction.reserveTokens,
        keep_recent_tokens: oracleCompaction.keepRecentTokens,
      },
    })
  }),
)
