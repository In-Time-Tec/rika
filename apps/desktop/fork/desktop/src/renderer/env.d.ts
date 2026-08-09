import type { ElectronAPI } from "../preload/types"

declare global {
  interface Window {
    api: ElectronAPI
    __RIKA__?: {
      deepLinks?: string[]
    }
  }
}
