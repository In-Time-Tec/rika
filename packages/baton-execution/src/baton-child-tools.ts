import { ToolExecutor } from "@batonfx/core"
import { ChildRuns } from "@batonfx/runtime"
import { Effect, Function, Layer, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

export const selections = {
  title: "Title",
  oracle: "Oracle",
  librarian: "Librarian",
  painter: "Painter",
  read_thread: "ReadThread",
  surgeon: "Surgeon",
  task: "Task",
} as const

type Name = keyof typeof selections
export type Selection = (typeof selections)[Name]

const prompt = Schema.Struct({ prompt: Schema.String })

const descriptions: Readonly<Record<Name, string>> = {
  title: "Run the Title agent and wait for its durable result.",
  oracle: "Run the Oracle agent for focused analysis and wait for its durable result.",
  librarian: "Run the Librarian agent for focused research and wait for its durable result.",
  painter: "Run the Painter agent for focused visual analysis and wait for its durable result.",
  read_thread: "Run the ReadThread agent for focused Thread retrieval and wait for its durable result.",
  surgeon: "Run the Surgeon agent for a bounded defect investigation and wait for its durable result.",
  task: "Run a Task agent for bounded workspace work and wait for its durable result.",
}

const declaration = <N extends Name>(name: N) =>
  Tool.make(name, {
    description: descriptions[name],
    parameters: prompt,
    success: ChildRuns.Result,
  })

export const tools = {
  title: declaration("title"),
  oracle: declaration("oracle"),
  librarian: declaration("librarian"),
  painter: declaration("painter"),
  read_thread: declaration("read_thread"),
  surgeon: declaration("surgeon"),
  task: declaration("task"),
} as const

export const rootSelections = ["Title", "Oracle", "Librarian", "Painter", "ReadThread", "Surgeon", "Task"] as const
export const taskSelections = ["Oracle", "Librarian", "Painter", "ReadThread", "Surgeon"] as const

export const selectionsForRole = (role: string): ReadonlyArray<Selection> => {
  if (role === "Root") return rootSelections
  if (role === "Task") return taskSelections
  return []
}

const nameForSelection = (selection: Selection): Name =>
  (Object.entries(selections) as Array<[Name, Selection]>).find(([, candidate]) => candidate === selection)![0]

const toolkitImpl = <Tools extends Record<string, Tool.Any>>(
  base: Toolkit.Toolkit<Tools>,
  allowed: ReadonlyArray<Selection>,
) => Toolkit.make(...Object.values(base.tools), ...allowed.map((selection) => tools[nameForSelection(selection)]))

export const toolkit: {
  (
    allowed: ReadonlyArray<Selection>,
  ): <Tools extends Record<string, Tool.Any>>(base: Toolkit.Toolkit<Tools>) => ReturnType<typeof toolkitImpl<Tools>>
  <Tools extends Record<string, Tool.Any>>(
    base: Toolkit.Toolkit<Tools>,
    allowed: ReadonlyArray<Selection>,
  ): ReturnType<typeof toolkitImpl<Tools>>
} = Function.dual(2, toolkitImpl)

const childParameters = (call: ToolExecutor.Request["call"], selection: Selection) => ({
  ...call,
  name: ChildRuns.tool.name,
  params: { ...(call.params as typeof prompt.Type), selection },
})

const hostRequired = (tool: string) =>
  ToolExecutor.FrameworkFailure.make({
    stage: "handler",
    tool,
    message: "child Agent tools require the Baton execution host",
  })

const handlerLayerImpl = <Tools extends Record<string, Tool.Any>>(
  base: Toolkit.Toolkit<Tools>,
  allowed: ReadonlyArray<Selection>,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>>,
): Layer.Layer<ToolExecutor.ToolExecutor> => {
  const allowedByName = new Map(allowed.map((selection) => [nameForSelection(selection), selection] as const))
  return Layer.effect(
    ToolExecutor.ToolExecutor,
    ToolExecutor.routeToolkit(base).pipe(
      Effect.map((baseRoute) =>
        ToolExecutor.ToolExecutor.of({
          execute: (request) => {
            const selection = allowedByName.get(request.call.name as Name)
            if (selection === undefined) return baseRoute.execute(request)
            return Effect.serviceOption(ChildRuns.ChildRuns).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => hostRequired(request.call.name),
                  onSome: (children) =>
                    ChildRuns.route
                      .execute({ ...request, call: childParameters(request.call, selection) })
                      .pipe(Effect.provideService(ChildRuns.ChildRuns, children)),
                }),
              ),
            )
          },
        }),
      ),
    ),
  ).pipe(Layer.provide(handlers))
}

export const handlerLayer: {
  <Tools extends Record<string, Tool.Any>>(
    allowed: ReadonlyArray<Selection>,
    handlers: Layer.Layer<Tool.HandlersFor<Tools>>,
  ): (base: Toolkit.Toolkit<Tools>) => Layer.Layer<ToolExecutor.ToolExecutor>
  <Tools extends Record<string, Tool.Any>>(
    base: Toolkit.Toolkit<Tools>,
    allowed: ReadonlyArray<Selection>,
    handlers: Layer.Layer<Tool.HandlersFor<Tools>>,
  ): Layer.Layer<ToolExecutor.ToolExecutor>
} = Function.dual(3, handlerLayerImpl)
