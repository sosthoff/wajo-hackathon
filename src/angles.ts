// find_other_angles: find other outlets' coverage of the same story and group it by outlet leaning.
// Sources, best first:
//  1. AllSides Headline Roundups (human-curated left/center/right comparison, a few stories a day)
//  2. Media Cloud (nonprofit news archive; curated US National collection; needs a free API key)
//  3. Bing News RSS (keyless; real article URLs)
// Results are clustered by headline so syndicated copies count as one version, not many.

import { WIRE_DOMAINS, type WireInfo, decodeEntities, fetchArticle, normalizeDomain } from "./article";
import { type Roundup, fetchRoundups } from "./allsides";
import { LEANINGS, type Leaning, outletDomains, outletProfile } from "./outlets";

const SEARCH_TIMEOUT_MS = 10_000;
const PER_BUCKET = 4;
const STOPWORDS = new Set(
	"a an the and or but of to in on at for from by with as is are was were be been has have had after before over under amid into about than this that these those it its their his her they he she we you i not no new says say said will would could can may might more most what how why who when where which while just up out off live update updates video watch across amid during between against among".split(" "),
);
const US_NATIONAL_COLLECTION = "34412234";

type Via = "mediacloud" | "bing" | "bing-targeted";
interface Hit {
	outlet: string;
	domain: string;
	headline: string;
	url: string;
	url_is_direct: boolean;
	published: string | null;
	via: Via[];
}

export interface AnglesEnv {
	MEDIACLOUD_API_KEY?: string;
	MEDIACLOUD_COLLECTIONS?: string;
}

const tag = (item: string, name: string) => {
	const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
	return m ? decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : null;
};

type SearchResult = { hits: Hit[]; status: string };

async function searchBing(q: string, via: Via = "bing"): Promise<SearchResult> {
	let xml: string;
	try {
		const res = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`, {
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
			headers: { "User-Agent": "Mozilla/5.0 (compatible; media-lens/0.1)", Accept: "application/rss+xml" },
		});
		if (!res.ok) return { hits: [], status: `HTTP ${res.status}` };
		xml = await res.text();
	} catch (e) {
		return { hits: [], status: `failed: ${String(e)}` };
	}
	const hits = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, it]) => {
		const link = tag(it, "link");
		const title = tag(it, "title");
		if (!link || !title) return [];
		let url: string;
		try {
			url = new URL(link).searchParams.get("url") ?? link; // unwrap Bing's click-tracking redirect
		} catch {
			return [];
		}
		return [{ outlet: tag(it, "News:Source") ?? normalizeDomain(url), domain: normalizeDomain(url), headline: title, url, url_is_direct: true, published: tag(it, "pubDate"), via: [via] }];
	});
	return { hits, status: `${hits.length} results` };
}

async function searchMediaCloud(q: string, env: AnglesEnv): Promise<SearchResult> {
	if (!env.MEDIACLOUD_API_KEY) return { hits: [], status: "skipped: no MEDIACLOUD_API_KEY" };
	const day = (d: Date) => d.toISOString().slice(0, 10);
	const params = new URLSearchParams({
		q: words(q).join(" AND "),
		start: day(new Date(Date.now() - 7 * 86400_000)),
		end: day(new Date()),
		platform: "onlinenews-mediacloud",
		cs: env.MEDIACLOUD_COLLECTIONS || US_NATIONAL_COLLECTION,
		page_size: "100",
	});
	try {
		const res = await fetch(`https://search.mediacloud.org/api/search/story-list?${params}`, {
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
			headers: { Authorization: `Token ${env.MEDIACLOUD_API_KEY}`, Accept: "application/json", "User-Agent": "media-lens/0.1" },
		});
		if (!res.ok) return { hits: [], status: `HTTP ${res.status} ${(await res.text()).slice(0, 120)}` };
		const data = (await res.json()) as { stories?: { title?: string; url?: string; media_name?: string; media_url?: string; publish_date?: string }[] };
		const hits = (data.stories ?? []).flatMap((st) =>
			st.title && st.url
				? [{ outlet: st.media_name || normalizeDomain(st.url), domain: normalizeDomain(st.media_url || st.url), headline: st.title, url: st.url, url_is_direct: true, published: st.publish_date ?? null, via: ["mediacloud" as Via] }]
				: [],
		);
		return { hits, status: `${hits.length} results` };
	} catch (e) {
		return { hits: [], status: `failed: ${String(e)}` };
	}
}

