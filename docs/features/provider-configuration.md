# Provider connection configuration

The first-class model providers are `openai`, `anthropic`, `openrouter`, and `bedrock`. Model routes and non-secret provider settings may be defined locally or by the hosted API. HTTP providers accept a non-secret `baseUrl` and `apiKeyEnv`. A Workspace HTTP provider entry replaces the matching global entry as a unit, with omitted fields falling back to that provider's built-in connection. Bedrock's non-secret identity fields merge by scope.

Railway owns hosted model routing. Its built-in modes use the OpenAI account connected to the selected Hosted Owner. Local settings affect local configuration only and are never uploaded as hosted authority.

OpenAI additionally accepts `api: "responses"` or `api: "chat-completions"`. Responses is the default and uses TenetKit's OpenAI Responses adapter. Chat Completions uses TenetKit's compatible adapter. `baseUrl` must be an absolute HTTP or HTTPS URL without query parameters, fragments, or embedded credentials, and `apiKeyEnv` must name an uppercase environment variable. Literal keys, tokens, protocol strings, and custom provider IDs are rejected.

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

Model-provider credentials belong to the selected Personal or Organization Hosted Owner. `rika credential` writes, lists, rotates, and revokes API keys through the authenticated Railway API. `rika provider login codex` connects an OpenAI account to that same owner; status and logout also operate on the hosted account. Reads return status and revision metadata, never secret material. An Organization owner or admin manages Organization credentials. Railway encrypts API keys and OpenAI OAuth tokens with AES-256-GCM under a versioned 32-byte root key supplied as a Railway secret. A fresh nonce and authenticated owner/provider identity prevent ciphertext substitution. Rotation preserves the credential identity, replaces the ciphertext, and increments its revision. Revocation clears the ciphertext and prevents new model resources from being constructed.

Railway resolves a Turn's pinned credential identity while constructing its TenetKit model resource. The API stores only ciphertext, refreshes OpenAI OAuth tokens under the selected owner's credential record, and handles plaintext as a redacted operation value. Runner and Orb executors receive neither model-provider values nor references in their environment, assignment bootstrap, tool frames, checkpoints, process arguments, or logs. Revocation cannot claw back a request already sent to a provider.

Provider account login is separate from Rika account login. Human identity uses `rika auth`; API keys use `rika credential`; OpenAI account OAuth uses `rika provider`. GitHub sign-in is also separate from the repository GitHub App, whose installation tokens are minted on demand and scoped to one repository and the required permissions.

Bedrock uses TenetKit's AWS default credential chain, including environment, shared profiles, SSO, roles, web identity, ECS, and EC2 metadata. Bearer mode uses `AWS_BEARER_TOKEN_BEDROCK`. In default auth mode, an optional structured `authRefresh` command is run only after TenetKit classifies an eligible credential rejection; its argv is never persisted or displayed. The command cannot modify Rika's environment, so it should update a shared credential cache, as `aws sso login` does.

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
