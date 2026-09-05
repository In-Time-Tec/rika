import type { ConfigurationSettings } from "./model"
import { builtInAliases } from "../model-routing/model-preset"
import { globalDirectory, workspaceDirectory } from "../path-resolution/configuration-paths"

export const providerDefaults = {
  openai: {
    protocol: "openai-responses",
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
  openrouter: {
    protocol: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    credentialIdentity: "openrouter",
  },
} as const

export const defaultCompaction = {
  contextWindow: 272_000,
  reserveTokens: 13_600,
  keepRecentTokens: 32_000,
}

export const settingsDefaults: ConfigurationSettings = {
  providers: providerDefaults,
  models: builtInAliases,
  defaultMode: "medium",
  modes: {
    low: {
      main: { alias: "luna", effort: "xhigh" },
      oracle: { alias: "terra", effort: "xhigh" },
      agents: {},
    },
    medium: {
      main: { alias: "terra", effort: "xhigh" },
      oracle: { alias: "sol", effort: "medium" },
      agents: {},
    },
    high: {
      main: { alias: "astra", effort: "medium" },
      oracle: { alias: "astra", effort: "high" },
      agents: {},
    },
    ultra: {
      main: { alias: "astra", effort: "xhigh" },
      oracle: { alias: "astra", effort: "max" },
      agents: {},
    },
  },
  threadTitle: { alias: "luna", effort: "low" },
  compaction: { summaryModel: { alias: "sol", effort: "xhigh" } },
  subagents: { maxDepth: 1, maxSubagents: 4 },
  keymap: { mode: "ctrl+s", palette: "ctrl+p", submit: "enter", newline: "shift+enter", interrupt: "escape" },
  extensionRoots: [`~/${globalDirectory}/extensions`, `${workspaceDirectory}/extensions`],
  mcp: {},
  notifications: { enabled: true },
  logging: { level: "info" },
  webSearch: { providers: {} },
}

export const defaults = settingsDefaults
