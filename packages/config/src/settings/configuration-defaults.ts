import type { ConfigurationSettings } from "./configuration-settings"
import { defaults as modelDefaults } from "../model-routing/model-preset"
import { globalDirectory, workspaceDirectory } from "../path-resolution/configuration-paths"

export const providerDefaults = {
  openai: {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  bedrock: {
    protocol: "amazon-bedrock",
    authMode: "default",
  },
} as const

export const defaultCompaction = {
  contextWindow: 272_000,
  reserveTokens: 13_600,
  keepRecentTokens: 32_000,
}

export const settingsDefaults: ConfigurationSettings = {
  providers: providerDefaults,
  models: modelDefaults,
  modes: {
    low: { main: { alias: "luna", effort: "xhigh" }, oracle: { alias: "terra", effort: "xhigh" } },
    medium: { main: { alias: "terra", effort: "xhigh" }, oracle: { alias: "sol", effort: "medium" } },
    high: { main: { alias: "sol", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
    ultra: { main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "sol", effort: "max" } },
  },
  threadTitle: { alias: "luna", effort: "low" },
  agents: {},
  compaction: { summaryModel: { alias: "sol", effort: "xhigh" } },
  keymap: { mode: "ctrl+s", palette: "ctrl+p", submit: "enter", newline: "shift+enter", interrupt: "escape" },
  extensionRoots: [`~/${globalDirectory}/extensions`, `${workspaceDirectory}/extensions`],
  mcp: {},
  notifications: { enabled: true },
  logging: { level: "info" },
  webSearch: { providers: {} },
}

export const defaults = settingsDefaults
