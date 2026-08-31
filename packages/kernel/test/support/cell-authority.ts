import { Approvals, NestedOperation, Session, ToolContext } from "generalist"
import { Store } from "generalist/instructions"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { GoalService } from "@rika/product/goal-service"
import * as ThreadQuery from "@rika/product/thread-query-service"
import { Context, Effect, Layer } from "effect"
import { ArtifactStore } from "../../src/binding/artifact/store"
import * as ExecutorRuntime from "../../src/executor-runtime"

const authority = (toolContext: ToolContext.Service) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = Context.get(yield* Layer.build(Store.layerMemory), Store.Store)
      const sessions = Context.get(yield* Layer.build(Session.layerMemory), Session.SessionDirectory)
      return Context.make(
        CodingToolRuntime.Service,
        CodingToolRuntime.Service.of({ run: () => Effect.die("unused") }),
      ).pipe(
        Context.add(
          ShellProcessRegistry.Service,
          ShellProcessRegistry.Service.of({
            start: () => Effect.die("unused"),
            poll: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
          }),
        ),
        Context.add(ThreadQuery.Factory, ThreadQuery.Factory.of({ forWorkspace: () => Effect.die("unused") })),
        Context.add(
          McpRuntime.McpRuntimeService,
          McpRuntime.McpRuntimeService.of({ connect: () => Effect.die("unused") }),
        ),
        Context.add(Store.Store, harness),
        Context.add(Session.SessionDirectory, sessions),
        Context.add(
          GoalService,
          GoalService.of({
            get: () => Effect.die("unused"),
            create: () => Effect.die("unused"),
            complete: () => Effect.die("unused"),
            recordTurn: () => Effect.die("unused"),
            continuation: () => Effect.die("unused"),
          }),
        ),
        Context.add(
          ArtifactStore,
          ArtifactStore.of({ put: () => Effect.die("unused"), get: () => Effect.die("unused") }),
        ),
        Context.add(NestedOperation.Operations, NestedOperation.Operations.of({ run: (_request, effect) => effect })),
        Context.add(ToolContext.ToolContext, toolContext),
        Context.add(Approvals.Approvals, Approvals.Approvals.of({ resolve: (pending) => Effect.succeed(pending) })),
      )
    }),
  )

const defaultToolContext = Effect.map(Effect.abortSignal, (signal) =>
  ToolContext.ToolContext.of({
    signal,
    emit: () => Effect.succeed(true),
    sessionId: "fixture-session",
    runId: "fixture-run",
    toolCallId: "fixture-call",
    operationKey: "fixture-operation",
  }),
)

export const context = (
  toolContext: ToolContext.Service,
): Effect.Effect<Context.Context<ExecutorRuntime.CellServices>> => authority(toolContext)

export const capture = (
  overrides: Context.Context<never> = Context.empty(),
): Effect.Effect<Context.Context<ExecutorRuntime.CellServices>> =>
  Effect.scoped(
    Effect.flatMap(defaultToolContext, authority).pipe(Effect.map((services) => Context.merge(services, overrides))),
  )
