export interface ContextPreparation {
  readonly workspace: string
  readonly targetPaths: ReadonlyArray<string>
  readonly references: ReadonlyArray<string>
}

export const prepareContext = (input: {
  readonly workspace: string
  readonly targetPaths?: ReadonlyArray<string>
  readonly references?: ReadonlyArray<string>
}): ContextPreparation => ({
  workspace: input.workspace,
  targetPaths: input.targetPaths ?? [],
  references: input.references ?? [],
})
