/**
 * RouterAI provider for Pi.
 *
 * Two things live here:
 *  - a dynamically discovered provider for https://routerai.ru (OpenAI-compatible
 *    chat completions, catalog of ~600 upstream models), with every price kept in
 *    rubles as RouterAI reports it;
 *  - a footer status entry showing the account balance in rubles, polled from
 *    GET /v1/credits.
 *
 * Pi's footer prints a hardcoded `$` before session cost, but the numbers behind
 * it are RouterAI's ruble rates — the unit label is cosmetic only.
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AnyModel, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
	CATALOG_TTL_MS,
	DEFAULT_BASE_URL,
	fetchCatalog,
	fetchCredits,
	fetchEndpoints,
	fetchKeyInfo,
	isChatModel,
	PROVIDER_ID,
	PROVIDER_NAME,
	toPiModels,
	type RouterAIEndpoint,
} from "./src/routerai.ts";

/** Footer status key. Sorted alphabetically by Pi, so keep it stable. */
const STATUS_KEY = "routerai-balance";
const BALANCE_INTERVAL_MS = 5 * 60 * 1000;
/** Parallel `/endpoints` requests during catalog discovery. */
const ENDPOINT_CONCURRENCY = 12;

function baseUrl(): string {
	const configured = process.env.ROUTERAI_BASE_URL?.trim();
	return configured && configured.length > 0 ? configured : DEFAULT_BASE_URL;
}

function formatRubles(value: number): string {
	const abs = Math.abs(value);
	const digits = abs >= 100 ? 0 : 2;
	return `₽${value.toFixed(digits)}`;
}

/** Last known catalog, published synchronously through the provider facade. */
let catalog: ProviderModelConfig[] = [];
/** Starts true so the first refresh may discover the catalog without network permission. */
let discoveryPending = true;
let discovery: Promise<void> | undefined;

function isFresh(checkedAt: number | undefined): boolean {
	if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return false;
	const age = Date.now() - checkedAt;
	return age >= 0 && age < CATALOG_TTL_MS;
}
/**
 * A stored entry with no prices at all came from an integration that only knew
 * model ids, so its context window and output limit are guesses too.
 */
function hasPlaceholderPricing(model: AnyModel): boolean {
	const { input, output, cacheRead, cacheWrite } = model.cost;
	return input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0;
}

function publishModels(context: RefreshModelsContext, models: ProviderModelConfig[]): Promise<boolean> {
	return context.publish({
		persist: { models, checkedAt: Date.now() },
		update: () => {
			catalog = models;
			discoveryPending = false;
		},
	});
}

/**
 * Per-provider prices and limits for every chat model, so `@tag` aliases can carry
 * their own cost. Requests run concurrently; a model whose endpoints call fails is
 * left without aliases instead of dropping it from the catalog.
 */
async function gatherEndpoints(
	models: readonly { id: string }[],
	url: string,
	signal: AbortSignal,
): Promise<Map<string, RouterAIEndpoint[]>> {
	const result = new Map<string, RouterAIEndpoint[]>();
	const queue = [...models];

	const drain = async (): Promise<void> => {
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			if (signal.aborted) return;
			try {
				const endpoints = await fetchEndpoints(url, next.id, signal);
				if (endpoints.length > 0) result.set(next.id, endpoints);
			} catch {
				// One unreachable model must not fail the whole refresh.
			}
		}
	};

	const workerCount = Math.min(ENDPOINT_CONCURRENCY, queue.length);
	await Promise.all(Array.from({ length: workerCount }, drain));
	return result;
}

/**
 * Discovery request. Pi loads extensions with network access disabled so startup
 * never blocks on the network, which leaves `context.allowNetwork` false on the
 * first pass. The RouterAI catalog is public and cheap to fetch, so the first
 * attempt runs anyway and persists its result; later attempts respect the flag.
 */
function startDiscovery(context: RefreshModelsContext, signal: AbortSignal): Promise<void> {
	if (discovery) return discovery;
	const url = context.baseUrl ?? baseUrl();
	discovery = (async () => {
		try {
			const fetched = await fetchCatalog(url, signal);
			const chat = fetched.filter(isChatModel);
			const endpoints = await gatherEndpoints(chat, url, signal);
			const models = toPiModels(fetched, { provider: PROVIDER_ID, baseUrl: url, endpoints });
			if (models.length > 0) await publishModels(context, models);
		} catch {
			// Discovery is opportunistic; a failure keeps the previous catalog.
		} finally {
			discovery = undefined;
		}
	})();
	return discovery;
}

