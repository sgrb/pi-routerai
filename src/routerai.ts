/**
 * RouterAI API client and catalog mapping.
 *
 * RouterAI (https://routerai.ru) is an OpenAI-compatible aggregator. It exposes:
 *   GET /v1/models              — full catalog (no auth)
 *   GET /v1/credits             — account balance (Bearer)
 *   GET /v1/key                 — key usage/limits (Bearer)
 *
 * All prices and the balance are denominated in RUB (rubles). RouterAI reports
 * per-token prices, Pi expects per-million-token rates, so the mapping only
 * scales by 1e6 — no currency conversion ever happens here.
 */

export const PROVIDER_ID = "routerai";
export const PROVIDER_NAME = "RouterAI";
export const DEFAULT_BASE_URL = "https://routerai.ru/api/v1";

/** How long a persisted catalog is considered fresh. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Suffix that pins an alias to one RouterAI upstream provider, e.g.
 * `deepseek/deepseek-chat@groq`. RouterAI has no such model id; the alias is
 * Pi-only, and `samplingParams` rewrites `model` back and adds `provider.only`.
 */
export const ALIAS_SEPARATOR = "@";

const REQUEST_TIMEOUT_MS = 20_000;

export interface RouterAIModel {
	id: string;
	name?: string;
	created?: number;
	context_length?: number;
	architecture?: {
		modality?: string;
		tokenizer?: string;
		instruct_type?: string | null;
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: Record<string, number>;
	pricing_units?: Record<string, string>;
	per_request_limits?: unknown;
	supported_parameters?: string[];
	default_parameters?: Record<string, unknown>;
}

/** One upstream provider behind a RouterAI model, from `GET /v1/models/{a}/{m}/endpoints`. */
export interface RouterAIEndpoint {
	/** Lowercase provider id used in the request `provider` object, e.g. "groq". */
	tag: string;
	provider_name?: string;
	countries?: string[];
	context_length?: number;
	max_completion_tokens?: number;
	/** 0 = serving; negative values mark a provider RouterAI currently avoids. */
	status?: number;
	pricing?: Record<string, number>;
	pricing_units?: Record<string, string>;
}

export interface RouterAIKeyInfo {
	name?: string;
	usage?: number;
	limit?: number;
	limitReset?: string;
	limitRemaining?: number;
	usageMonthly?: number;
	disabled?: boolean;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { ...init, signal: timeoutSignal(signal) });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const detail = body.trim().slice(0, 200);
		throw new Error(`RouterAI request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
	}
	return response.json();
}

export async function fetchCatalog(baseUrl: string, signal?: AbortSignal): Promise<RouterAIModel[]> {
	const body = (await getJson(
		`${normalizeBaseUrl(baseUrl)}/models`,
		{ headers: { accept: "application/json" } },
		signal,
	)) as { data?: unknown };
	if (!Array.isArray(body?.data)) throw new Error("Invalid RouterAI model list response");
	return body.data.filter(
		(entry): entry is RouterAIModel =>
			typeof entry === "object" && entry !== null && typeof (entry as RouterAIModel).id === "string",
	);
}

/**
 * Providers serving one model, from `GET /v1/models/{author}/{model}/endpoints`.
 * RouterAI splits the id on the first slash; a slash inside the model part stays.
 */
export async function fetchEndpoints(
	baseUrl: string,
	modelId: string,
	signal?: AbortSignal,
): Promise<RouterAIEndpoint[]> {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return [];
	const path = `${modelId.slice(0, slash)}/${modelId.slice(slash + 1)}`;
	const body = (await getJson(
		`${normalizeBaseUrl(baseUrl)}/models/${path}/endpoints`,
		{ headers: { accept: "application/json" } },
		signal,
	)) as { data?: { endpoints?: unknown } };
	const endpoints = body?.data?.endpoints;
	if (!Array.isArray(endpoints)) return [];
	return endpoints.filter(
		(entry): entry is RouterAIEndpoint =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as RouterAIEndpoint).tag === "string" &&
			(entry as RouterAIEndpoint).tag.length > 0,
	);
}

/** Account balance in RUB. */
export async function fetchCredits(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<number> {
	const body = (await getJson(
		`${normalizeBaseUrl(baseUrl)}/credits`,
		{ headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } },
		signal,
	)) as { data?: { credits?: unknown } };
	const credits = body?.data?.credits;
	if (typeof credits !== "number" || !Number.isFinite(credits)) {
		throw new Error("Invalid RouterAI credits response");
	}
	return credits;
}

export async function fetchKeyInfo(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<RouterAIKeyInfo> {
	const body = (await getJson(
		`${normalizeBaseUrl(baseUrl)}/key`,
		{ headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } },
		signal,
	)) as { data?: Record<string, unknown> };
	const data = body?.data ?? {};
	const num = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	return {
		name: typeof data.name === "string" ? data.name : undefined,
		usage: num(data.usage),
		limit: num(data.limit),
		limitReset: typeof data.limit_reset === "string" ? data.limit_reset : undefined,
		limitRemaining: num(data.limit_remaining),
		usageMonthly: num(data.usage_monthly),
		disabled: data.disabled === true,
	};
}

/** Minimum output budget we report; Pi never sends it unless configured. */
const DEFAULT_MAX_OUTPUT = 16_384;

function contextWindowOf(model: RouterAIModel): number {
	const reported = model.context_length;
	// Some catalog entries omit the limit; 128k is the safest common denominator.
	if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return 128_000;
	return Math.floor(reported);
}

function perMillionRate(model: RouterAIModel, key: string): number {
	const unit = model.pricing_units?.[key];
	if (unit !== "token") return 0;
	const value = model.pricing?.[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	// RouterAI price per token in RUB -> Pi cost per million tokens in RUB.
	return value * 1_000_000;
}

/**
 * Chat/coding usable models only: text in, text out, and tool calling.
 * RouterAI also serves image/audio/embedding/rerank models that Pi cannot drive
 * through the chat completions API.
 */
export function isChatModel(model: RouterAIModel): boolean {
	const architecture = model.architecture ?? {};
	const inputs = architecture.input_modalities ?? [];
	const outputs = architecture.output_modalities ?? ["text"];
	const parameters = model.supported_parameters ?? [];
	if (!outputs.includes("text")) return false;
	if (!inputs.includes("text")) return false;
	if (!parameters.includes("tools")) return false;
	return true;
}

export interface PiChatModel {
	type?: "chat";
	id: string;
	name: string;
	api: "openai-completions";
	provider: string;
	baseUrl: string;
	input: ("text" | "image")[];
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	/** Merged into the request body last, so it can rewrite `model` and add `provider`. */
	samplingParams?: Record<string, unknown>;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** Convert one RouterAI catalog entry into a Pi chat model. Returns undefined when unusable. */
export function toPiModel(
	model: RouterAIModel,
	options: { provider?: string; baseUrl: string },
): PiChatModel | undefined {
	if (!isChatModel(model)) return undefined;

	const parameters = model.supported_parameters ?? [];
	const inputs = model.architecture?.input_modalities ?? ["text"];
	const input: ("text" | "image")[] = ["text"];
	if (inputs.includes("image")) input.push("image");

	const supportsReasoning = parameters.includes("reasoning") || parameters.includes("reasoning_effort");
	const supportsEffort = parameters.includes("reasoning_effort");
	// Models that reason but expose no effort knob: keep only "off" selectable so Pi
	// does not send a reasoning_effort field the model ignores or rejects.
	const thinkingLevelMap = supportsReasoning && !supportsEffort
		? { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null }
		: undefined;

	const contextWindow = contextWindowOf(model);
	const maxTokens = Math.min(DEFAULT_MAX_OUTPUT, contextWindow);

	return {
		type: "chat",
		id: model.id,
		name: model.name?.trim() || model.id,
		api: "openai-completions",
		provider: options.provider ?? PROVIDER_ID,
		baseUrl: normalizeBaseUrl(options.baseUrl),
		input,
		reasoning: supportsReasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		cost: {
			input: perMillionRate(model, "prompt"),
			output: perMillionRate(model, "completion"),
			cacheRead: perMillionRate(model, "input_cache_read"),
			cacheWrite: perMillionRate(model, "input_cache_write"),
		},
		contextWindow,
		maxTokens,
	};
}

/** Human-friendly RUB rate for the model details line in `/model`. */
function formatRub(amount: number): string {
	if (amount === 0) return "0";
	if (amount >= 100) return amount.toFixed(0);
	if (amount >= 1) return amount.toFixed(2);
	if (amount >= 0.01) return amount.toFixed(3);
	return amount.toPrecision(2);
}

const MODALITY_LABELS: Record<string, string> = {
	text: "text",
	image: "img",
	file: "file",
	audio: "audio",
	video: "video",
};

/**
 * The details line Pi renders under the selected entry in `/model`. Pi shows
 * `model.name` verbatim, so this is the only place to surface price and limits.
 */
export function describeModel(input: {
	name?: string;
	cost: { input: number; output: number };
	contextWindow: number;
	input_modalities?: string[];
	provider_label?: string;
	countries?: string[];
}): string {
	const parts: string[] = [];
	if (input.name) parts.push(input.name);
	if (input.provider_label) parts.push(input.provider_label);
	parts.push(`₽${formatRub(input.cost.input)}/₽${formatRub(input.cost.output)} за 1M`);
	parts.push(`${Math.round(input.contextWindow / 1000)}K ctx`);
	const modalities = (input.input_modalities ?? ["text"])
		.map((modality) => MODALITY_LABELS[modality] ?? modality)
		.filter((modality, index, all) => all.indexOf(modality) === index);
	if (modalities.length > 1) parts.push(modalities.join("+"));
	if (input.countries && input.countries.length > 0) parts.push(input.countries.join(","));
	return parts.join(" · ");
}

/** Providers RouterAI is currently serving; negative status marks avoided ones. */
export function isServingEndpoint(endpoint: RouterAIEndpoint): boolean {
	return endpoint.status === undefined || endpoint.status === 0;
}

function providerLabel(endpoint: RouterAIEndpoint): string {
	return endpoint.provider_name?.trim() || endpoint.tag;
}

/**
 * Build one Pi model per serving upstream provider, pinned with an `@tag` suffix.
 * RouterAI would reject that id, so `samplingParams` rewrites `model` back to the
 * plain id and adds `provider.only`. `samplingParams` is merged last into the
 * request body, which also covers compaction and cache-warming requests that
 * never pass through the `before_provider_request` hook.
 */
export function toProviderAliases(
	model: RouterAIModel,
	endpoints: readonly RouterAIEndpoint[],
	options: { provider?: string; baseUrl: string },
): PiChatModel[] {
	const base = toPiModel(model, options);
	if (!base) return [];
	const serving = endpoints.filter(isServingEndpoint);
	// A single provider is what RouterAI picks anyway; an alias would only add noise.
	if (serving.length < 2) return [];

	const aliases: PiChatModel[] = [];
	for (const endpoint of serving) {
		const prompt = perMillionRate({ ...model, pricing: endpoint.pricing, pricing_units: endpoint.pricing_units }, "prompt");
		const completion = perMillionRate(
			{ ...model, pricing: endpoint.pricing, pricing_units: endpoint.pricing_units },
			"completion",
		);
		const cacheRead = perMillionRate(
			{ ...model, pricing: endpoint.pricing, pricing_units: endpoint.pricing_units },
			"input_cache_read",
		);
		const cacheWrite = perMillionRate(
			{ ...model, pricing: endpoint.pricing, pricing_units: endpoint.pricing_units },
			"input_cache_write",
		);
		// Prefer the endpoint's own limit: providers differ (some cap output at 4k).
		const contextWindow = Math.max(
			1,
			Math.floor(endpoint.context_length ?? base.contextWindow),
		);
		const maxTokens = Math.min(
			Math.floor(endpoint.max_completion_tokens ?? base.maxTokens) || base.maxTokens,
			DEFAULT_MAX_OUTPUT,
			contextWindow,
		);
		const cost = { input: prompt, output: completion, cacheRead, cacheWrite };
		const label = providerLabel(endpoint);
		aliases.push({
			...base,
			id: `${model.id}${ALIAS_SEPARATOR}${endpoint.tag}`,
			name: describeModel({
				cost,
				contextWindow,
				input_modalities: model.architecture?.input_modalities,
				provider_label: label,
				countries: endpoint.countries,
			}),
			cost,
			contextWindow,
			maxTokens,
			samplingParams: { model: model.id, provider: { only: [endpoint.tag] } },
		});
	}
	aliases.sort((a, b) => a.cost.input - b.cost.input || a.id.localeCompare(b.id));
	return aliases;
}

/**
 * Map the whole catalog, deduplicated by id and sorted for stable presentation.
 * `endpoints` supplies per-provider prices and limits for the `@tag` aliases.
 */
export function toPiModels(
	catalog: readonly RouterAIModel[],
	options: {
		provider?: string;
		baseUrl: string;
		endpoints?: ReadonlyMap<string, readonly RouterAIEndpoint[]>;
	},
): PiChatModel[] {
	const seen = new Set<string>();
	const models: PiChatModel[] = [];
	for (const entry of catalog) {
		const mapped = toPiModel(entry, options);
		if (!mapped) continue;
		if (!seen.has(mapped.id)) {
			seen.add(mapped.id);
			models.push({
				...mapped,
				name: describeModel({
					name: mapped.name,
					cost: mapped.cost,
					contextWindow: mapped.contextWindow,
					input_modalities: entry.architecture?.input_modalities,
				}),
			});
		}
		const endpoints = options.endpoints?.get(entry.id);
		if (!endpoints) continue;
		for (const alias of toProviderAliases(entry, endpoints, options)) {
			if (seen.has(alias.id)) continue;
			seen.add(alias.id);
			models.push(alias);
		}
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}
