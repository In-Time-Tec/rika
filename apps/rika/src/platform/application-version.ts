declare const RIKA_VERSION: string | undefined

const readBundledVersion = () => {
  try {
    return RIKA_VERSION
  } catch {
    return undefined
  }
}

export const version = readBundledVersion() ?? "0.0.0"
