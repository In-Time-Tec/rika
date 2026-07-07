import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import * as MessageScroller from "./message-scroller"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export const conversation = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return MessageScroller.root(
    {
      attributes: [H.Role("log"), ...(config.attributes ?? [])],
      class: cn("relative flex-1", config.class),
    },
    children,
  )
}

export type ConversationContentConfig<Message> = SlotConfig<Message> &
  Readonly<{
    model: MessageScroller.Model
    toParentMessage: (message: MessageScroller.Message) => Message
  }>

export const conversationContent = <Message>(
  config: ConversationContentConfig<Message>,
  children: ReadonlyArray<Html>,
): Html =>
  MessageScroller.viewport(
    {
      model: config.model,
      toParentMessage: config.toParentMessage,
      attributes: config.attributes ?? [],
    },
    [
      MessageScroller.content(
        { toParentMessage: config.toParentMessage, class: cn("flex flex-col gap-8 p-4", config.class) },
        children,
      ),
    ],
  )

export type ConversationEmptyStateConfig<Message> = SlotConfig<Message> &
  Readonly<{
    title?: string
    description?: string
    icon?: Html
  }>

export const conversationEmptyState = <Message>(
  config: ConversationEmptyStateConfig<Message>,
  children: UiChildren = [],
): Html => {
  const H = html<Message>()
  const title = config.title ?? "No messages yet"
  const description = config.description ?? "Start a conversation to see messages here"
  const defaultChildren: ReadonlyArray<Html> = [
    ...(config.icon === undefined ? [] : [H.div([H.Class("text-muted-foreground")], [config.icon])]),
    H.div(
      [H.Class("space-y-1")],
      [H.h3([H.Class("text-sm font-medium")], [title]), H.p([H.Class("text-sm text-muted-foreground")], [description])],
    ),
  ]
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "conversation-empty-state"),
      H.Class(cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", config.class)),
    ],
    children.length > 0 ? [...children] : defaultChildren,
  )
}

export type ConversationScrollButtonConfig<Message> = SlotConfig<Message> &
  Readonly<{
    model: MessageScroller.Model
    toParentMessage: (message: MessageScroller.Message) => Message
  }>

export const conversationScrollButton = <Message>(config: ConversationScrollButtonConfig<Message>): Html =>
  MessageScroller.scrollButton({
    model: config.model,
    toParentMessage: config.toParentMessage,
    class: cn("dark:bg-background dark:hover:bg-muted", config.class),
    attributes: config.attributes ?? [],
  })
