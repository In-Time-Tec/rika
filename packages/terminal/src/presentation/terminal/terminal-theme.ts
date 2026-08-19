export class TerminalColor {
  readonly buffer: Uint16Array
  private readonly colorIntent: "rgb" | "indexed" | "default"
  private readonly colorSlot: number
  constructor(
    readonly red: number,
    readonly green: number,
    readonly blue: number,
    readonly alpha = 255,
    intent: "rgb" | "indexed" | "default" = "rgb",
    slot = 0,
  ) {
    this.colorIntent = intent
    this.colorSlot = slot
    let intentByte = 0
    if (intent === "indexed") intentByte = 1
    else if (intent === "default") intentByte = 2
    this.buffer = new Uint16Array([
      red | (intent === "indexed" ? slot << 8 : 0),
      green | (intentByte << 8),
      blue,
      alpha,
    ])
  }
  toInts(): [number, number, number, number] {
    return [this.red, this.green, this.blue, this.alpha]
  }
  get r(): number {
    return this.red / 255
  }
  get g(): number {
    return this.green / 255
  }
  get b(): number {
    return this.blue / 255
  }
  get a(): number {
    return this.alpha / 255
  }
  get meta(): number {
    let intentByte = 0
    if (this.colorIntent === "indexed") intentByte = 1
    else if (this.colorIntent === "default") intentByte = 2
    return intentByte * 256 + this.colorSlot
  }
  get intent(): "rgb" | "indexed" | "default" {
    return this.colorIntent
  }
  get slot(): number {
    return this.colorSlot
  }
  map<R>(fn: (value: number) => R): [R, R, R, R] {
    return [fn(this.r), fn(this.g), fn(this.b), fn(this.a)]
  }
  toString(): string {
    return `rgba(${this.r.toFixed(2)}, ${this.g.toFixed(2)}, ${this.b.toFixed(2)}, ${this.a.toFixed(2)})`
  }
  equals(other?: { readonly buffer: Uint16Array }): boolean {
    return (
      other !== undefined &&
      this.buffer[0] === other.buffer[0] &&
      this.buffer[1] === other.buffer[1] &&
      this.buffer[2] === other.buffer[2] &&
      this.buffer[3] === other.buffer[3]
    )
  }
}

export interface TerminalThemeColors {
  readonly text: TerminalColor
  readonly subtle: TerminalColor
  readonly muted: TerminalColor
  readonly surface: TerminalColor
  readonly teal: TerminalColor
  readonly green: TerminalColor
  readonly red: TerminalColor
  readonly amber: TerminalColor
  readonly blue: TerminalColor
  readonly purple: TerminalColor
  readonly gold: TerminalColor
  readonly low: string
  readonly medium: string
  readonly high: string
  readonly ultra: string
  readonly selectionBg: TerminalColor
  readonly selectionFg: TerminalColor
  readonly selectionHint: TerminalColor
}
export const colors: TerminalThemeColors = {
  text: new TerminalColor(192, 192, 192, 255, "indexed", 7),
  subtle: new TerminalColor(128, 128, 128, 255, "indexed", 8),
  muted: new TerminalColor(128, 128, 128, 255, "indexed", 8),
  surface: new TerminalColor(0, 0, 0, 255, "default"),
  teal: new TerminalColor(0, 128, 128, 255, "indexed", 6),
  green: new TerminalColor(0, 128, 0, 255, "indexed", 2),
  red: new TerminalColor(128, 0, 0, 255, "indexed", 1),
  amber: new TerminalColor(128, 128, 0, 255, "indexed", 3),
  blue: new TerminalColor(0, 0, 128, 255, "indexed", 4),
  purple: new TerminalColor(128, 0, 128, 255, "indexed", 5),
  gold: new TerminalColor(128, 128, 0, 255, "indexed", 3),
  low: "#ffd700",
  medium: "#3dffa6",
  high: "#3dd4ff",
  ultra: "#d8b3ff",
  selectionBg: new TerminalColor(128, 128, 0, 255, "indexed", 3),
  selectionFg: new TerminalColor(0, 0, 0, 255, "indexed", 0),
  selectionHint: new TerminalColor(0, 0, 128, 255, "indexed", 4),
}
const customModeColors = ["#ffd700", "#3dffa6", "#3dd4ff", "#d8b3ff", "#ff8fb1", "#ffb86c"] as const
export const modeColor = (mode: string): string => {
  if (mode === "low" || mode === "medium" || mode === "high" || mode === "ultra") return colors[mode]
  const hash = [...mode].reduce((value, character) => (value * 31 + character.codePointAt(0)!) >>> 0, 0)
  return customModeColors[hash % customModeColors.length]!
}
export const spacing = { transcript: 1, inputHorizontal: 1, inputHeight: 5, overlayTop: 4, overlayHeight: 10 } as const
