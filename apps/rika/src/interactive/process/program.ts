#!/usr/bin/env bun
import { Function } from "effect"

const terminalTitleText = (value: string) =>
  value
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()

const terminalTitleSequenceImpl = (title: string, workspace: string, workingFrame?: string): string => {
  const safeWorkingFrame = workingFrame === undefined ? "" : terminalTitleText(workingFrame)
  const prefix = safeWorkingFrame.length === 0 ? "" : `${safeWorkingFrame} `
  return `\u001b]0;${prefix}${terminalTitleText(title)} - rika - ${terminalTitleText(workspace.replace(/^\/Users\/[^/]+/, "~"))}\u0007`
}

export const terminalTitleSequence: {
  (title: string, workspace: string, workingFrame?: string): string
  (workspace: string, workingFrame?: string): (title: string) => string
} = Function.dual((args) => args.length >= 2, terminalTitleSequenceImpl)
