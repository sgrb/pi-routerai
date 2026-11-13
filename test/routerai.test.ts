import assert from "node:assert/strict";
import test from "node:test";

import {
	fetchCatalog,
	fetchCredits,
	isChatModel,
	toPiModel,
	toPiModels,
	toProviderAliases,
	type RouterAIEndpoint,
	type RouterAIModel,
} from "../src/routerai.ts";

const baseUrl = "https://routerai.ru/api/v1";

function model(overrides: Partial<RouterAIModel> = {}): RouterAIModel {
	return {
		id: "vendor/chat-1",
		name: "Vendor Chat 1",
		context_length: 200_000,
		architecture: {
			input_modalities: ["text"],
			output_modalities: ["text"],
		},
		pricing: { prompt: 0.0000001, completion: 0.0000004, input_cache_read: 0.00000001 },
		pricing_units: { prompt: "token", completion: "token", input_cache_read: "token" },
		supported_parameters: ["tools", "temperature"],
		...overrides,
	};
}

test("converts per-token ruble prices to per-million-token rates", () => {
	const mapped = toPiModel(model(), { baseUrl });
	assert.ok(mapped);
	// 1e-7 RUB/token -> 0.1 RUB per million tokens. No currency conversion happens.
	// Floating point: compare within 1e-12 instead of exact equality.
	assert.ok(Math.abs(mapped.cost.input - 0.1) < 1e-12);
	assert.ok(Math.abs(mapped.cost.output - 0.4) < 1e-12);
	assert.ok(Math.abs(mapped.cost.cacheRead - 0.01) < 1e-12);
	assert.equal(mapped.cost.cacheWrite, 0);
});

test("ignores prices whose unit is not per token", () => {
	const mapped = toPiModel(
		model({
			pricing: { prompt: 5, completion: 9, web_search: 2 },
			pricing_units: { prompt: "request", completion: "request", web_search: "request" },
		}),
		{ baseUrl },
	);
	assert.ok(mapped);
	assert.deepEqual(mapped.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("keeps image input when the catalog advertises it", () => {
	const mapped = toPiModel(
		model({ architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] } }),
		{ baseUrl },
	);
	assert.ok(mapped);
	assert.deepEqual(mapped.input, ["text", "image"]);
});

test("drops models Pi cannot drive through chat completions", () => {
	assert.equal(isChatModel(model({ architecture: { input_modalities: ["text"], output_modalities: ["image"] } })), false);
	assert.equal(isChatModel(model({ architecture: { input_modalities: ["audio"], output_modalities: ["text"] } })), false);
	assert.equal(
		isChatModel(model({ supported_parameters: ["temperature"] })),
		false,
		"models without tool calling are useless for the agent loop",
	);
	assert.equal(isChatModel(model()), true);
});

test("reasoning support follows supported_parameters", () => {
	const effort = toPiModel(model({ supported_parameters: ["tools", "reasoning", "reasoning_effort"] }), { baseUrl });
	assert.ok(effort);
	assert.equal(effort.reasoning, true);
	assert.equal(effort.thinkingLevelMap, undefined);

	const noEffort = toPiModel(model({ supported_parameters: ["tools", "reasoning"] }), { baseUrl });
	assert.ok(noEffort);
	assert.equal(noEffort.reasoning, true);
	// Only "off" stays selectable, so Pi never sends an unsupported reasoning_effort.
	assert.equal(noEffort.thinkingLevelMap?.high, null);

	const none = toPiModel(model({ supported_parameters: ["tools"] }), { baseUrl });
	assert.ok(none);
	assert.equal(none.reasoning, false);
});

test("keeps the output budget inside the context window", () => {
	const tiny = toPiModel(model({ context_length: 2_000 }), { baseUrl });
	assert.ok(tiny);
	assert.equal(tiny.maxTokens, 2_000);

	const big = toPiModel(model({ context_length: 1_050_000 }), { baseUrl });
	assert.ok(big);
	assert.equal(big.maxTokens, 16_384);

	const unknown = toPiModel(model({ context_length: undefined }), { baseUrl });
	assert.ok(unknown);
	assert.equal(unknown.contextWindow, 128_000);
});

test("maps the whole catalog, deduplicated and sorted", () => {
	const models = toPiModels(
		[
			model({ id: "z/last" }),
			model({ id: "a/first" }),
			model({ id: "a/first" }),
			model({ id: "embed/only", architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] } }),
		],
		{ baseUrl },
	);
	assert.deepEqual(
		models.map((entry) => entry.id),
		["a/first", "z/last"],
	);
});

test("uses the entry id when the catalog has no display name", () => {
	const mapped = toPiModel(model({ name: "   " }), { baseUrl });
	assert.ok(mapped);
	assert.equal(mapped.name, "vendor/chat-1");
});

