import type { OpenCodeClient } from "@opencode-ai/client/promise"

// The retained client-shaped type is used by the view-store compatibility layer.
// Rika transport is implemented by `@rika/client`; this module intentionally has
// no HTTP client or server runtime.
export type ServerApi = OpenCodeClient
