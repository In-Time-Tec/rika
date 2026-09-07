import { For, Match, Show, Switch, type Accessor } from "solid-js"
import type { TranscriptItem } from "../../client/model"
import type { TranscriptGroup, ToolPresentation } from "./presenter"
import {
  DiffHeader,
  ItemHeader,
  MarkdownBody,
  PlainBody,
  StyledBody,
  ToolBody,
  statusColor,
  statusGlyph,
  titleFor,
  toolDefaultExpanded,
  toolExpandable,
  toolGroupLabel,
  toolHasBody,
} from "./content"
import { colors } from "../theme"
import { isActive, aggregateActivity } from "./presenter"

const ToolChild = (props: {
  readonly tool: ToolPresentation
  readonly last: boolean
  readonly expanded: Accessor<boolean>
  readonly selected: Accessor<boolean>
  readonly frame: Accessor<number>
  readonly animate: Accessor<boolean>
  readonly toggle: () => void
  readonly select: () => void
}) => {
  const expandable = () => toolHasBody(props.tool)
  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      <text
        width="100%"
        selectable={false}
        onMouseDown={() => {
          props.select()
          if (expandable()) props.toggle()
        }}
        wrapMode="none"
      >
        <span style={{ fg: colors.subtle }}>{props.last ? "└ " : "├ "}</span>
        <span
          style={{ fg: props.selected() ? colors.blue : statusColor(props.tool.item.status), bold: props.selected() }}
        >
          {statusGlyph(props.tool.item.status, props.frame(), props.animate())}
        </span>
        <span style={{ fg: props.selected() ? colors.blue : colors.text, bold: props.selected() }}>
          {` ${toolGroupLabel([props.tool])}`}
        </span>
        <Show when={expandable()}>
          <span style={{ fg: props.selected() ? colors.blue : colors.subtle }}>{props.expanded() ? " ▾" : " ▸"}</span>
        </Show>
      </text>
      <Show when={expandable() && props.expanded()}>
        <ToolBody tool={props.tool} indent={4} />
      </Show>
    </box>
  )
}

interface ToolGroupViewProps {
  readonly group: Extract<TranscriptGroup, { kind: "tools" }>
  readonly frame: Accessor<number>
  readonly animate: Accessor<boolean>
  readonly isExpanded: (id: string, fallback: boolean) => boolean
  readonly toggle: (id: string, fallback: boolean) => void
  readonly selected: Accessor<string | undefined>
  readonly select: (id: string) => void
}

const ToolGroupView = (props: ToolGroupViewProps) => {
  const items = () => props.group.items
  const expandable = () => toolExpandable(items())
  const defaultExpanded = () => toolDefaultExpanded(items())
  const expanded = () => props.isExpanded(props.group.id, defaultExpanded())
  const selected = () => props.selected() === props.group.id
  const toggle = () => props.toggle(props.group.id, defaultExpanded())
  const activity = () => aggregateActivity(items().map((tool) => tool.item.status))
  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      <text
        width="100%"
        selectable={false}
        onMouseDown={() => {
          props.select(props.group.id)
          if (expandable()) toggle()
        }}
        wrapMode="none"
      >
        <span style={{ fg: selected() ? colors.blue : statusColor(activity()), bold: selected() }}>
          {statusGlyph(activity(), props.frame(), props.animate())}
        </span>
        <span style={{ fg: selected() ? colors.blue : colors.text, bold: selected() }}>
          {` ${toolGroupLabel(items())}`}
        </span>
        <Show when={expandable()}>
          <span style={{ fg: selected() ? colors.blue : colors.subtle }}>{expanded() ? " ▾" : " ▸"}</span>
        </Show>
      </text>
      <Show when={expanded()}>
        <Switch>
          <Match when={items().length > 1}>
            <For each={items()}>
              {(tool, index) => {
                const childId = `tool-child:${tool.item.id}`
                const childExpanded = () => props.isExpanded(childId, isActive(tool.item.status))
                const childSelected = () => props.selected() === childId
                return (
                  <ToolChild
                    tool={tool}
                    last={index() === items().length - 1}
                    expanded={childExpanded}
                    selected={childSelected}
                    frame={props.frame}
                    animate={props.animate}
                    toggle={() => props.toggle(childId, isActive(tool.item.status))}
                    select={() => props.select(childId)}
                  />
                )
              }}
            </For>
          </Match>
          <Match when={items().length === 1}>
            <ToolBody tool={items()[0]!} indent={2} />
          </Match>
        </Switch>
      </Show>
    </box>
  )
}

const ChildRow = (props: {
  readonly item: TranscriptItem
  readonly last: boolean
  readonly expanded: Accessor<boolean>
  readonly selected: Accessor<boolean>
  readonly frame: Accessor<number>
  readonly animate: Accessor<boolean>
  readonly toggle: () => void
  readonly select: () => void
}) => {
  const expandable = () => props.item.text.trim().length > 0
  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      <text
        width="100%"
        selectable={false}
        onMouseDown={() => {
          props.select()
          if (expandable()) props.toggle()
        }}
        wrapMode="none"
      >
        <span style={{ fg: colors.subtle }}>{props.last ? "└ " : "├ "}</span>
        <span style={{ fg: props.selected() ? colors.blue : statusColor(props.item.status), bold: props.selected() }}>
          {statusGlyph(props.item.status, props.frame(), props.animate())}
        </span>
        <span style={{ fg: props.selected() ? colors.blue : colors.text, bold: props.selected() }}>
          {` ${titleFor(props.item)}`}
        </span>
        <Show when={expandable()}>
          <span style={{ fg: props.selected() ? colors.blue : colors.subtle }}>{props.expanded() ? " ▾" : " ▸"}</span>
        </Show>
      </text>
      <Show when={expandable() && props.expanded()}>
        <box width="100%" paddingLeft={2}>
          <MarkdownBody source={() => props.item.text} />
        </box>
      </Show>
    </box>
  )
}

