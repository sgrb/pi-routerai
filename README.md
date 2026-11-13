# pi-routerai

Pi extension for [RouterAI](https://routerai.ru) — an OpenAI-compatible LLM
aggregator. It registers the RouterAI provider with a live model catalog and
shows your account balance in the footer.

**Currency: rubles.** RouterAI prices and the balance are in RUB. This extension
never converts to USD: `cost.input`/`cost.output` are the rates RouterAI reports,
scaled from per-token to Pi's per-million-token convention. Pi's footer prints a
hardcoded `$` before the session cost, so the label is cosmetic — the number is
rubles.

## Install

```bash
pi --extension /path/to/pi-routerai
```

Or add it as a package to `~/.pi/agent/settings.json`:

```json
{ "packages": ["/path/to/pi-routerai"] }
```

## Authentication

Store a key once with `/login routerai`, or set it in the environment:

```bash
export ROUTERAI_API_KEY=sk-...
```

Endpoints accept any key created in RouterAI → Settings → API keys. Optional
override for proxies or regional endpoints:

```bash
export ROUTERAI_BASE_URL=https://routerai.ru/api/v1
```

## What it does

### Model catalog

`GET /v1/models` is fetched on first use and cached for 6 hours in
`models-store.json`. Of RouterAI's ~600 entries only models Pi can actually drive
are registered: text in, text out, and `tools` in `supported_parameters`. That
currently yields ~297 chat models.

Per model it maps:

| RouterAI | Pi |
|---|---|
| `context_length` | `contextWindow` |
| `architecture.input_modalities` | `input` (`text`, `image`) |
| `supported_parameters` ∋ `reasoning` | `reasoning` |
| `supported_parameters` ∋ `reasoning_effort` | selectable thinking levels |
| `pricing.prompt` (RUB/token) | `cost.input` (RUB per 1M tokens) |
| `pricing.completion` | `cost.output` |
| `pricing.input_cache_read` / `input_cache_write` | `cost.cacheRead` / `cost.cacheWrite` |

A model that reasons but exposes no `reasoning_effort` gets every level except
`off` marked unsupported, so Pi never sends a field the server ignores.

Prices with a non-token unit (`request`, `second`, `image`) are reported as zero
rather than as a misleading rate.

### Provider selection (`@tag` aliases)

RouterAI balances each model across several upstream providers and lets a request
pin one with a `provider` object. This extension exposes that as a model id suffix:

```
routerai/deepseek/deepseek-chat@deepinfra
routerai/deepseek/deepseek-chat@groq
routerai/deepseek/deepseek-chat            ← RouterAI picks (load + price)
```

Aliases are created only for models served by **two or more live providers**
(`status === 0`). About 1,175 aliases are generated across the catalog, so the
usual `/model` search, scoping and cycling all work unchanged.

Each alias carries the provider's own price, context window and output cap — a
provider that caps output at 4K reports 4K, not the catalog's default. Aliases are
sorted by input price, so the cheapest provider appears first.

`/model` renders the selected entry's `name`, so every model and alias shows its
details line there:

```
DeepInfra · ₽3.24/₽15.10 за 1M · 131K ctx · us
```

`@tag` ids do not exist upstream, so the extension rewrites the request through
`samplingParams`: `model` becomes the plain id and `provider.only` pins the
provider. `samplingParams` is merged last into the request body, which also covers
compaction and cache-warming requests that never pass through Pi's
`before_provider_request` hook.

Trade-off: alias metadata is a snapshot from the last catalog refresh (6-hour
cache). Prices and availability on RouterAI change faster than that; run
`pi update --models` or delete `models-store.json` to refresh.

### Balance status

`GET /v1/credits` is polled on session start, after each settled turn, and every
5 minutes. The balance appears as an extra footer status line in rubles, e.g.
`₽52.75`. A failed request keeps the last good value instead of blanking it.

### `/routerai` command

Prints the balance, the key's name and cumulative/monthly usage, and how many
models are loaded.

## Notes

- Prices are RouterAI's list prices. RouterAI bills through upstream providers,
  so per-request routing (priority, flex) can differ from the catalog rate.
- `maxTokens` is capped at 16384 to stay well inside every model's window;
  RouterAI rejects a `max_tokens` value that exceeds the model's context length.
- Another extension registering the same provider id wins if it loads later. If
  you see 128K/4096 limits and zero prices, something else owns `routerai`:
  remove it from `~/.pi/agent/custom-providers.json` and from `packages` in
  `~/.pi/agent/settings.json`. A catalog with zero prices is detected as
  placeholder metadata and replaced on the next refresh.

## Development

```bash
npm test          # pure mapping and API-envelope unit tests
pi --extension ./index.ts --list-models
pi --extension ./index.ts --provider routerai --model openai/gpt-oss-20b -p "hi"
```