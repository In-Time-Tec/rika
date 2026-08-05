export interface TextPart {
  readonly _tag: "Text"
  readonly text: string
}

export interface ReasoningPart {
  readonly _tag: "Reasoning"
  readonly text: string
}

export interface ToolCallPart {
  readonly _tag: "ToolCall"
  readonly name: string
  readonly params: unknown
  readonly id?: string
}

export type Part = TextPart | ReasoningPart | ToolCallPart

export interface TurnStep {
  readonly _tag: "Turn"
  readonly parts: ReadonlyArray<Part>
  readonly delay?: string
}

export interface FailureStep {
  readonly _tag: "Failure"
  readonly error: Error
}

export const model = {
  text: (text: string, delayMs?: number): TurnStep => ({
    _tag: "Turn",
    parts: [{ _tag: "Text", text }],
    ...(delayMs === undefined ? {} : { delay: `${delayMs} millis` }),
  }),
  turn: (parts: TurnStep["parts"], options: { readonly delay?: string } = {}): TurnStep => ({
    _tag: "Turn",
    parts,
    ...options,
  }),
  part: (text: string): TextPart => ({ _tag: "Text", text }),
  reasoning: (text: string): ReasoningPart => ({ _tag: "Reasoning", text }),
  toolCall: (name: string, params: unknown, id?: string): ToolCallPart => ({
    _tag: "ToolCall",
    name,
    params,
    ...(id === undefined ? {} : { id }),
  }),
  failure: (description: string): FailureStep => ({ _tag: "Failure", error: new Error(description) }),
}

export type Script = ReadonlyArray<Part | TurnStep | FailureStep>

export interface TuiAppLane {
  readonly when?: (prompt: string) => boolean
  readonly script: Script
}
