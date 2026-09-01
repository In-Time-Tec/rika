import { Toolkit } from "effect/unstable/ai"
import * as Bash from "@rika/product/bash-tool"
import * as Edit from "@rika/product/edit-file-tool"
import * as Read from "@rika/product/read-file-tool"
import * as ShellCommandStatus from "@rika/product/shell-command-status-tool"
import type * as ToolPolicy from "@rika/product/native-tool-policy"

/** The complete model-facing native tool surface advertised by Rika. */
export const registrations: ReadonlyArray<ToolPolicy.Registration> = [
  Bash.registration,
  ShellCommandStatus.registration,
  Read.registration,
  Edit.registration,
]

export const toolkit = Toolkit.make(Bash.tool, ShellCommandStatus.tool, Read.tool, Edit.tool)

/** Tool calls are serialized until per-tool conflict keys are available. */
export const scheduling = {
  maxConcurrency: 1,
  parallelSafe: [],
} as const