// Nationality words count as their country, so "French cities" matches a query about France.
const DEMONYMS: Record<string, string> = {
	french: "france", german: "germany", british: "britain", english: "england", american: "america", russian: "russia",
	ukrainian: "ukraine", chinese: "china", israeli: "israel", iranian: "iran", mexican: "mexico", canadian: "canada",
	italian: "italy", spanish: "spain", japanese: "japan", indian: "india", turkish: "turkey", polish: "poland",
	greek: "greece", dutch: "netherlands", belgian: "belgium", swedish: "sweden", syrian: "syria", lebanese: "lebanon",
	palestinian: "palestine", egyptian: "egypt", brazilian: "brazil", korean: "korea", australian: "australia",
};

function words(s: string): string[] {
	return s
		.toLowerCase()
		.replace(/[’']s\b/g, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w))
		.map((w) => DEMONYMS[w] ?? w);
}

const stem = (w: string) => w.slice(0, 5);

// Fallback when the agent gives no query: a short keyword query beats the literal headline, which
// mostly finds copies of the same wire text. Priority: proper nouns, then words the headline
// shares with the description (the story's core), then remaining headline words. Max 5 words.
export function buildQuery(headline: string, description?: string | null): string {
	const tokens = headline.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
	const proper = tokens.slice(1).filter((t) => /^\p{Lu}/u.test(t) && !STOPWORDS.has(t.toLowerCase())).map((t) => t.toLowerCase());
	const hw = words(headline);
	const descStems = new Set(words(description ?? "").map(stem));
	const shared = hw.filter((w) => descStems.has(stem(w)));
	const out: string[] = [];
	const add = (w: string) => !out.some((o) => stem(o) === stem(w)) && out.push(w);
	for (const w of [...proper, ...shared]) if (out.length < 5) add(w);
	// Only pad with other headline words when the core is thin; they tend to be wire-copy specific.
	for (const w of hw) if (out.length < 3) add(w);
	return out.join(" ");
}

function similarity(a: string, b: string): number {
	const A = new Set(words(a));
	const B = new Set(words(b));
	if (!A.size || !B.size) return 0;
	let inter = 0;
	for (const w of A) if (B.has(w)) inter++;
	return inter / (A.size + B.size - inter);
}

function queryCoverage(headline: string, query: string): number {
	const q = [...new Set(words(query).map(stem))];
	if (!q.length) return 0;
	const h = new Set(words(headline).map(stem));
	return q.filter((w) => h.has(w)).length / q.length;
}

const WIRE_SERVICES = new Set(["apnews.com", "reuters.com", "afp.com"]);
const WIRE_BYLINE = /associated press|\bap\b|reuters|\bafp\b|agence france/i;
// Headlines this similar at different outlets are almost always the same syndicated text.
const COPY_THRESHOLD = 0.6;

function matchRoundup(roundups: Roundup[], headline: string, query: string) {
	let best: { r: Roundup; score: number } | null = null;
	for (const r of roundups) {
		const text = `${r.title} ${r.summary.slice(0, 500)}`;
		const score = Math.max(queryCoverage(text, query), similarity(r.title, headline) * 1.5);
		if (!best || score > best.score) best = { r, score };
	}
	if (!best || best.score < 0.75 || words(query).length < 2) return null;
	return { match_confidence: best.score >= 0.9 ? "high" : "medium", ...best.r };
}

export async function findOtherAngles(
	env: AnglesEnv,
	input: { headline: string; description?: string | null; author?: string | null; published?: string | null; source_url?: string; query?: string },
) {
	const query = input.query?.trim() || buildQuery(input.headline, input.description);
	const sourceIsWire = !!input.author && WIRE_BYLINE.test(input.author);
	const sourceDomain = input.source_url ? normalizeDomain(input.source_url) : null;
	// General searches favour wire copy in local papers and bury parts of the spectrum, so also search
	// each slot's rated outlets directly.
	const sites = (ls: Leaning[]) => `${query} (${outletDomains(ls).map((d) => `site:${d}`).join(" OR ")})`;
	const [mc, bing, roundups, tLeft, tCenter, tRight] = await Promise.all([
		searchMediaCloud(query, env),
		searchBing(query),
		fetchRoundups(),
		searchBing(sites(["left", "lean_left"]), "bing-targeted"),
		searchBing(sites(["center"]), "bing-targeted"),
		searchBing(sites(["lean_right", "right"]), "bing-targeted"),
	]);
	const roundup = roundups ? matchRoundup(roundups, input.headline, query) : null;

	const relevance = (h: { headline: string }) =>
		Math.round(Math.max(similarity(h.headline, input.headline), queryCoverage(h.headline, query) * 0.6) * 100) / 100;

	// One entry per outlet: keep its most on-topic headline (outlets can have several domains).
	const byOutlet = new Map<string, ReturnType<typeof enrich>>();
	const enrich = (h: Hit) => {
		const p = outletProfile(h.domain);
		return {
			outlet: p.found ? (p.outlet as string) : h.outlet,
			domain: h.domain,
			headline: h.headline,
			url: h.url,
			url_is_direct: h.url_is_direct,
			published: h.published,
			via: h.via,
			leaning: (p.found ? p.leaning : "unknown") as Leaning | "unknown",
			leaning_confidence: p.found ? (p.leaning_confidence as string) : "none",
			factual_reporting_mbfc: p.found ? (p.factual_reliability as { rating: string }[])[0].rating : "unknown",
			relevance: relevance(h),
			wire_service: WIRE_SERVICES.has(h.domain),
			is_source: h.domain === sourceDomain,
		};
	};
	for (const h of [...mc.hits, ...bing.hits, ...tLeft.hits, ...tCenter.hits, ...tRight.hits]) {
		const e = enrich(h);
		if (e.relevance < 0.2) continue; // search engines pad with tangential stories
		// Key by rated outlet name, else bare domain (Media Cloud names outlets by domain, Bing by name).
		const key = e.leaning !== "unknown" ? e.outlet : e.domain;
		const prev = byOutlet.get(key);
		const better = !prev || e.relevance > prev.relevance;
		if (better || prev) byOutlet.set(key, { ...(better ? e : prev!), outlet: prev && /\./.test(e.outlet) ? prev.outlet : e.outlet, via: [...new Set([...(prev?.via ?? []), ...e.via])] });
	}
	const results = [...byOutlet.values()];

	// Cluster near-identical headlines (union-find). Node 0 is the source article.
	const nodes = [{ headline: input.headline }, ...results];
	const parent = nodes.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	for (let i = 0; i < nodes.length; i++)
		for (let j = i + 1; j < nodes.length; j++) if (similarity(nodes[i].headline, nodes[j].headline) >= COPY_THRESHOLD) parent[find(j)] = find(i);
	const clusters = new Map<number, number[]>();
	nodes.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));
	const sourceRoot = find(0);

	// Name each multi-outlet cluster by its most likely origin: a wire service, else a rated outlet.
	const groupInfo = new Map<number, { id: string; size: number; likely_origin: string | null; origin_leaning: Leaning | "unknown" }>();
	let gid = 0;
	for (const [root, members] of clusters) {
		const rs = members.filter((i) => i > 0).map((i) => results[i - 1]);
		if (members.length < 2) continue;
		const origin =
			rs.find((r) => r.wire_service) ??
			(root === sourceRoot && sourceIsWire ? null : rs.filter((r) => r.leaning !== "unknown").sort((a, b) => b.relevance - a.relevance)[0]) ??
			null;
		groupInfo.set(root, {
			id: `copy-group-${++gid}`,
			size: rs.length + (root === sourceRoot ? 1 : 0),
			likely_origin: origin ? origin.outlet : root === sourceRoot && sourceIsWire ? `${input.author} (wire)` : null,
			origin_leaning: origin ? origin.leaning : "unknown",
		});
	}

	const others = results
		.map((r, k) => {
			const root = find(k + 1);
			const g = groupInfo.get(root);
			return {
				...r,
				copy_group: g ? g.id : null,
				same_text_as_source: root === sourceRoot,
				copy_of: g && g.likely_origin && g.likely_origin !== r.outlet ? g.likely_origin : null,
				_root: root,
			};
		})
		.filter((r) => !r.is_source);

	const byLeaning = Object.fromEntries(
		[...LEANINGS, "unknown" as const].map((l) => {
			const xs = others
				.filter((e) => e.leaning === l)
				.sort((a, b) => Number(!!a.copy_of) - Number(!!b.copy_of) || Number(b.url_is_direct) - Number(a.url_is_direct) || b.relevance - a.relevance);
			return [l, { total: xs.length, listed: xs.slice(0, l === "unknown" ? 50 : PER_BUCKET).map(({ _root, ...x }) => x) }];
		}),
	) as Record<Leaning | "unknown", { total: number; listed: Omit<(typeof others)[number], "_root">[] }>;

	// A cluster's leaning is its origin's; an unrated outlet carrying Fox copy counts as a Fox angle.
	const poor = new Set(["Mixed", "Low", "Very Low"]);
	const leaningOf = (r: (typeof others)[number]) => (r.leaning !== "unknown" ? r.leaning : (groupInfo.get(r._root)?.origin_leaning ?? "unknown"));
	// A copy inherits its origin's factual record; otherwise an unrated copy would launder a poor rating.
	const factualOf = (r: (typeof others)[number]) => {
		if (r.leaning !== "unknown") return r.factual_reporting_mbfc;
		const origin = others.find((o) => o._root === r._root && o.outlet === groupInfo.get(r._root)?.likely_origin);
		return origin ? origin.factual_reporting_mbfc : r.factual_reporting_mbfc;
	};
	// Recommended angles must clearly be the same story: most query words in the headline (or a
	// near-identical headline) and published within a few days of the source (or of now).
	// Names and places (capitalized in the source headline or the query) must appear: "student
	// protests in Albania" is not the France story.
	const anchor = Date.parse(input.published ?? "") || Date.now();
	const proper = new Set(
		[...input.headline.split(/\s+/).slice(1), ...query.split(/\s+/)]
			.filter((t) => /^\p{Lu}/u.test(t))
			.flatMap((t) => words(t))
			.map(stem),
	);
	// Returns null when the result is clearly the same story, else why not.
	const offStory = (r: (typeof others)[number]): string | null => {
		if (similarity(r.headline, input.headline) >= 0.35) return null;
		const hs = new Set(words(r.headline).map(stem));
		if (proper.size && ![...proper].some((p) => hs.has(p))) return "headline doesn't mention the story's key names/places";
		const t = Date.parse(r.published ?? "");
		const days = Number.isNaN(t) ? 2 : Math.abs(t - anchor) / 86400_000;
		const cov = queryCoverage(r.headline, query);
		if ((days <= 2 && cov >= 0.4) || (days <= 4 && cov >= 0.6)) return null;
		return days > 4 ? `published ${Math.round(days)} days from the source` : "headline matches too few query words";
	};

	const pool = others
		.filter((r) => r._root !== sourceRoot && leaningOf(r) !== "unknown")
		.sort(
			(a, b) =>
				Number(poor.has(factualOf(a))) - Number(poor.has(factualOf(b))) ||
				Number(b.leaning !== "unknown") - Number(a.leaning !== "unknown") ||
				b.relevance - a.relevance,
		);

	// Read the strongest candidates to catch wire copy the headline hides (e.g. USA Today running
	// Reuters text under its own headline). Wire copy then counts as the agency's angle, not the host's.
	const checks = new Map<string, { wire: WireInfo | null } | { error: string }>();
	await Promise.all(
		// Spread the reads across the slots: the top on-story candidates of each.
		[...new Set(
			[["center"], ["lean_left", "left"], ["lean_right", "right"]].flatMap((ls) =>
				pool.filter((r) => r.url_is_direct && !offStory(r) && ls.includes(leaningOf(r))).slice(0, 4),
			),
		)].map(async (r) => {
			try {
				checks.set(r.url, { wire: (await fetchArticle(r.url)).wire });
			} catch (e) {
				checks.set(r.url, { error: e instanceof Error ? e.message : String(e) });
			}
		}),
	);
	const sourceWire = sourceIsWire ? (/reuters/i.test(input.author!) ? "Reuters" : /afp|agence/i.test(input.author!) ? "AFP" : "Associated Press") : null;
	const wireOf = (r: (typeof others)[number]) => {
		const c = checks.get(r.url);
		return c && "wire" in c ? c.wire : null;
	};
	const angleOf = (r: (typeof others)[number]) => {
		const c = checks.get(r.url);
		// A verified wire copy anywhere in the copy group means the whole group is that agency's text.
		const wire = wireOf(r)?.is_wire_copy ? wireOf(r) : (others.filter((o) => o._root === r._root && o !== r).map(wireOf).find((w) => w?.is_wire_copy) ?? wireOf(r));
		if (wire?.is_wire_copy) {
			const wl = outletProfile(WIRE_DOMAINS[wire.service]).leaning as Leaning | "unknown";
			return { key: `wire:${wire.service}`, leaning: wl, wire, check: "read" as const };
		}
		return { key: `cluster:${r._root}`, leaning: leaningOf(r), wire, check: c ? ("error" in c ? ("unreadable" as const) : ("read" as const)) : ("not checked" as const) };
	};

	// Two passes: a primary angle for center/left/right, then a second one per slot. Every angle must
	// be a different text: different copy cluster and different wire agency, never the source's.
	const used = new Set<string>([`cluster:${sourceRoot}`, ...(sourceWire ? [`wire:${sourceWire}`] : [])]);
	const SLOTS: { slot: string; ls: Leaning[] }[] = [
		{ slot: "center", ls: ["center"] },
		{ slot: "left-leaning", ls: ["lean_left", "left"] },
		{ slot: "right-leaning", ls: ["lean_right", "right"] },
	];
	// Prefer picks we could read and check over unverified ones.
	const checkRank = (r: (typeof others)[number]) => (angleOf(r).check === "read" ? 0 : angleOf(r).check === "not checked" ? 1 : 2);
	const skipped: { outlet: string; leaning: string; headline: string; reason: string }[] = [];
	const pick = (ls: Leaning[]) => {
		for (const r of [...pool].sort((a, b) => checkRank(a) - checkRank(b))) {
			const a = angleOf(r);
			if (!ls.includes(a.leaning as Leaning)) continue;
			const why = offStory(r) ?? (used.has(a.key) ? (a.key === `cluster:${sourceRoot}` || a.key === `wire:${sourceWire}` ? "same text as the source" : `same text as an angle already picked (${a.wire?.is_wire_copy ? a.wire.service : "copy group"})`) : null);
			if (why) {
				if (!skipped.some((x) => x.outlet === r.outlet)) skipped.push({ outlet: r.outlet, leaning: a.leaning, headline: r.headline, reason: why });
				continue;
			}
			used.add(a.key);
			const { _root, ...rest } = r;
			const isWire = !!a.wire?.is_wire_copy;
			const textOrigin = isWire ? `${a.wire!.service} (wire copy hosted by ${r.outlet})` : r.copy_of ? `${r.copy_of} (copy)` : r.outlet;
			// Judge the text by whoever wrote it: the agency for wire copy, else the copy's origin, else the host.
			const writer = isWire ? a.wire!.service : (r.copy_of ?? r.outlet);
			const fact = isWire ? ((outletProfile(WIRE_DOMAINS[a.wire!.service]).factual_reliability as { rating: string }[])[0]?.rating ?? "unknown") : factualOf(r);
			const questionable = !isWire && outletProfile(r.domain).found && (outletProfile(r.domain).factual_reliability as { questionable_source_flag?: boolean }[])[0].questionable_source_flag;
			return {
				...rest,
				angle_leaning: a.leaning,
				text_origin: textOrigin,
				wire_check:
					a.check === "read" ? (a.wire ? `${a.wire.kind}: ${a.wire.evidence}` : "read; no wire markers found") : a.check === "unreadable" ? "could not fetch to check" : "not checked",
				includes_wire_reporting: a.wire && !a.wire.is_wire_copy ? a.wire.service : null,
				copy_of: isWire ? null : r.copy_of,
				factual_flag: [
					poor.has(fact) ? `MBFC rates factual reporting of ${writer} "${fact}"` : null,
					questionable ? `MBFC lists ${r.outlet} as a Questionable source` : null,
				]
					.filter(Boolean)
					.join("; ") || null,
			};
		}
		return null;
	};
	const primary = SLOTS.map(({ slot, ls }) => ({ slot, rank: "primary", hit: pick(ls) }));
	const secondary = SLOTS.map(({ slot, ls }) => ({ slot, rank: "secondary", hit: pick(ls) })).filter((r) => r.hit);
	const recommended = [...primary, ...secondary];

	const n = (ls: (Leaning | "unknown")[]) => ls.reduce((s, l) => s + byLeaning[l].total, 0);
	const independent = new Set(others.map((r) => r._root));
	independent.delete(sourceRoot);
	const sourceCopies = others.filter((r) => r.same_text_as_source).length;
	const missing = primary.filter((r) => !r.hit).map((r) => r.slot);

	const parts: string[] = [];
	if (roundup) parts.push(`AllSides has a human-curated roundup of this story ("${roundup.title}"); use it as the primary comparison.`);
	parts.push(
		`${others.length} other outlets found (${n(["left", "lean_left"])} left-leaning, ${n(["center"])} center, ${n(["lean_right", "right"])} right-leaning, ${n(["unknown"])} not rated), but only ${independent.size} distinct versions once syndicated copies are grouped.`,
	);
	if (sourceIsWire) parts.push(`The source article is wire copy (byline: ${input.author}).`);
	if (sourceCopies) parts.push(`${sourceCopies} outlets run the same text as the source.`);
	const hosted = recommended.filter((r) => r.hit?.text_origin.includes("wire copy hosted by"));
	if (hosted.length) parts.push(`Reading the picks showed ${hosted.map((r) => r.hit!.text_origin).join("; ")}.`);
	if (missing.length) parts.push(`No ${missing.join(" or ")} version found.`);

	return {
		query,
		searched: {
			allsides_roundups: roundups ? `${roundups.length} roundups checked` : "unavailable",
			media_cloud: mc.status,
			bing_news: bing.status,
			bing_targeted: { left: tLeft.status, center: tCenter.status, right: tRight.status },
			articles_read_for_wire_check: checks.size,
		},
		source: sourceDomain ? { domain: sourceDomain, leaning: outletProfile(sourceDomain).leaning, is_wire_copy: sourceIsWire, byline: input.author ?? null } : null,
		headline: parts.join(" "),
		allsides_roundup: roundup ?? { match: null, note: "No AllSides roundup matches this story (they curate a few, mostly US, stories a day)." },
		recommended_angles: recommended.map(({ slot, rank, hit }) =>
			hit ? { slot, rank, ...hit } : { slot, rank, outlet: null, note: "Nothing suitable found. Absence in search results is not proof the outlet didn't cover it." },
		),
		// Rated outlets that were not recommended, and why — so an empty slot is explained, not silent.
		considered_but_skipped: skipped.filter((x) => !recommended.some((r) => r.hit?.outlet === x.outlet)),
		coverage_by_leaning: byLeaning,
		copy_groups: [...groupInfo.values()].filter((g) => g.size > 1),
		suggested_actions: [
			...(roundup ? [{ action: "Read the AllSides roundup summary and cite it; it already compares left/center/right coverage", needs_user_approval: false }] : []),
			{
				action: "fetch_article on the primary angles (secondary ones if a primary is unreadable or you want a second view) and compare framing: headline wording, what leads, who is quoted, what is left out",
				needs_user_approval: false,
			},
			{ action: "Send the user a short 'three angles' message: one line per version on how it frames the story, with links", needs_user_approval: false },
			...(missing.length ? [{ action: `Tell the user no ${missing.join("/")} version turned up, rather than filling the gap with a weaker source`, needs_user_approval: false }] : []),
		],
		caveats: [
			"text_origin says whose text an angle really is: wire copy counts as the agency's angle (AP, Reuters), not the hosting outlet's. Only recommended angles are read to check this; listed results are grouped by headline only.",
			"Outlets in the same copy_group run the same (usually wire) text: one source, many logos. Their outlet leaning says little about that text.",
			"Search matches are keyword-based; confirm each result is the same story before comparing.",
			"Leaning describes the outlet on average, not this article.",
			"Media Cloud indexes with some delay, so the newest stories may be thin there.",
		],
	};
}
