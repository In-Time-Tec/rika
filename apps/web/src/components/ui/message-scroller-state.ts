import { Effect, Function, Match, Option, Queue, Schema, Stream } from "effect"
import * as Command from "foldkit/command"
import * as Mount from "foldkit/mount"
import { m } from "foldkit/message"
import { evo } from "foldkit/struct"

export const Model = Schema.Struct({
  id: Schema.String,
  isFollowing: Schema.Boolean,
  isAtBottom: Schema.Boolean,
})

export type Model = typeof Model.Type

export type InitConfig = Readonly<{
  id: string
}>

export const init = (config: InitConfig): Model => ({
  id: config.id,
  isFollowing: true,
  isAtBottom: true,
})

export const viewportId = (model: Model): string => `${model.id}-viewport`

export const ScrolledViewport = m("ScrolledViewport", { isAtBottom: Schema.Boolean })
export const GrewContent = m("GrewContent")
export const ClickedScrollToBottom = m("ClickedScrollToBottom")
export const CompletedScrollToBottom = m("CompletedScrollToBottom")

export const Message = Schema.Union([ScrolledViewport, GrewContent, ClickedScrollToBottom, CompletedScrollToBottom])

export type Message = typeof Message.Type

export const ScrollToBottom = Command.define(
  "ScrollToBottom",
  { viewportId: Schema.String, behavior: Schema.Literals(["smooth", "instant"]) },
  CompletedScrollToBottom,
)(({ behavior, viewportId: targetId }) =>
  Effect.sync(() => {
    Option.match(Option.fromNullishOr(document.getElementById(targetId)), {
      onNone: Function.constVoid,
      onSome: (viewport) => viewport.scrollTo({ top: viewport.scrollHeight, behavior }),
    })
    return CompletedScrollToBottom()
  }),
)

const AT_BOTTOM_THRESHOLD = 8

const isScrolledToBottom = (element: Element): boolean =>
  element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_THRESHOLD

export const TrackViewportScroll = Mount.defineStream(
  "TrackViewportScroll",
  ScrolledViewport,
)((element) =>
  Stream.callback<typeof ScrolledViewport.Type>((queue) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let wasAtBottom = isScrolledToBottom(element)
          Queue.offerUnsafe(queue, ScrolledViewport({ isAtBottom: wasAtBottom }))
          const handleScroll = () => {
            const isAtBottom = isScrolledToBottom(element)
            if (isAtBottom !== wasAtBottom) {
              wasAtBottom = isAtBottom
              Queue.offerUnsafe(queue, ScrolledViewport({ isAtBottom }))
            }
          }
          element.addEventListener("scroll", handleScroll, { passive: true })
          return handleScroll
        }),
        (handleScroll) => Effect.sync(() => element.removeEventListener("scroll", handleScroll)),
      )
      return yield* Effect.never
    }),
  ),
)

export const ObserveContentGrowth = Mount.defineStream(
  "ObserveContentGrowth",
  GrewContent,
)((element) =>
  Stream.callback<typeof GrewContent.Type>((queue) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let lastHeight = 0
          const observer = new ResizeObserver(() => {
            const height = element.getBoundingClientRect().height
            if (height > lastHeight) {
              Queue.offerUnsafe(queue, GrewContent())
            }
            lastHeight = height
          })
          observer.observe(element)
          return observer
        }),
        (observer) => Effect.sync(() => observer.disconnect()),
      )
      return yield* Effect.never
    }),
  ),
)

export type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>]

const withUpdateReturn = Match.withReturnType<UpdateReturn>()

export const update = (model: Model, message: Message): UpdateReturn =>
  Match.value(message).pipe(
    withUpdateReturn,
    Match.tagsExhaustive({
      ScrolledViewport: ({ isAtBottom }) => [
        evo(model, { isAtBottom: () => isAtBottom, isFollowing: () => isAtBottom }),
        [],
      ],
      GrewContent: () =>
        model.isFollowing && model.isAtBottom
          ? [model, [ScrollToBottom({ behavior: "instant", viewportId: viewportId(model) })]]
          : [model, []],
      ClickedScrollToBottom: () =>
        model.isAtBottom
          ? [model, []]
          : [
              evo(model, { isFollowing: () => true }),
              [ScrollToBottom({ behavior: "smooth", viewportId: viewportId(model) })],
            ],
      CompletedScrollToBottom: () => [model, []],
    }),
  )
