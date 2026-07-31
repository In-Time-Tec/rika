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
