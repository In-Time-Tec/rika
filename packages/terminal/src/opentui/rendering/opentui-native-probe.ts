import { OptimizedBuffer } from "@opentui/core"

export const probeNativeAsset = (): string => {
  const buffer = OptimizedBuffer.create(1, 1, "wcwidth")
  buffer.destroy()
  return "RIKA_OPENTUI_NATIVE_OK"
}
