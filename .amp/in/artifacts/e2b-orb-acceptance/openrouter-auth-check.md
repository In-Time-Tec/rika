# OpenRouter authentication check

The fresh secret-backed Amp orb contained `OPENROUTER_API_KEY`. A direct request using only model
`z-ai/glm-5.3-flash` returned:

```text
HTTP 401
API key expired.
```

Two process restarts did not refresh the injected secret. No key value, length, digest,
fingerprint, or authorization header is retained in this artifact.
