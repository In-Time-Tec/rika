export const nextSubmissionId = (sequence: number): { readonly id: string; readonly sequence: number } => ({
  id: `submission-${sequence + 1}`,
  sequence: sequence + 1,
})
