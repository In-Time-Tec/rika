export interface TerminalThemeColors {
  readonly text: string
  readonly subtle: string
  readonly muted: string
  readonly surface: string
  readonly teal: string
  readonly green: string
  readonly red: string
  readonly amber: string
  readonly blue: string
  readonly purple: string
  readonly gold: string
  readonly low: string
  readonly medium: string
  readonly high: string
  readonly ultra: string
  readonly selectionBg: string
  readonly selectionFg: string
  readonly selectionHint: string
}
export const colors: TerminalThemeColors = {
  text: "white",
  subtle: "brightBlack",
  muted: "brightBlack",
  surface: "default",
  teal: "cyan",
  green: "green",
  red: "red",
  amber: "yellow",
  blue: "blue",
  purple: "magenta",
  gold: "yellow",
  low: "#ffd700",
  medium: "#3dffa6",
  high: "#3dd4ff",
  ultra: "#d8b3ff",
  selectionBg: "yellow",
  selectionFg: "black",
  selectionHint: "blue",
}
export const spacing = { transcript: 1, inputHorizontal: 1, inputHeight: 5, overlayTop: 4, overlayHeight: 10 } as const
