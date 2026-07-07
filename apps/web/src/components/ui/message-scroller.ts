import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import * as Mount from "foldkit/mount"
import { button } from "./button"
import * as State from "./message-scroller-state"
import { cn } from "../../lib/cn"
import type { SlotConfig } from "./types"

export const Model = State.Model
export type Model = State.Model
export type InitConfig = State.InitConfig
export const init = State.init
export const viewportId = State.viewportId
export const ScrolledViewport = State.ScrolledViewport
export const GrewContent = State.GrewContent
export const ClickedScrollToBottom = State.ClickedScrollToBottom
export const CompletedScrollToBottom = State.CompletedScrollToBottom
export const Message = State.Message
export type Message = State.Message
export const ScrollToBottom = State.ScrollToBottom
export const TrackViewportScroll = State.TrackViewportScroll
export const ObserveContentGrowth = State.ObserveContentGrowth
export type UpdateReturn = State.UpdateReturn
export const update = State.update

const arrowDownIcon = (): Html => {
  const H = html()
  return H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "2"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      H.AriaHidden(true),
    ],
    [H.path([H.Attribute("d", "M12 5v14")], []), H.path([H.Attribute("d", "m19 12-7 7-7-7")], [])],
  )
}

export const root = <ParentMessage>(config: SlotConfig<ParentMessage>, children: ReadonlyArray<Html>): Html => {
  const H = html<ParentMessage>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-scroller"),
      H.Class(cn("group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden", config.class)),
    ],
    [...children],
  )
}

export type ViewportConfig<ParentMessage> = SlotConfig<ParentMessage> &
  Readonly<{
    model: Model
    toParentMessage: (message: Message) => ParentMessage
  }>

export const viewport = <ParentMessage>(config: ViewportConfig<ParentMessage>, children: ReadonlyArray<Html>): Html => {
  const H = html<ParentMessage>()
  return H.div(
    [
      H.Id(viewportId(config.model)),
      H.OnMount(Mount.mapMessage(TrackViewportScroll(), config.toParentMessage)),
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-scroller-viewport"),
      H.Class(
        cn(
          "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export type ContentConfig<ParentMessage> = SlotConfig<ParentMessage> &
  Readonly<{
    toParentMessage: (message: Message) => ParentMessage
  }>

export const content = <ParentMessage>(config: ContentConfig<ParentMessage>, children: ReadonlyArray<Html>): Html => {
  const H = html<ParentMessage>()
  return H.div(
    [
      H.OnMount(Mount.mapMessage(ObserveContentGrowth(), config.toParentMessage)),
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-scroller-content"),
      H.Class(cn("flex h-max min-h-full flex-col gap-8", config.class)),
    ],
    [...children],
  )
}

export const item = <ParentMessage>(config: SlotConfig<ParentMessage>, children: ReadonlyArray<Html>): Html => {
  const H = html<ParentMessage>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-scroller-item"),
      H.Class(cn("min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]", config.class)),
    ],
    [...children],
  )
}

const scrollButtonClass =
  "absolute inset-s-1/2 bottom-4 size-8 -translate-x-1/2 rounded-full border border-border bg-background text-foreground shadow-md transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] rtl:translate-x-1/2"

export type ScrollButtonConfig<ParentMessage> = SlotConfig<ParentMessage> &
  Readonly<{
    model: Model
    toParentMessage: (message: Message) => ParentMessage
  }>

export const scrollButton = <ParentMessage>(config: ScrollButtonConfig<ParentMessage>): Html => {
  const H = html<ParentMessage>()
  return button(
    {
      variant: "secondary",
      size: "icon",
      dataSlot: "message-scroller-button",
      onClick: config.toParentMessage(ClickedScrollToBottom()),
      class: cn(scrollButtonClass, config.class),
      attributes: [
        ...(config.attributes ?? []),
        H.DataAttribute("direction", "end"),
        H.DataAttribute("active", String(!config.model.isAtBottom)),
      ],
    },
    [arrowDownIcon(), H.span([H.Class("sr-only")], ["Scroll to end"])],
  )
}
