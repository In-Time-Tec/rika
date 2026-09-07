import type { KeyEvent } from "@opentui/core"

export const chord = (key: KeyEvent): string => {
  let prefix = ""
  if (key.ctrl) prefix += "C-"
  if (key.shift) prefix += "S-"
  if (key.option === true || key.meta) prefix += "A-"
  return prefix + key.name.toLowerCase()
}

export const printableSequence = (key: KeyEvent): string | undefined => {
  if (key.ctrl || key.option === true || key.meta || key.super === true || key.hyper === true) return undefined
  if (key.name === "space" && key.sequence.length === 0) return " "
  const first = key.sequence.codePointAt(0)
  return first !== undefined && first >= 32 && first !== 127 ? key.sequence : undefined
}
