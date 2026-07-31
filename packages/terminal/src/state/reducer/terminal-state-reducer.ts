import { Function } from "effect"
import * as TerminalState from "../model/terminal-state"
import type { Message } from "../model/terminal-message"

export const reduce: {
  (model: TerminalState.Model, message: Message): TerminalState.Model
  (message: Message): (model: TerminalState.Model) => TerminalState.Model
} = Function.dual(
  2,
  (model: TerminalState.Model, message: Message): TerminalState.Model => TerminalState.update(model, message),
)

export const update = reduce
