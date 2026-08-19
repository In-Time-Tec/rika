# Provider connection configuration

The first-class model providers are `openai`, `anthropic`, `openrouter`, and `bedrock`. HTTP providers accept a non-secret `baseUrl` and `apiKeyEnv`. A Workspace HTTP provider entry replaces the matching global entry as a unit, with omitted fields falling back to that provider's built-in connection. Bedrock's non-secret identity fields merge by scope so a Workspace can replace only its region, profile, endpoint, auth mode, or refresh command.

OpenAI additionally accepts `api: "responses"` or `api: "chat-completions"`. Responses is the default and uses Baton's OpenAI Responses adapter. Chat Completions uses Baton's OpenAI Chat Completions adapter and appends the compatible Chat Completions route beneath the configured base URL. Either API accepts an arbitrary compatible base URL. `baseUrl` must be an absolute HTTP or HTTPS URL without query parameters, fragments, or embedded credentials, and `apiKeyEnv` must name an uppercase environment variable. Literal keys, tokens, protocol strings, and custom provider IDs are rejected.

```json
{
  "providers": {
    "openai": {
      "api": "chat-completions",
      "baseUrl": "https://models.example/openai/v1",
      "apiKeyEnv": "MODELS_API_KEY"
    },
    "openrouter": { "apiKeyEnv": "OPENROUTER_API_KEY" }
  }
}
```

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
  "defaultMode": "aws-opus",
  "modes": {
    "aws-opus": {
      "main": {
        "provider": "bedrock",
        "model": "us.anthropic.claude-opus-4-1-20250805-v1:0",
        "effort": "high"
      },
      "agents": {
        "task": {
          "provider": "bedrock",
          "model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
          "effort": "medium"
        }
      }
    }
  }
}
```
