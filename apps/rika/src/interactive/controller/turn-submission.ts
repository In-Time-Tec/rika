export const nextSubmissionId = (sequence: number) => ({
  id: `submission-${sequence + 1}`,
  sequence: sequence + 1,
})
