import { Function } from "effect"
export interface Key {
  readonly name: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly sequence: string
  readonly eventType: "press" | "repeat" | "release"
}

export interface OpenTuiKey {
  readonly name: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly option?: boolean
  readonly super?: boolean
  readonly shift?: boolean
  readonly sequence?: string
  readonly eventType?: "press" | "repeat" | "release"
}

export const fromOpenTui = (key: OpenTuiKey): Key => ({
  name: key.name,
  ctrl: key.ctrl === true,
  alt: key.option === true || (key.meta === true && key.super !== true),
  meta: key.super === true,
  shift: key.shift === true,
  sequence: key.sequence ?? "",
  eventType: key.eventType ?? "press",
})

export const isPrintable = (key: Key) =>
  key.eventType !== "release" &&
  !key.ctrl &&
  !key.alt &&
  !key.meta &&
  key.sequence.length > 0 &&
  key.sequence.charCodeAt(0) >= 0x20 &&
  key.sequence.charCodeAt(0) !== 0x7f

export const mouseSequencePattern = new RegExp(`^(?:${String.fromCharCode(27)}?\\[)?<?\\d+(?:;\\d+)*[Mm]?$`)

export type JunkDecision =
  | { readonly _tag: "Forward" }
  | { readonly _tag: "Drop" }
  | { readonly _tag: "Buffer" }
  | { readonly _tag: "Arm" }
  | { readonly _tag: "Flush" }

const classifyMouseJunkImpl = (mapped: Key, buffered: number): JunkDecision => {
  if (mapped.ctrl || mapped.alt || mapped.meta || mapped.eventType === "release") return { _tag: "Forward" }
  if (mapped.sequence.length > 1 && mouseSequencePattern.test(mapped.sequence)) return { _tag: "Drop" }
  if (buffered > 0) {
    if (/^[\d;]$/.test(mapped.sequence) && buffered < 24) return { _tag: "Buffer" }
    if (mapped.sequence === "M" || mapped.sequence === "m") return { _tag: "Drop" }
    if (mapped.sequence === "<") return { _tag: "Arm" }
    return { _tag: "Flush" }
  }
  if (mapped.sequence === "<") return { _tag: "Arm" }
  return { _tag: "Forward" }
}

export const classifyMouseJunk: {
  (mapped: Key, buffered: number): JunkDecision
  (buffered: number): (mapped: Key) => JunkDecision
} = Function.dual(2, classifyMouseJunkImpl)
