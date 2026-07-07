import { html, type Attribute, type Html } from "foldkit/html"
import type { AppMessage } from "./app"
import * as AlertDialog from "./components/ui/alert-dialog"
import * as Avatar from "./components/ui/avatar"
import * as Badge from "./components/ui/badge"
import * as Bubble from "./components/ui/bubble"
import * as Button from "./components/ui/button"
import * as Card from "./components/ui/card"
import * as ChainOfThought from "./components/ui/chain-of-thought"
import * as CodeBlock from "./components/ui/code-block"
import * as Conversation from "./components/ui/conversation"
import * as Message from "./components/ui/message"
import * as MessageScroller from "./components/ui/message-scroller"
import * as PromptInput from "./components/ui/prompt-input"
import * as Reasoning from "./components/ui/reasoning"
import * as Select from "./components/ui/select"
import * as Tabs from "./components/ui/tabs"
import * as Textarea from "./components/ui/textarea"
import * as Tool from "./components/ui/tool"
import { cn } from "./lib/cn"

const H = html<AppMessage>()

type Attributes = ReadonlyArray<Attribute<AppMessage>>
type Child = Html | string
type Children = ReadonlyArray<Child>

export { AlertDialog }
export { Avatar }
export { Bubble }
export { Card }
export { ChainOfThought }
export { CodeBlock }
export { Conversation }
export { Message }
export { MessageScroller }
export { PromptInput }
export { Reasoning }
export { Select }
export { Tabs }
export { Textarea }
export { Tool }
export { cn }
export type SelectOption = Select.SelectOption

export const button = (attributes: Attributes, children: Children, variant: Button.ButtonVariant = "default"): Html =>
  Button.button<AppMessage>({ attributes, variant }, children)

export const badge = (children: Children, tone: Badge.BadgeTone = "default"): Html =>
  Badge.badge<AppMessage>({ tone }, children)

export const textarea = (config: Textarea.TextareaConfig<AppMessage>): Html => Textarea.textarea<AppMessage>(config)

export const select = (config: Select.SelectConfig<AppMessage>): Html => Select.select<AppMessage>(config)

export const empty = H.empty
