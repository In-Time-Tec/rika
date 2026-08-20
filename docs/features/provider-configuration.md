# Provider connection configuration

The first-class model providers are `openai`, `anthropic`, `openrouter`, and `bedrock`. Model routes and non-secret provider settings may be defined locally or by the hosted API. HTTP providers accept a non-secret `baseUrl` and `apiKeyEnv`. A Workspace HTTP provider entry replaces the matching global entry as a unit, with omitted fields falling back to that provider's built-in connection. Bedrock's non-secret identity fields merge by scope.

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

Credentials have one explicit scope: `local`, `user`, or `organization`. Local credentials stay in the operating-system credential store and are usable only by that device. Hosted credential read APIs return metadata, never secret material. A hosted credential is envelope-encrypted with a fresh AWS KMS data key and AES-256-GCM. Its authenticated data binds credential identity, owner, provider, and revision. Railway stores only ciphertext and the wrapped data key; plaintext and plaintext data keys remain operation-scoped and redacted. Revocation prevents new decrypts and interrupts dependent model fibers but cannot claw back a request already sent to a provider.

A user credential may serve an Organization Thread only through an explicit Thread binding by its owner. That binding records consent for eligible controllers and is visible in audit history. An Organization owner or admin manages Organization credentials, and a Project operator may bind one to a Thread. Membership removal deletes that member's grants and bindings. Executors receive only short-lived assignment-scoped grants and never store hosted credentials in checkpoints, metadata, process arguments, or logs.

Provider account login is separate from Rika account login. Human identity uses `rika auth`; provider secrets use `rika credential`. GitHub sign-in is also separate from the repository GitHub App, whose installation tokens are minted on demand and scoped to one repository and the required permissions.

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
