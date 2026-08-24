import { Function } from "effect"
import stringWidth from "string-width"
import { truncateToWidth } from "./format"

export interface ToastLayout {
  readonly right: number
  readonly width: number
  readonly message: string
}

const toastLayoutImpl = (message: string, terminalWidth: number): ToastLayout => {
  const bounded = Math.max(1, terminalWidth)
  const right = Math.min(2, Math.max(0, bounded - 1))
  const width = Math.max(1, Math.min(stringWidth(message) + 6, bounded - right))
  return { right, width, message: truncateToWidth(message, Math.max(0, width - 6)) }
}

export const toastLayout: {
  (message: string, terminalWidth: number): ToastLayout
  (terminalWidth: number): (message: string) => ToastLayout
} = Function.dual(2, toastLayoutImpl)
