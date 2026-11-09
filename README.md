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
- If another extension (for example `pi-custom-providers`) also registers a
  `routerai` provider, remove it from `~/.pi/agent/custom-providers.json` — its
  persisted catalog has no prices and 128K/4096 placeholder limits.
  This extension detects such a placeholder catalog and replaces it on the next
  refresh.

## Development

```bash
npm test          # pure mapping and API-envelope unit tests
pi --extension ./index.ts --list-models
pi --extension ./index.ts --provider routerai --model openai/gpt-oss-20b -p "hi"
```