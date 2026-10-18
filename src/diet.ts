// Media-diet log in KV. Each read is one key; the record lives in the key's metadata so a
// summary needs only list() calls, no per-key gets.

import { normalizeDomain } from "./article";
import { LEANING_SCORE, LEANINGS, type Leaning, outletProfile, suggestOutlets } from "./outlets";

const RETENTION_DAYS = 180;
const RECENT_KEY = "recent-log";
// Broad buckets so "topics never seen" is meaningful; free-text topics are mapped onto them.
export const TOPIC_BUCKETS = ["politics", "economy", "world", "science", "health", "technology", "climate", "culture", "sports", "local"] as const;

export interface LogEntry {
	t: number; // ms epoch
	url: string;
	domain: string;
	outlet: string;
	leaning: Leaning | "unknown";
	leaning_source: "user/agent" | "outlet table" | "unknown";
	topic: string;
	wire?: string; // agency, when the text was wire copy (from fetch_article's wire field)
	via?: string; // where the user saw it, e.g. "newsletter: Morning Brew"
}

async function urlKey(url: string): Promise<string> {
	const u = url.trim().replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
	const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(u)));
	return `seen:${[...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function logArticle(
	kv: KVNamespace,
	input: { url: string; outlet?: string; leaning?: Leaning | "unknown"; topic: string; wire?: string; via?: string },
): Promise<{ entry: LogEntry; duplicate: boolean }> {
	// The same article (ignoring tracking parameters) is only counted once.
	const seenKey = await urlKey(input.url);
	const seen = await kv.get<LogEntry>(seenKey, "json");
	if (seen) return { entry: seen, duplicate: true };
	const domain = normalizeDomain(input.url);
	const profile = outletProfile(domain);
	let leaning: LogEntry["leaning"] = "unknown";
	let leaning_source: LogEntry["leaning_source"] = "unknown";
	if (input.leaning && input.leaning !== "unknown") {
		leaning = input.leaning;
		leaning_source = "user/agent";
	} else if (profile.found && profile.leaning !== "unknown") {
		leaning = profile.leaning as Leaning;
		leaning_source = "outlet table";
	}
	const entry: LogEntry = {
		t: Date.now(),
		url: input.url.slice(0, 400),
		domain,
		outlet: (input.outlet || (profile.found ? profile.outlet : domain) || domain).slice(0, 80),
		leaning,
		leaning_source,
		topic: input.topic.trim().toLowerCase().slice(0, 60),
		...(input.wire ? { wire: input.wire.slice(0, 40) } : {}),
		...(input.via ? { via: input.via.slice(0, 60) } : {}),
	};
	// Zero-padded timestamp keeps keys in chronological order; random suffix avoids collisions.
	const key = `log:${String(entry.t).padStart(15, "0")}:${crypto.randomUUID().slice(0, 8)}`;
	await kv.put(key, "1", { metadata: entry, expirationTtl: RETENTION_DAYS * 86400 });
	// KV list() can lag writes by up to a minute; a direct-read "recent" record makes new reads
	// count immediately (e.g. get_media_diet right after an inbox scan).
	const recent = (await kv.get<{ key: string; entry: LogEntry }[]>(RECENT_KEY, "json")) ?? [];
	recent.push({ key, entry });
	await kv.put(RECENT_KEY, JSON.stringify(recent.slice(-100)));
	await kv.put(seenKey, JSON.stringify(entry), { expirationTtl: RETENTION_DAYS * 86400 });
	return { entry, duplicate: false };
}

async function listEntries(kv: KVNamespace, sinceMs: number): Promise<LogEntry[]> {
	const out = new Map<string, LogEntry>();
	let cursor: string | undefined;
	do {
		const page = await kv.list<LogEntry>({ prefix: "log:", cursor });
		for (const k of page.keys) if (k.metadata && k.metadata.t >= sinceMs) out.set(k.name, k.metadata);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	for (const r of (await kv.get<{ key: string; entry: LogEntry }[]>(RECENT_KEY, "json")) ?? []) if (r.entry.t >= sinceMs) out.set(r.key, r.entry);
	return [...out.values()].sort((a, b) => a.t - b.t);
}

function bucketFor(topic: string): (typeof TOPIC_BUCKETS)[number] | null {
	const aliases: Record<string, (typeof TOPIC_BUCKETS)[number]> = {
		election: "politics", congress: "politics", policy: "politics", government: "politics",
		business: "economy", markets: "economy", finance: "economy", jobs: "economy", inflation: "economy",
		international: "world", war: "world", foreign: "world", europe: "world", ukraine: "world", "middle east": "world",
		space: "science", research: "science",
		medicine: "health", covid: "health",
		tech: "technology", ai: "technology",
		environment: "climate", energy: "climate", weather: "climate",
		arts: "culture", entertainment: "culture", books: "culture", film: "culture", music: "culture",
		sport: "sports", football: "sports", soccer: "sports",
		city: "local", community: "local",
	};
	const t = topic.toLowerCase();
	for (const b of TOPIC_BUCKETS) if (t.includes(b)) return b;
	for (const [alias, b] of Object.entries(aliases)) if (new RegExp(`\\b${alias}\\b`).test(t)) return b;
	return null;
}

export async function getMediaDiet(kv: KVNamespace, days: number) {
	const since = Date.now() - days * 86400_000;
	const entries = await listEntries(kv, since);

	const leaningCounts = Object.fromEntries([...LEANINGS, "unknown"].map((l) => [l, 0])) as Record<Leaning | "unknown", number>;
	const outlets = new Map<string, number>();
	const topics = new Map<string, number>();
	const buckets = new Map<string, number>();
	for (const e of entries) {
		leaningCounts[e.leaning]++;
		outlets.set(e.outlet, (outlets.get(e.outlet) ?? 0) + 1);
		topics.set(e.topic, (topics.get(e.topic) ?? 0) + 1);
		const b = bucketFor(e.topic);
		if (b) buckets.set(b, (buckets.get(b) ?? 0) + 1);
	}

	const known = entries.filter((e) => e.leaning !== "unknown");
	// -2 (all left) … +2 (all right); null when nothing has a known leaning.
	const balance = known.length ? known.reduce((s, e) => s + LEANING_SCORE[e.leaning as Leaning], 0) / known.length : null;
	const pct = (n: number) => (entries.length ? Math.round((n / entries.length) * 100) : 0);
	const sortDesc = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
	const missing = LEANINGS.filter((l) => leaningCounts[l] === 0);
	const topOutlet = sortDesc(outlets)[0];

	// Sides, counted over reads with a known leaning.
	const side = {
		left: leaningCounts.left + leaningCounts.lean_left,
		center: leaningCounts.center,
		right: leaningCounts.right + leaningCounts.lean_right,
	};
	const k = known.length;
	const share = (n: number) => (k ? n / k : 0);
	const wireN = entries.filter((e) => e.wire).length;
	const lean = balance === null ? "unknown" : balance <= -1.25 ? "left" : balance <= -0.5 ? "lean left" : balance < 0.5 ? "balanced" : balance < 1.25 ? "lean right" : "right";
	const blind: "left" | "right" | "center" | null =
		k < 3 ? null : side.right === 0 || share(side.right) < 0.1 ? "right" : side.left === 0 || share(side.left) < 0.1 ? "left" : side.center === 0 ? "center" : null;
	const blindLeanings: Record<"left" | "right" | "center", Leaning[]> = { left: ["lean_left", "left"], right: ["lean_right", "right"], center: ["center"] };
	const blindSuggestions = blind ? [...new Set(blindLeanings[blind].flatMap((l) => suggestOutlets(l, 3)))].slice(0, 3) : [];
	const topTopic = sortDesc(topics)[0]?.name;

	// How loudly to tell the user: ambient display only, a nudge by text, or nothing to say yet.
	const signal: "not_enough_data" | "balanced" | "mild_tilt" | "strong_tilt" =
		k < 3 ? "not_enough_data" : Math.max(share(side.left), share(side.right)) >= 0.7 && k >= 5 ? "strong_tilt" : Math.abs(balance ?? 0) >= 0.5 ? "mild_tilt" : "balanced";
	const channel = { not_enough_data: "display only", balanced: "display only", mild_tilt: "display + weekly report", strong_tilt: "display + a short text to the user" }[signal];

	const headline =
		signal === "not_enough_data"
			? `Only ${k} rated read${k === 1 ? "" : "s"} in the last ${days} days — too few to say anything about balance yet.`
			: `${side.left} of your last ${k} rated reads lean left, ${side.center} center, ${side.right} right (${lean}).` +
				(blind ? ` Nothing${blind === "center" ? "" : " much"} from ${blind === "center" ? "center" : `${blind}-leaning`} outlets.` : "") +
				(single(topOutlet) ? ` ${topOutlet!.name} alone is ${pct(topOutlet!.count)}% of your reading.` : "") +
				(wireN && pct(wireN) >= 30 ? ` ${pct(wireN)}% was wire copy, so fewer distinct voices than outlets.` : "");
	function single(t: { name: string; count: number } | undefined) {
		return !!t && entries.length >= 5 && pct(t.count) >= 40;
	}

	const suggested_actions = [
		{ action: "Refresh the desk display (update_desk_display)", needs_user_approval: false },
		...(signal === "strong_tilt" && blind
			? [
					{
						action: `Text the user one line about the tilt plus ONE well-rated ${blind === "center" ? "center" : `${blind}-leaning`} piece${topTopic ? ` on "${topTopic}"` : ""} (use find_other_angles on a story they read); no lecture`,
						needs_user_approval: false,
					},
				]
			: []),
		...(signal === "mild_tilt" ? [{ action: "Mention the tilt in the weekly report rather than interrupting the user", needs_user_approval: false }] : []),
		...(blind && blindSuggestions.length
			? [{ action: `Offer to subscribe the user to a newsletter from ${blindSuggestions[0]} — only if they say yes`, needs_user_approval: true }]
			: []),
	];

	return {
		headline,
		signal,
		suggested_channel: channel,
		lean,
		blind_spot: blind ? { side: blind, well_rated_outlets: blindSuggestions } : null,
		display: {
			line: k < 3 ? `${days}d: too few reads` : `${days}d: ${lean}`,
			blind_spot: blind ? `Blind spot: ${blind}` : k >= 3 ? "Good mix" : null,
			counts: `${entries.length} read${entries.length === 1 ? "" : "s"} · ${outlets.size} outlet${outlets.size === 1 ? "" : "s"}`,
		},
		suggested_actions,
		window_days: days,
		articles_logged: entries.length,
		wire_copy_share_percent: pct(wireN),
		leaning_distribution: Object.fromEntries(Object.entries(leaningCounts).map(([l, n]) => [l, { count: n, percent: pct(n) }])),
		balance_score: balance === null ? null : Math.round(balance * 100) / 100,
		balance_score_scale: "-2 = only left-leaning outlets, 0 = balanced/center, +2 = only right-leaning outlets",
		balance_confidence: known.length >= 10 ? "medium" : known.length > 0 ? "low" : "none",
		unknown_leaning_share_percent: pct(leaningCounts.unknown),
		outlet_mix: sortDesc(outlets),
		distinct_outlets: outlets.size,
		single_outlet_share_percent: topOutlet ? pct(topOutlet.count) : 0,
		topics: sortDesc(topics),
		topic_buckets_seen: sortDesc(buckets),
		topic_buckets_never_seen: TOPIC_BUCKETS.filter((b) => !buckets.has(b)),
		perspectives_never_seen: missing.map((l) => ({ leaning: l, example_outlets: suggestOutlets(l) })),
		caveats: [
			"Leaning is per outlet (from rater consensus or what was logged), not per article.",
			"Only articles explicitly logged are counted; this is not a full reading history.",
		],
		recent: entries.slice(-10).reverse().map((e) => ({ when: new Date(e.t).toISOString(), outlet: e.outlet, leaning: e.leaning, topic: e.topic, url: e.url, wire: e.wire ?? null, via: e.via ?? null })),
	};
}
