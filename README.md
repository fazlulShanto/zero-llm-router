# zero-llm-router

> Zero-infrastructure LLM request router for the [Vercel AI SDK](https://sdk.vercel.ai) — load balancing, rate-limit tracking, circuit breaking, and automatic fallback across free-tier providers.

```
Request ──▶ Primary (rate-limit OK?) ──▶ ✅ Success
                    │ ❌ No
                    ▼
            Fallback 1 (rate-limit OK?) ──▶ ✅ Success
                    │ ❌ No
                    ▼
            Fallback N … ──▶ ✅ or throw AggregateError
```

## Why?

Free-tier LLM APIs are amazing — but they come with strict limits (tokens/day, requests/minute, random timeouts). If you're juggling Google, OpenAI, Anthropic, and others, you end up writing the same retry/fallback/rate-limit plumbing in every project.

**zero-llm-router** gives you a single `LanguageModelV3` object that handles all of that. Use it exactly like any other AI SDK model — with `generateText()`, `streamText()`, middleware, agents — and the router takes care of the rest.

## Features

- 🔄 **Automatic fallback** — priority-ordered chain of models
- ⏱️ **Rate-limit tracking** — sliding-window counters (req/s, req/min, req/day, tokens/day/week/month)
- 🔌 **Circuit breaker** — skip failing providers, auto-recover after cooldown
- 🔁 **Retries with backoff** — exponential + jitter, per provider
- 💾 **Persistent usage data** — in-memory, JSON file, or Redis
- 📡 **Event system** — observe every routing decision
- 🧩 **AI SDK native** — returns a standard `LanguageModelV3`, works everywhere

## Install

```bash
# npm
npm install zero-llm-router ai @ai-sdk/provider

# pnpm
pnpm add zero-llm-router ai @ai-sdk/provider

# yarn
yarn add zero-llm-router ai @ai-sdk/provider
```

> `ai` and `@ai-sdk/provider` are peer dependencies — install the versions you're already using.

---

## Quick Start

The simplest possible setup — one model, no rate limits, no fallbacks:

```typescript
import { createRouter } from 'zero-llm-router';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const model = createRouter({
  primary: {
    model: openai('gpt-4o-mini'),
  },
});

const { text } = await generateText({
  model,
  prompt: 'What is the meaning of life?',
});

console.log(text);
```

Even in this minimal form you get retry logic and the event system for free. But the real power comes when you add fallbacks and limits.

---

## Examples

### 1. Basic Fallback

When the primary model fails (timeout, 429, server error), the router automatically tries the next one:

```typescript
import { createRouter } from 'zero-llm-router';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
  },
  fallbacks: [
    { model: openai('gpt-4o-mini') },
  ],
});

const { text } = await generateText({ model, prompt: 'Hello!' });
```

### 2. Rate Limits

Define the limits for each provider based on their free tier. The router will **skip** a model if its limits are exhausted and move to the next one — no wasted requests.

```typescript
const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
    limits: {
      requestsPerMinute: 15,
      requestsPerDay: 1500,
      tokensPerDay: 1_000_000,
    },
  },
  fallbacks: [
    {
      model: openai('gpt-4o-mini'),
      limits: {
        requestsPerMinute: 3,
        tokensPerDay: 200_000,
      },
    },
    {
      model: anthropic('claude-3-haiku-20240307'),
      limits: {
        requestsPerDay: 100,
        tokensPerDay: 500_000,
        tokensPerMonth: 10_000_000,
      },
    },
  ],
});
```

Available limit fields:

| Field | Window |
|---|---|
| `requestsPerSecond` | Rolling 1 second |
| `requestsPerMinute` | Rolling 1 minute |
| `requestsPerDay` | Rolling 24 hours |
| `tokensPerDay` | Rolling 24 hours |
| `tokensPerWeek` | Rolling 7 days |
| `tokensPerMonth` | Rolling 30 days |

### 3. Streaming

Works exactly like the AI SDK — because it **is** the AI SDK:

```typescript
import { streamText } from 'ai';

const result = streamText({
  model, // your router
  prompt: 'Write a short poem about TypeScript',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

If the primary model fails during stream **setup**, the router falls back to the next model. Token usage is automatically tracked when the stream finishes.

### 4. Retry Configuration

Control how many times each provider is retried before moving to the next fallback:

```typescript
const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
    limits: { requestsPerMinute: 15 },
  },
  fallbacks: [
    { model: openai('gpt-4o-mini') },
  ],
  retry: {
    maxRetries: 3,           // retry up to 3 times per provider
    initialDelay: 500,       // first retry after 500ms
    backoffMultiplier: 2,    // 500 → 1000 → 2000ms
    jitter: true,            // ±25% randomness to prevent thundering herd
  },
});
```

**Default retry values:** `maxRetries: 1`, `initialDelay: 500`, `backoffMultiplier: 2`, `jitter: true`

### 5. Per-Model Settings

Override model parameters on a per-provider basis. Useful when different models perform best with different temperatures or token limits:

```typescript
const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
    limits: { tokensPerDay: 1_000_000 },
    settings: {
      temperature: 0.7,
      maxOutputTokens: 4096,
      timeout: 10_000, // 10s timeout
    },
  },
  fallbacks: [
    {
      model: openai('gpt-4o-mini'),
      settings: {
        temperature: 0.5,        // different temp for this model
        maxOutputTokens: 2048,
        timeout: 15_000,         // more patient with this provider
      },
    },
  ],
});
```

Settings are merged into each call — your `generateText()` / `streamText()` options still take priority for anything not overridden here.

### 6. Circuit Breaker

If a provider keeps failing, the circuit breaker prevents wasting time on it:

```typescript
const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
  },
  fallbacks: [
    { model: openai('gpt-4o-mini') },
  ],
  circuitBreaker: {
    failureThreshold: 5,   // open circuit after 5 consecutive failures
    cooldownMs: 60_000,    // wait 60s before trying the provider again
  },
});
```

**How it works:**

```
closed ──(5 failures)──▶ open ──(60s cooldown)──▶ half-open
  ▲                                                   │
  └── success ◀───────────────────────────────────────┘
  └── failure ──▶ open (reset cooldown)