test("network calls hit the documented endpoints and parse envelopes", async () => {
	const calls: { url: string; authorization: string | null }[] = [];
	const originalFetch = globalThis.fetch;
	// SAFETY: the test stub only needs to satisfy the fields getJson reads.
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		calls.push({ url, authorization: headers.get("authorization") });
		const payload = url.endsWith("/models")
			? { data: [{ id: "vendor/chat-1", supported_parameters: ["tools"] }, { notAnId: true }] }
			: { data: { credits: 86.446 } };
		return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	try {
		assert.deepEqual(await fetchCredits(baseUrl, "secret-key"), 86.446);
		assert.equal(calls[0]?.url, "https://routerai.ru/api/v1/credits");
		assert.equal(calls[0]?.authorization, "Bearer secret-key");

		const catalog = await fetchCatalog(`${baseUrl}/`);
		assert.deepEqual(
			catalog.map((entry) => entry.id),
			["vendor/chat-1"],
			"entries without an id are dropped",
		);
		assert.equal(calls[1]?.url, "https://routerai.ru/api/v1/models");
		assert.equal(calls[1]?.authorization, null, "the catalog endpoint needs no key");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("surfaces HTTP failures instead of silently returning nothing", async () => {
	const originalFetch = globalThis.fetch;
	// SAFETY: the test stub only needs to satisfy the fields getJson reads.
	globalThis.fetch = (async () =>
		new Response("unauthorized", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
	try {
		await assert.rejects(() => fetchCredits(baseUrl, "bad-key"), /401/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
// ── Provider aliases ─────────────────────────────────────────────────────────

function endpoint(overrides: Partial<RouterAIEndpoint> = {}): RouterAIEndpoint {
	return {
		tag: "groq",
		provider_name: "Groq",
		status: 0,
		context_length: 131_072,
		max_completion_tokens: 32_768,
		pricing: { prompt: 0.0000008, completion: 0.0000032 },
		pricing_units: { prompt: "token", completion: "token" },
		...overrides,
	};
}

test("creates one alias per serving provider with that provider's price", () => {
	const aliases = toProviderAliases(model(), [endpoint(), endpoint({ tag: "deepinfra", provider_name: "DeepInfra" })], {
		baseUrl,
	});
	assert.equal(aliases.length, 2);
	const groq = aliases.find((entry) => entry.id.endsWith("@groq"));
	assert.ok(groq);
	assert.equal(groq.id, "vendor/chat-1@groq");
	assert.ok(Math.abs(groq.cost.input - 0.8) < 1e-12, "0.8 RUB per 1M");
	assert.ok(Math.abs(groq.cost.output - 3.2) < 1e-12);
});

test("alias keeps the base model id and pins the provider in samplingParams", () => {
	const [alias] = toProviderAliases(model(), [endpoint(), endpoint({ tag: "other" })], { baseUrl });
	assert.ok(alias);
	// RouterAI does not know the `@tag` id, so the request must be rewritten.
	assert.deepEqual(alias.samplingParams, {
		model: "vendor/chat-1",
		provider: { only: ["groq"] },
	});
});

test("alias name carries provider, ruble price, context and country for /model", () => {
	const [alias] = toProviderAliases(model(), [endpoint({ countries: ["us"] }), endpoint({ tag: "other" })], {
		baseUrl,
	});
	assert.ok(alias);
	assert.match(alias.name, /Groq/);
	assert.match(alias.name, /₽0\.800\/₽3\.20/);
	assert.match(alias.name, /131K ctx/);
	assert.match(alias.name, /us/);
});

test("skips aliases when only one provider serves the model", () => {
	assert.deepEqual(toProviderAliases(model(), [endpoint()], { baseUrl }), []);
	assert.deepEqual(toProviderAliases(model(), [], { baseUrl }), []);
});

test("skips providers RouterAI is not serving", () => {
	// Two providers, one of them down: only one is a real choice, so RouterAI's
	// default routing already lands there and an alias would just be noise.
	const oneServing = toProviderAliases(
		model(),
		[endpoint(), endpoint({ tag: "siliconflow", status: -2 })],
		{ baseUrl },
	);
	assert.deepEqual(oneServing, []);

	// A down provider must never be offered even when others are fine.
	const mixed = toProviderAliases(
		model(),
		[endpoint(), endpoint({ tag: "groq-b" }), endpoint({ tag: "siliconflow", status: -2 })],
		{ baseUrl },
	);
	assert.deepEqual(
		mixed.map((entry) => entry.id),
		["vendor/chat-1@groq", "vendor/chat-1@groq-b"],
	);
	assert.ok(!mixed.some((entry) => entry.id.includes("siliconflow")));
});

test("uses the provider's own limits instead of the catalog defaults", () => {
	const [alias] = toProviderAliases(
		model(),
		[endpoint({ context_length: 32_768, max_completion_tokens: 4_096 }), endpoint({ tag: "other" })],
		{ baseUrl },
	);
	assert.ok(alias);
	assert.equal(alias.contextWindow, 32_768);
	assert.equal(alias.maxTokens, 4_096, "a provider capping output at 4k must not get 16k");
});

test("aliases are ordered by input price so cheap providers come first", () => {
	const aliases = toProviderAliases(
		model(),
		[
			endpoint({ tag: "pricey", pricing: { prompt: 0.000009, completion: 0.000009 }, pricing_units: { prompt: "token", completion: "token" } }),
			endpoint({ tag: "cheap", pricing: { prompt: 0.0000001, completion: 0.0000002 }, pricing_units: { prompt: "token", completion: "token" } }),
		],
		{ baseUrl },
	);
	assert.deepEqual(
		aliases.map((entry) => entry.id),
		["vendor/chat-1@cheap", "vendor/chat-1@pricey"],
	);
});

test("catalog mapping adds aliases only for models with endpoints", () => {
	const withEndpoints = toPiModels([model()], {
		baseUrl,
		endpoints: new Map([["vendor/chat-1", [endpoint(), endpoint({ tag: "other" })]]]),
	});
	assert.equal(withEndpoints.length, 3, "one base model plus two aliases");
	assert.ok(withEndpoints[0]?.name.includes("₽"), "the base entry also gets the price line");

	const withoutEndpoints = toPiModels([model()], { baseUrl });
	assert.equal(withoutEndpoints.length, 1);
});