interface ChildGroupViewProps {
  readonly group: Extract<TranscriptGroup, { kind: "children" }>
  readonly frame: Accessor<number>
  readonly animate: Accessor<boolean>
  readonly isExpanded: (id: string, fallback: boolean) => boolean
  readonly toggle: (id: string, fallback: boolean) => void
  readonly selected: Accessor<string | undefined>
  readonly select: (id: string) => void
}

const ChildGroupView = (props: ChildGroupViewProps) => (
  <box width="100%" flexDirection="column" flexShrink={0}>
    <For each={props.group.items}>
      {(item, index) => {
        const expanded = () => props.isExpanded(item.id, isActive(item.status))
        return (
          <ChildRow
            item={item}
            last={index() === props.group.items.length - 1}
            expanded={expanded}
            selected={() => props.selected() === item.id}
            frame={props.frame}
            animate={props.animate}
            toggle={() => props.toggle(item.id, isActive(item.status))}
            select={() => props.select(item.id)}
          />
        )
      }}
    </For>
  </box>
)

interface ItemViewProps {
  readonly item: TranscriptItem
  readonly live: boolean
  readonly animate: Accessor<boolean>
  readonly frame: Accessor<number>
  readonly isExpanded: (id: string, fallback: boolean) => boolean
  readonly toggle: (id: string, fallback: boolean) => void
  readonly selected: Accessor<string | undefined>
  readonly select: (id: string) => void
}

const ItemView = (props: ItemViewProps) => {
  const item = () => props.item
  const source = () => item().text
  const selected = () => props.selected() === item().id
  const diffExpanded = () => props.isExpanded(item().id, false)
  const diffExpandable = () => item().kind === "diff"
  const toggle = () => props.toggle(item().id, false)
  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      <Switch>
        <Match when={item().kind === "user"}>
          <PlainBody
            source={() =>
              item()
                .text.split("\n")
                .map((line) => `┃ ${line}`)
                .join("\n")
            }
            fg={colors.green}
            attributes={4}
          />
        </Match>
        <Match when={item().kind === "assistant"}>
          <Show when={item().text.trimEnd().length > 0}>
            <MarkdownBody source={() => item().text.trimEnd()} />
          </Show>
        </Match>
        <Match when={item().kind === "reasoning"}>
          <PlainBody source={() => item().text.trimEnd()} fg={colors.muted} attributes={2 | 4} />
        </Match>
        <Match when={item().kind === "diff"}>
          <DiffHeader
            item={item()}
            expanded={diffExpanded}
            selected={selected}
            toggle={toggle}
            select={() => props.select(item().id)}
          />
          <Show when={diffExpandable() && diffExpanded()}>
            <StyledBody source={source} kind="diff" indent={2} />
          </Show>
        </Match>
        <Match when={item().kind === "image"}>
          <PlainBody
            source={() => `▧ ${titleFor(item())}${item().text.length > 0 ? ` · ${item().text}` : ""}`}
            fg={colors.muted}
            wrapMode="none"
          />
        </Match>
        <Match when={item().kind === "notice"}>
          <PlainBody
            source={() => (item().text === "cancelled" ? "⊘ cancelled" : `! ${item().text}`)}
            fg={colors.amber}
          />
        </Match>
        <Match when={item().kind === "error"}>
          <ItemHeader
            item={item}
            status={() => item().status ?? "failed"}
            frame={props.frame}
            animate={props.animate}
            tone={colors.red}
          />
          <Show when={item().text.length > 0}>
            <PlainBody source={source} fg={colors.red} />
          </Show>
        </Match>
        <Match when={item().kind === "tool"}>
          <ItemHeader item={item} status={() => item().status} frame={props.frame} animate={props.animate} />
        </Match>
      </Switch>
    </box>
  )
}

interface GroupViewProps {
  readonly group: TranscriptGroup
  readonly active: boolean
  readonly animate: Accessor<boolean>
  readonly frame: Accessor<number>
  readonly isExpanded: (id: string, fallback: boolean) => boolean
  readonly toggle: (id: string, fallback: boolean) => void
  readonly selected: Accessor<string | undefined>
  readonly select: (id: string) => void
}

export const GroupView = (props: GroupViewProps) => (
  <Switch>
    <Match when={props.group.kind === "tools" ? props.group : undefined}>
      {(group) => (
        <ToolGroupView
          group={group()}
          frame={props.frame}
          animate={props.animate}
          isExpanded={props.isExpanded}
          toggle={props.toggle}
          selected={props.selected}
          select={props.select}
        />
      )}
    </Match>
    <Match when={props.group.kind === "children" ? props.group : undefined}>
      {(group) => (
        <ChildGroupView
          group={group()}
          frame={props.frame}
          animate={props.animate}
          isExpanded={props.isExpanded}
          toggle={props.toggle}
          selected={props.selected}
          select={props.select}
        />
      )}
    </Match>
    <Match when={props.group.kind === "item" ? props.group : undefined}>
      {(group) => (
        <ItemView
          item={group().item}
          live={props.active}
          animate={props.animate}
          frame={props.frame}
          isExpanded={props.isExpanded}
          toggle={props.toggle}
          selected={props.selected}
          select={props.select}
        />
      )}
    </Match>
  </Switch>
)
