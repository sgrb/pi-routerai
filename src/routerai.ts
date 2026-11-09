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

/** Map the whole catalog, deduplicated by id and sorted for stable presentation. */
export function toPiModels(
	catalog: RouterAIModel[],
	options: { provider?: string; baseUrl: string },
): PiChatModel[] {
	const seen = new Set<string>();
	const models: PiChatModel[] = [];
	for (const entry of catalog) {
		const mapped = toPiModel(entry, options);
		if (!mapped || seen.has(mapped.id)) continue;
		seen.add(mapped.id);
		models.push(mapped);
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}