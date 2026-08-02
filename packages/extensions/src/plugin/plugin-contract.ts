import { Effect } from "effect"

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Json
  readonly execute: (input: Json) => Effect.Effect<Json, unknown>
}

export interface Mode {
  readonly name: string
  readonly description: string
  readonly defaultTools: ReadonlyArray<string>
}

export interface AgentProfile {
  readonly name: string
  readonly description: string
  readonly mode: string
  readonly tools: ReadonlyArray<string>
}

export type UiAction =
  | { readonly kind: "notice"; readonly message: string }
  | { readonly kind: "open-panel"; readonly panel: string }
  | { readonly kind: "copy"; readonly text: string }

export interface Registrar {
  readonly tool: (tool: Tool) => void
  readonly mode: (mode: Mode) => void
  readonly agentProfile: (profile: AgentProfile) => void
  readonly uiAction: (name: string, action: UiAction) => void
}

export interface PluginV1 {
  readonly apiVersion: 1
  readonly id: string
  readonly register: (registrar: Registrar) => void
}

export const v1 = Object.freeze({ apiVersion: 1 as const })
