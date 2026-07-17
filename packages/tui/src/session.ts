import { Function } from "effect"
import type { Mode, PermissionDecision, PromptPart } from "./view-state"

export interface ModelTuning {
  readonly fastMode?: boolean
}

export type Action =
  | {
      readonly _tag: "Submit"
      readonly prompt: string
      readonly parts: ReadonlyArray<PromptPart>
      readonly mode: Mode
      readonly tuning?: ModelTuning
    }
  | { readonly _tag: "EditQueued"; readonly id: string; readonly prompt: string }
  | { readonly _tag: "Dequeue"; readonly id: string }
  | { readonly _tag: "SteerQueued"; readonly id: string; readonly prompt: string }
  | { readonly _tag: "Steer"; readonly prompt: string }
  | { readonly _tag: "InterruptAndSend"; readonly prompt: string }
  | { readonly _tag: "Cancel" }
  | { readonly _tag: "Quit" }
  | {
      readonly _tag: "DecidePermission"
      readonly id: string
      readonly kind: "permission" | "tool-approval"
      readonly decision: PermissionDecision
    }
  | { readonly _tag: "SelectThread"; readonly id: string }

export interface Adapter {
  readonly submit: (prompt: string, parts: ReadonlyArray<PromptPart>, mode: Mode, tuning?: ModelTuning) => void
  readonly quit: () => void
  readonly editQueued?: (id: string, prompt: string) => void
  readonly dequeue?: (id: string) => void
  readonly steerQueued?: (id: string, prompt: string) => void
  readonly steer?: (prompt: string) => void
  readonly interruptAndSend?: (prompt: string) => void
  readonly cancel?: () => void
  readonly decidePermission?: (id: string, kind: "permission" | "tool-approval", decision: PermissionDecision) => void
  readonly selectThread?: (id: string) => void
}

export const execute: {
  (action: Action): (adapter: Adapter) => boolean
  (adapter: Adapter, action: Action): boolean
} = Function.dual(2, (adapter: Adapter, action: Action): boolean => {
  switch (action._tag) {
    case "Submit":
      adapter.submit(action.prompt, action.parts, action.mode, action.tuning)
      return true
    case "EditQueued":
      adapter.editQueued?.(action.id, action.prompt)
      return adapter.editQueued !== undefined
    case "Dequeue":
      adapter.dequeue?.(action.id)
      return adapter.dequeue !== undefined
    case "SteerQueued":
      adapter.steerQueued?.(action.id, action.prompt)
      return adapter.steerQueued !== undefined
    case "Steer":
      adapter.steer?.(action.prompt)
      return adapter.steer !== undefined
    case "InterruptAndSend":
      adapter.interruptAndSend?.(action.prompt)
      return adapter.interruptAndSend !== undefined
    case "Cancel":
      adapter.cancel?.()
      return adapter.cancel !== undefined
    case "Quit":
      adapter.quit()
      return true
    case "DecidePermission":
      adapter.decidePermission?.(action.id, action.kind, action.decision)
      return adapter.decidePermission !== undefined
    case "SelectThread":
      adapter.selectThread?.(action.id)
      return adapter.selectThread !== undefined
  }
})
