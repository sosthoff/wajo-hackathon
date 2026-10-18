// AllSides Headline Roundups: a few stories a day, each summarized by AllSides staff with how
// left, center and right outlets covered it. We only read their public RSS feed (story pages sit
// behind a bot challenge, which we respect). Human-curated, so it outranks our own search.

import { decodeEntities } from "./article";

const FEED = "https://www.allsides.com/rss/headline-roundups";
const RATINGS = ["Left", "Lean Left", "Center", "Lean Right", "Right"] as const;

export interface Roundup {
	title: string;
	url: string;
	published: string | null;
	summary: string;
	outlets_mentioned: { outlet: string; allsides_rating: (typeof RATINGS)[number] }[];
}

const tag = (item: string, name: string) => {
	const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
	return m ? decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : null;
};

function toText(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " "))
		.replace(/([.!?"”])([A-Z‘“'])/g, "$1 $2") // the feed drops spaces between paragraphs
		.replace(/\s+/g, " ")
		.replace(/\s*Written by the AllSides staff.*$/i, "")
		.trim();
}

export async function fetchRoundups(): Promise<Roundup[] | null> {
	let xml: string;
	try {
		const res = await fetch(FEED, {
			signal: AbortSignal.timeout(8_000),
			headers: { "User-Agent": "Mozilla/5.0 (compatible; media-lens/0.1)", Accept: "application/rss+xml, application/xml" },
		});
		if (!res.ok) return null;
		xml = await res.text();
	} catch {
		return null;
	}
	// Matches "Fox News (Right)" and "CNN (Lean Left bias)".
	const mention = new RegExp(`([A-Z][\\w.&'’ -]{1,40}?) \\((${RATINGS.join("|")})(?: bias)?\\)`, "g");
	return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
		const summary = toText(tag(it, "description") ?? "");
		const outlets = new Map<string, (typeof RATINGS)[number]>();
		for (const m of summary.matchAll(mention)) outlets.set(m[1].replace(/^(?:.*\b(?:like|as|While|But|And|Meanwhile|However),?\s+)/, "").trim(), m[2] as (typeof RATINGS)[number]);
		return {
			title: tag(it, "title") ?? "",
			url: tag(it, "link") ?? "",
			published: tag(it, "pubDate"),
			summary,
			outlets_mentioned: [...outlets].map(([outlet, allsides_rating]) => ({ outlet, allsides_rating })),
		};
	});
}
