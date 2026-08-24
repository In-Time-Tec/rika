import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs"

interface DiagnosticFileHost {
  readonly write: (bytes: Uint8Array) => void
  readonly settle: (destination: string) => void
  readonly close: () => void
}

export const openDiagnosticFile = (source: string): DiagnosticFileHost => {
  const descriptor = openSync(source, "ax", 0o600)
  let byteOffset = 0
  let open = true
  const close = () => {
    if (!open) return
    open = false
    closeSync(descriptor)
  }
  return {
    write(bytes) {
      let sourceOffset = 0
      while (sourceOffset < bytes.byteLength) {
        const bytesWritten = writeSync(descriptor, bytes, sourceOffset, bytes.byteLength - sourceOffset, byteOffset)
        if (bytesWritten === 0) throw new Error("Unable to persist diagnostics")
        sourceOffset += bytesWritten
        byteOffset += bytesWritten
      }
    },
    settle(destination) {
      if (!open) return
      try {
        fsyncSync(descriptor)
      } finally {
        close()
      }
      renameSync(source, destination)
    },
    close,
  }
}
