export const threadIdFromMetadata = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const threadId = metadata?.rika_thread_id
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined
}
