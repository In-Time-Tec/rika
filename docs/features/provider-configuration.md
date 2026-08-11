# Provider connection configuration

Settings may override the built-in `openai` and `anthropic` HTTP connections with `baseUrl` and `apiKeyEnv`, and the built-in `bedrock` connection with non-secret AWS identity fields. A workspace provider entry replaces the matching global provider entry as a unit; omitted values fall back to the built-in connection, not fields from the global override.

`baseUrl` must be an absolute HTTP or HTTPS URL without embedded credentials, and `apiKeyEnv` must name an uppercase environment variable. Literal keys, tokens, protocols, and custom providers are rejected; API-key credentials are read from the named environment variable and configuration output reports only whether they are present.

`rika auth login openai` stores an OpenAI account session under the active Profile. A newly admitted route that uses the built-in OpenAI connection selects that account session and pins its non-secret fingerprint; if no account is stored, the route falls back to `OPENAI_API_KEY`. Baton sends account-backed requests to the Codex subscription endpoint and refreshes rejected credentials without persisting tokens in execution state. A customized OpenAI `baseUrl` always remains an API-key connection and never reads the stored account.

Bedrock uses Baton's AWS default credential chain, including environment, shared profiles, SSO, roles, web identity, ECS, and EC2 metadata. Bearer mode uses `AWS_BEARER_TOKEN_BEDROCK`. In default auth mode, an optional structured `authRefresh` command is run only after Baton classifies an eligible credential rejection; its argv is never persisted or displayed. The command cannot modify Rika's environment, so it should update a shared credential cache, as `aws sso login` does.

```json
{
  "providers": {
    "bedrock": {
      "region": "us-east-1",
      "profile": "engineering",
      "authRefresh": { "command": "aws", "args": ["sso", "login", "--profile", "engineering"] }
    }
  },
  "modelAliases": {
    "bedrock-fable": {
      "base": "fable",
      "provider": "bedrock",
      "candidates": ["us.anthropic.claude-sonnet-4-20250514-v1:0"]
    },
    "bedrock-opus": {
      "base": "opus",
      "provider": "bedrock",
      "candidates": ["us.anthropic.claude-opus-4-1-20250805-v1:0"]
    }
  },
  "modelRoutes": {
    "modes": { "high": { "main": "bedrock-opus", "oracle": "bedrock-opus" } }
  }
}
```