```

**Default values:** `failureThreshold: 5`, `cooldownMs: 60_000`

### 7. Event System (Logging & Observability)

Hook into every routing decision for logging, monitoring, or analytics:

```typescript
const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
    limits: { requestsPerMinute: 15, tokensPerDay: 1_000_000 },
  },
  fallbacks: [
    { model: openai('gpt-4o-mini') },
  ],
  onEvent: (event) => {
    switch (event.type) {
      case 'attempt':
        console.log(`⏳ Trying ${event.provider}/${event.modelId}`);
        break;
      case 'success':
        console.log(`✅ ${event.provider}/${event.modelId} — ${event.durationMs}ms, ${event.usage.inputTokens + event.usage.outputTokens} tokens`);
        break;
      case 'error':
        console.error(`❌ ${event.provider}/${event.modelId}:`, event.error);
        break;
      case 'fallback':
        console.warn(`🔄 Falling back: ${event.from} → ${event.to} (${event.reason})`);
        break;
      case 'rate-limited':
        console.warn(`🚫 ${event.provider}/${event.modelId} rate-limited: ${event.limit}`);
        break;
      case 'circuit-open':
        console.warn(`⚡ Circuit open for ${event.provider}/${event.modelId}`);
        break;
    }
  },
});
```

**Event types:**

| Event | When |
|---|---|
| `attempt` | Before each provider call |
| `success` | After a successful response (includes duration & token usage) |
| `error` | After a failed provider call |
| `fallback` | When switching from one model to the next |
| `rate-limited` | When a model is skipped due to rate limits |
| `circuit-open` | When a model is skipped due to circuit breaker |

### 8. Persistent Usage Tracking

By default, usage data lives in memory and is lost when the process restarts. For long-running apps, persist it:

#### JSON File

```typescript
import { createRouter, FileStorage } from 'zero-llm-router';

const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
    limits: { tokensPerDay: 1_000_000 },
  },
  storage: new FileStorage('./data/llm-usage.json'),
});
```

The file is created automatically. Usage data survives restarts — the router picks up right where it left off.

#### Redis

```typescript
import { createRouter, RedisStorage } from 'zero-llm-router';
import Redis from 'ioredis';