async function refreshCatalog(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	const stored = context.stored;
	const restored = (stored?.models ?? []).filter((model) => model.provider === PROVIDER_ID);
	if (restored.length > 0) catalog = restored as ProviderModelConfig[];
	if (context.signal.aborted) return catalog;

	// A catalog written by another integration (for example pi-custom-providers,
	// which persists bare ids with 128K/4096 fallbacks and zero prices) is restored
	// by Pi before this refresh runs. Treat placeholder pricing as missing metadata
	// so the authentic RouterAI catalog replaces it.
	const missing = stored === undefined || restored.some((entry) => hasPlaceholderPricing(entry));
	const stale = missing || context.force === true || !isFresh(stored.checkedAt);
	if (!stale) return catalog;
	if (!context.allowNetwork && !missing) return catalog;

	await startDiscovery(context, context.signal);
	return catalog;
}
/** Read the RouterAI key Pi already knows: stored credential first, then env. */
async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		if (key) return key;
	} catch {
		// Provider may not be composed yet; fall through to the environment.
	}
	return process.env.ROUTERAI_API_KEY?.trim() || undefined;
}

/**
 * Register (or re-register) the provider. Registration order decides the winner:
 * another extension such as pi-custom-providers may register the same provider id
 * after ours, so this runs again on session start when the ordering is settled.
 */
function registerProvider(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: baseUrl(),
		api: "openai-completions",
		refreshModels: refreshCatalog,
	});
}

export default function (pi: ExtensionAPI) {
	registerProvider(pi);

	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight = false;
	let lastRendered: string | undefined;

	async function updateBalance(ctx: ExtensionContext): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const apiKey = await resolveApiKey(ctx);
			if (!apiKey) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				lastRendered = undefined;
				return;
			}
			const credits = await fetchCredits(baseUrl(), apiKey);
			const text = formatRubles(credits);
			lastRendered = text;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Keep the last good value; a transient failure should not blank the footer.
			if (lastRendered === undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
		} finally {
			inFlight = false;
		}
	}

	function startTimer(ctx: ExtensionContext): void {
		stopTimer();
		timer = setInterval(() => {
			void updateBalance(ctx);
		}, BALANCE_INTERVAL_MS);
		// Do not hold the event loop open on shutdown.
		(timer as { unref?: () => void }).unref?.();
	}

	function stopTimer(): void {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

pi.on("session_start", async (_event, ctx) => {
		// Claim the provider id again: a later-loading extension of the same name wins
		// otherwise, and its placeholder catalog would hide the real RouterAI metadata.
		registerProvider(pi);
		void updateBalance(ctx);
		if (ctx.mode === "tui") startTimer(ctx);
	});

	// Refresh after each settled turn: spending happens while the agent runs.
	pi.on("agent_settled", async (_event, ctx) => {
		void updateBalance(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("routerai", {
		description: "Show RouterAI balance, key usage, and loaded model count",
		handler: async (_args, ctx) => {
			const apiKey = await resolveApiKey(ctx);
			if (!apiKey) {
				ctx.ui.notify(
					`No ${PROVIDER_NAME} API key. Set ROUTERAI_API_KEY or run /login ${PROVIDER_ID}.`,
					"warning",
				);
				return;
			}
			try {
				const [credits, info] = await Promise.all([
					fetchCredits(baseUrl(), apiKey),
					fetchKeyInfo(baseUrl(), apiKey).catch(() => undefined),
				]);
				const lines = [`${PROVIDER_NAME} balance: ${formatRubles(credits)}`];
				if (info?.name) lines.push(`Key: ${info.name}`);
				if (typeof info?.usage === "number") lines.push(`Key usage: ${formatRubles(info.usage)}`);
				if (typeof info?.usageMonthly === "number") {
					lines.push(`This month: ${formatRubles(info.usageMonthly)}`);
				}
				if (info?.disabled) lines.push("Warning: key is disabled");
				lines.push(
					`Models loaded: ${catalog.length} (prices in RUB per million tokens, as RouterAI reports)`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(
					`${PROVIDER_NAME} request failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}