export const transcriptPageLimit = 8 * 1024 * 1024
export const transcriptPayloadLimit = transcriptPageLimit - 64 * 1024

export const boundedTranscript = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  return bytes.byteLength <= transcriptPayloadLimit ? text : new TextDecoder().decode(bytes.slice(0, transcriptPayloadLimit))
}