const redis = new Redis();

const model = createRouter({
  primary: {
    model: google('gemini-2.0-flash'),
    limits: { tokensPerDay: 1_000_000 },
  },
  storage: new RedisStorage(redis, 'my-app:llm-usage'),
});
```

`RedisStorage` works with any client that has `get(key)` and `set(key, value)` methods — `ioredis`, `redis`, or your own wrapper. Zero hard dependencies.

#### Custom Storage

Implement the `StorageAdapter` interface:

```typescript
import type { StorageAdapter, UsageData } from 'zero-llm-router';

class MyDatabaseStorage implements StorageAdapter {
  async load(): Promise<UsageData> {
    // fetch from your DB
    return {};
  }

  async save(data: UsageData): Promise<void> {
    // write to your DB
  }
}
```

### 9. Same Model, Multiple API Keys

Use the same model through different API keys (e.g. multiple free accounts). Provide an explicit `id` to disambiguate:

```typescript
import { createOpenAI } from '@ai-sdk/openai';

const openaiKey1 = createOpenAI({ apiKey: process.env.OPENAI_KEY_1 });
const openaiKey2 = createOpenAI({ apiKey: process.env.OPENAI_KEY_2 });

const model = createRouter({
  primary: {
    id: 'openai-key1',
    model: openaiKey1('gpt-4o-mini'),
    limits: { tokensPerDay: 200_000 },
  },
  fallbacks: [
    {
      id: 'openai-key2',
      model: openaiKey2('gpt-4o-mini'),
      limits: { tokensPerDay: 200_000 },
    },
  ],
});
```

### 10. OpenAI-Compatible Providers

Works with any provider that uses the `@ai-sdk/openai-compatible` adapter (Groq, Together, Fireworks, local Ollama, etc.):

```typescript
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const groq = createOpenAICompatible({
  name: 'groq',
  baseURL: 'https://api.groq.com/openai/v1',
  headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
});

const together = createOpenAICompatible({
  name: 'together',
  baseURL: 'https://api.together.xyz/v1',
  headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
});

const model = createRouter({
  primary: {
    model: groq('llama-3.3-70b-versatile'),
    limits: { requestsPerMinute: 30, tokensPerDay: 500_000 },
  },
  fallbacks: [
    {
      model: together('meta-llama/Llama-3.3-70B-Instruct-Turbo'),
      limits: { requestsPerMinute: 60 },
    },
    {
      model: google('gemini-2.0-flash'),
      limits: { tokensPerDay: 1_000_000 },
    },
  ],
});
```

### 11. Full Production Config

Putting it all together — a battle-tested setup with multiple providers, rate limits, persistence, circuit breaking, retries, and full observability:

```typescript
import { createRouter, FileStorage } from 'zero-llm-router';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';

const model = createRouter({
  // ── Primary: Google Gemini (generous free tier) ──────────
  primary: {
    model: google('gemini-2.0-flash'),
    limits: {
      requestsPerMinute: 15,
      requestsPerDay: 1500,
      tokensPerDay: 1_000_000,
      tokensPerMonth: 25_000_000,
    },
    settings: {
      temperature: 0.7,
      maxOutputTokens: 8192,
      timeout: 15_000,
    },
  },

  // ── Fallbacks: tried in order ────────────────────────────
  fallbacks: [
    {
      model: openai('gpt-4o-mini'),
      limits: {
        requestsPerMinute: 3,
        requestsPerDay: 200,
        tokensPerDay: 200_000,
      },
      settings: {
        temperature: 0.5,
        timeout: 20_000,
      },
    },
    {
      model: anthropic('claude-3-haiku-20240307'),
      limits: {
        requestsPerMinute: 5,
        requestsPerDay: 100,
        tokensPerDay: 500_000,
        tokensPerMonth: 10_000_000,
      },
      settings: {
        temperature: 0.6,
        timeout: 25_000,
      },
    },
  ],

  // ── Retry: 2 attempts per provider with backoff ──────────
  retry: {
    maxRetries: 2,
    initialDelay: 500,
    backoffMultiplier: 2,
    jitter: true,
  },

  // ── Circuit breaker: open after 5 failures, 2min cooldown ─
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 120_000,
  },

  // ── Persist usage data across restarts ────────────────────
  storage: new FileStorage('./data/llm-usage.json'),

  // ── Observe everything ────────────────────────────────────
  onEvent: (event) => {
    const ts = new Date().toISOString();
    switch (event.type) {
      case 'success':
        console.log(`[${ts}] ✅ ${event.provider}/${event.modelId} ${event.durationMs}ms (${event.usage.inputTokens}+${event.usage.outputTokens} tokens)`);
        break;
      case 'fallback':
        console.warn(`[${ts}] 🔄 ${event.from} → ${event.to} (${event.reason})`);
        break;
      case 'rate-limited':
        console.warn(`[${ts}] 🚫 ${event.provider}/${event.modelId} hit ${event.limit}`);
        break;
      case 'circuit-open':
        console.warn(`[${ts}] ⚡ Circuit open: ${event.provider}/${event.modelId}`);
        break;
      case 'error':
        console.error(`[${ts}] ❌ ${event.provider}/${event.modelId}:`, event.error);
        break;
    }
  },
});

