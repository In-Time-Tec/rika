import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { button } from "./button"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

const iconAttributes = (className: string) => {
  const H = html()
  return [
    H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
    H.Attribute("viewBox", "0 0 24 24"),
    H.Attribute("fill", "none"),
    H.Attribute("stroke", "currentColor"),
    H.Attribute("stroke-width", "2"),
    H.Attribute("stroke-linecap", "round"),
    H.Attribute("stroke-linejoin", "round"),
    H.AriaHidden(true),
    H.Class(className),
  ]
}

const copyIcon = (): Html => {
  const H = html()
  return H.svg(iconAttributes("size-3.5"), [
    H.rect(
      [
        H.Attribute("width", "14"),
        H.Attribute("height", "14"),
        H.Attribute("x", "8"),
        H.Attribute("y", "8"),
        H.Attribute("rx", "2"),
        H.Attribute("ry", "2"),
      ],
      [],
    ),
    H.path([H.Attribute("d", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2")], []),
  ])
}

const checkIcon = (): Html => {
  const H = html()
  return H.svg(iconAttributes("size-3.5"), [H.path([H.Attribute("d", "M20 6 9 17l-5-5")], [])])
}

export type CodeBlockConfig<Message> = SlotConfig<Message> &
  Readonly<{
    language?: string
  }>

export const codeBlock = <Message>(config: CodeBlockConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "code-block"),
      ...(config.language === undefined ? [] : [H.DataAttribute("language", config.language)]),
      H.Class(
        cn("group relative w-full overflow-hidden rounded-md border bg-background text-foreground", config.class),
      ),
    ],
    [...children],
  )
}

export const codeBlockHeader = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "code-block-header"),
      H.Class(
        cn(
          "flex items-center justify-between border-b bg-muted/80 px-3 py-2 text-xs text-muted-foreground",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export const codeBlockTitle = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "code-block-title"),
      H.Class(cn("flex items-center gap-2", config.class)),
    ],
    [...children],
  )
}

export const codeBlockFilename = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.span(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "code-block-filename"),
      H.Class(cn("font-mono", config.class)),
    ],
    [...children],
  )
}

export const codeBlockActions = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "code-block-actions"),
      H.Class(cn("-my-1 -mr-1 flex items-center gap-2", config.class)),
    ],
    [...children],
  )
}

const lineNumberClass = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-muted-foreground/50",
  "before:font-mono",
  "before:select-none",
)

export type CodeBlockContentConfig<Message> = SlotConfig<Message> &
  Readonly<{
    code: string
    showsLineNumbers?: boolean
  }>

export const codeBlockContent = <Message>(config: CodeBlockContentConfig<Message>): Html => {
  const H = html<Message>()
  const showsLineNumbers = config.showsLineNumbers ?? false
  const lines = config.code.split("\n")
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "code-block-content"),
      H.Class(cn("relative overflow-auto", config.class)),
    ],
    [
      H.pre(
        [H.Class("m-0 p-4 text-sm")],
        [
          H.code(
            [H.Class(cn("font-mono text-sm", showsLineNumbers && "[counter-increment:line_0] [counter-reset:line]"))],
            lines.map((line) =>
              H.span([H.Class(showsLineNumbers ? lineNumberClass : "block")], [line === "" ? "\n" : line]),
            ),
          ),
        ],
      ),
    ],
  )
}

export type CodeBlockCopyButtonConfig<Message> = SlotConfig<Message> &
  Readonly<{
    isCopied: boolean
    onCopied: Message
  }>

export const codeBlockCopyButton = <Message>(
  config: CodeBlockCopyButtonConfig<Message>,
  children: UiChildren = [],
): Html => {
  const H = html<Message>()
  const defaultChildren: ReadonlyArray<Html> = [config.isCopied ? checkIcon() : copyIcon()]
  return button<Message>(
    {
      variant: "ghost",
      size: "icon",
      onClick: config.onCopied,
      class: cn("shrink-0", config.class),
      dataSlot: "code-block-copy-button",
      attributes: [H.AriaLabel("Copy"), ...(config.attributes ?? [])],
    },
    children.length > 0 ? children : defaultChildren,
  )
}
