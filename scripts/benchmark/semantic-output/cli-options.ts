export interface Options {
  readonly command: "plan" | "setup" | "run" | "compare"
  readonly output: string
  readonly candidateBatonRelease?: string
  readonly samples: number
  readonly baselineTag: "v0.5.3"
  readonly baselineBatonVersion: "0.20.2"
  readonly baseline?: string
  readonly candidate?: string
}

const value = (arguments_: ReadonlyArray<string>, name: string): string | undefined => {
  const index = arguments_.indexOf(name)
  return index < 0 ? undefined : arguments_[index + 1]
}

export const parse = (arguments_: ReadonlyArray<string>): Options => {
  const command = arguments_[0]
  if (command !== "plan" && command !== "setup" && command !== "run" && command !== "compare")
    throw new Error("expected plan, setup, run, or compare")
  const output = value(arguments_, "--output")
  if (output === undefined) throw new Error("--output is required")
  const samplesText = value(arguments_, "--samples") ?? "3"
  const samples = Number(samplesText)
  if (!Number.isInteger(samples) || samples < 3) throw new Error("--samples must be an integer of at least 3")
  const candidateBatonRelease = value(arguments_, "--candidate-baton-release")
  if ((command === "setup" || command === "run") && candidateBatonRelease === undefined)
    throw new Error("--candidate-baton-release is required")
  const baseline = value(arguments_, "--baseline")
  const candidate = value(arguments_, "--candidate")
  return {
    command,
    output,
    samples,
    baselineTag: "v0.5.3",
    baselineBatonVersion: "0.20.2",
    ...(candidateBatonRelease === undefined ? {} : { candidateBatonRelease }),
    ...(baseline === undefined ? {} : { baseline }),
    ...(candidate === undefined ? {} : { candidate }),
  }
}
