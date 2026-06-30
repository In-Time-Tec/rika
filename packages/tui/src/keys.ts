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

export const make = (input: {
  readonly name: string
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly sequence?: string
  readonly eventType?: "press" | "repeat" | "release"
}): Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

export const fromOpenTui = (key: OpenTuiKey): Key => ({
  name: key.name,
  ctrl: key.ctrl === true,
  alt: key.option === true || (key.meta === true && key.super !== true),
  meta: key.super === true,
  shift: key.shift === true,
  sequence: key.sequence ?? "",
  eventType: key.eventType ?? "press",
})

export const isPrintable = (key: Key): boolean => {
  if (key.eventType === "release") return false
  if (key.ctrl || key.alt || key.meta) return false
  if (key.name === "space") return key.sequence.length <= 1
  if (key.sequence.length < 1) return false
  const code = key.sequence.charCodeAt(0)
  return code >= 0x20 && code !== 0x7f
}

export const char = (key: Key): string => (key.name === "space" ? " " : key.sequence)

export const paste = (text: string): Key => make({ name: "paste", sequence: text })

export const fromString = (text: string): ReadonlyArray<Key> =>
  Array.from(text).map((character) =>
    character === " " ? make({ name: "space", sequence: " " }) : make({ name: character, sequence: character }),
  )

export const enter = make({ name: "return", sequence: "\r" })
export const escape = make({ name: "escape", sequence: "" })
export const backspace = make({ name: "backspace", sequence: "" })
export const ctrl = (name: string): Key => make({ name, ctrl: true })
export const alt = (name: string): Key => make({ name, alt: true })
