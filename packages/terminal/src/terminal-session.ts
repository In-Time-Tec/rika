import { Function } from "effect"
import * as Composer from "./state/model/terminal-composer-state"
import * as ComposerPaste from "./state/model/terminal-composer-paste"
import type { Mode } from "./state/model/terminal-state"
import type { PromptPart } from "./state/model/terminal-composer-state"

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
      readonly submissionId?: string
    }
  | { readonly _tag: "EditQueued"; readonly id: string; readonly prompt: string }
  | { readonly _tag: "Dequeue"; readonly id: string }
  | { readonly _tag: "SteerQueued"; readonly id: string; readonly prompt: string; readonly requestId: string }
  | { readonly _tag: "Steer"; readonly prompt: string; readonly requestId: string; readonly turnId?: string }
  | { readonly _tag: "ApproveAuthorization"; readonly turnId: string; readonly authorizationId: string }
  | { readonly _tag: "DenyAuthorization"; readonly turnId: string; readonly authorizationId: string }
  | { readonly _tag: "InterruptAndSend"; readonly prompt: string }
  | { readonly _tag: "Cancel" }
  | { readonly _tag: "Quit" }
  | { readonly _tag: "SelectThread"; readonly id: string }

export interface Adapter {
  readonly submit: (
    prompt: string,
    parts: ReadonlyArray<PromptPart>,
    mode: Mode,
    tuning?: ModelTuning,
    submissionId?: string,
  ) => void
  readonly quit: () => void
  readonly editQueued?: (id: string, prompt: string) => void
  readonly dequeue?: (id: string) => void
  readonly steerQueued?: (id: string, prompt: string, requestId: string) => void
  readonly steer?: (prompt: string, requestId: string, turnId?: string) => void
  readonly approveAuthorization?: (turnId: string, authorizationId: string) => void
  readonly denyAuthorization?: (turnId: string, authorizationId: string) => void
  readonly interruptAndSend?: (prompt: string) => void
  readonly cancel?: () => void
  readonly selectThread?: (id: string) => void
}

export const classifyPrompt = Composer.classifyPrompt
export const promptParts = Composer.promptParts
export const displayInput = Composer.displayInput
export const expandPastedText = ComposerPaste.expandPastedText

export const execute: {
  (action: Action): (adapter: Adapter) => boolean
  (adapter: Adapter, action: Action): boolean
} = Function.dual(2, (adapter: Adapter, action: Action): boolean => {
  switch (action._tag) {
    case "Submit":
      adapter.submit(action.prompt, action.parts, action.mode, action.tuning, action.submissionId)
      return true
    case "EditQueued":
      adapter.editQueued?.(action.id, action.prompt)
      return adapter.editQueued !== undefined
    case "Dequeue":
      adapter.dequeue?.(action.id)
      return adapter.dequeue !== undefined
    case "SteerQueued":
      adapter.steerQueued?.(action.id, action.prompt, action.requestId)
      return adapter.steerQueued !== undefined
    case "Steer":
      adapter.steer?.(action.prompt, action.requestId, action.turnId)
      return adapter.steer !== undefined
    case "ApproveAuthorization":
      adapter.approveAuthorization?.(action.turnId, action.authorizationId)
      return adapter.approveAuthorization !== undefined
    case "DenyAuthorization":
      adapter.denyAuthorization?.(action.turnId, action.authorizationId)
      return adapter.denyAuthorization !== undefined
    case "InterruptAndSend":
      adapter.interruptAndSend?.(action.prompt)
      return adapter.interruptAndSend !== undefined
    case "Cancel":
      adapter.cancel?.()
      return adapter.cancel !== undefined
    case "Quit":
      adapter.quit()
      return true
    case "SelectThread":
      adapter.selectThread?.(action.id)
      return adapter.selectThread !== undefined
  }
})