// ── Use it like any AI SDK model ────────────────────────────

// Non-streaming
const { text } = await generateText({
  model,
  prompt: 'Explain quantum entanglement in simple terms',
});

// Streaming
const stream = streamText({
  model,
  prompt: 'Write a haiku about distributed systems',
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

---

## How It Works

```
                    ┌──────────────────────────────┐
                    │       createRouter()          │
                    │  returns LanguageModelV3      │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │     RouterLanguageModel       │
                    │  doGenerate() / doStream()    │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │   Primary       │  │  Fallback 1    │  │  Fallback N    │
     │ Circuit Breaker │  │ Circuit Breaker│  │ Circuit Breaker│
     │ Rate Limiter    │  │ Rate Limiter   │  │ Rate Limiter   │
     │ Retry Logic     │  │ Retry Logic    │  │ Retry Logic    │
     └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
             │                   │                    │
             ▼                   ▼                    ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │  AI SDK Model   │  │  AI SDK Model  │  │  AI SDK Model  │
     │  (any provider) │  │  (any provider)│  │  (any provider)│
     └────────────────┘  └────────────────┘  └────────────────┘
```

For each request:

1. **Check circuit breaker** — is this provider healthy?
2. **Check rate limits** — would this request exceed any sliding-window limit?
3. **Make the call** — with optional timeout and settings overrides
4. **On success** — record usage, reset circuit breaker
5. **On failure** — retry with backoff, then fall to next provider
6. **All exhausted** — throw `AggregateError` with all collected errors

---

## API Reference

### `createRouter(config: RouterConfig): LanguageModelV3`

Creates a routed model. The returned object is a standard `LanguageModelV3` — pass it anywhere a model is expected.

### `RouterConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `primary` | `ModelConfig` | *required* | Primary model configuration |
| `fallbacks` | `ModelConfig[]` | `[]` | Ordered fallback models |
| `retry` | `RetryConfig` | `{ maxRetries: 1, initialDelay: 500, backoffMultiplier: 2, jitter: true }` | Retry settings per provider |
| `circuitBreaker` | `CircuitBreakerConfig` | `{ failureThreshold: 5, cooldownMs: 60000 }` | Circuit breaker settings |
| `storage` | `StorageAdapter` | `MemoryStorage` | Persistence backend for usage data |
| `onEvent` | `(event: RouterEvent) => void` | — | Event callback |

### `ModelConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | `LanguageModelV3` | *required* | AI SDK model instance |
| `limits` | `RateLimits` | — | Rate limits for this model |
| `settings` | `ModelSettings` | — | Per-model overrides (temperature, timeout, etc.) |
| `id` | `string` | `provider:modelId` | Unique tracking ID |

### Storage Adapters

| Adapter | Import | Constructor |
|---|---|---|
| `MemoryStorage` | `zero-llm-router` | `new MemoryStorage()` |
| `FileStorage` | `zero-llm-router` | `new FileStorage(filePath)` |
| `RedisStorage` | `zero-llm-router` | `new RedisStorage(client, key?)` |

---

## License

MIT
