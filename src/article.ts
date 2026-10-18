// fetch_article: download a page and extract clean article text + metadata.
// Uses the Workers HTMLRewriter (streaming, no DOM) so it stays fast and free.

const MAX_TEXT_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 12_000;

// Elements whose text never belongs to the article body.
const SKIP_TAGS = ["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form", "button", "figcaption"];
// Attribute patterns are only applied to containers that always have an explicit end tag:
// <li>/<p> often omit it, and HTMLRewriter would then never see the element close.
const SKIP_CONTAINERS = ["div", "section", "ul", "ol", "span"];
const SKIP_ATTRS = [
	"[aria-hidden=true]",
	"[role=navigation]",
	"[role=complementary]",
	'[class*="newsletter"]',
	'[class*="related"]',
	'[class*="promo"]',
	'[class*="advert"]',
	'[class*="subscribe"]',
	'[class*="share"]',
	'[class*="caption"]',
	'[id*="comments"]',
];
const SKIP_SELECTORS = [...SKIP_TAGS, ...SKIP_CONTAINERS.flatMap((tag) => SKIP_ATTRS.map((a) => tag + a))];

export interface Article {
	url: string;
	final_url: string;
	domain: string;
	outlet: string | null;
	headline: string | null;
	description: string | null;
	author: string | null;
	published: string | null;
	modified: string | null;
	language: string | null;
	word_count: number;
	truncated: boolean;
	text_source: "json-ld" | "article-paragraphs" | "page-paragraphs";
	text: string;
	wire: WireInfo | null;
	warnings: string[];
}

export interface WireInfo {
	service: "Associated Press" | "Reuters" | "AFP";
	// byline/dateline/credit_line: the text is the agency's copy. contributed: an outlet's own story that
	// includes agency reporting.
	kind: "byline" | "dateline" | "credit_line" | "contributed";
	is_wire_copy: boolean;
	evidence: string;
}

export const WIRE_DOMAINS: Record<WireInfo["service"], string> = { "Associated Press": "apnews.com", Reuters: "reuters.com", AFP: "afp.com" };

// Detect agency copy from the byline and the telltale lines agencies attach to their text.
export function detectWire(author: string | null, text: string): WireInfo | null {
	const svc = (s: string): WireInfo["service"] => (/reuters/i.test(s) ? "Reuters" : /afp|agence france/i.test(s) ? "AFP" : "Associated Press");
	const hit = (service: WireInfo["service"], kind: WireInfo["kind"], evidence: string): WireInfo => ({
		service,
		kind,
		is_wire_copy: kind !== "contributed",
		evidence: evidence.trim().slice(0, 160),
	});
	if (author && /associated press|^ap$|\breuters\b|\bafp\b|agence france/i.test(author)) return hit(svc(author), "byline", author);
	const head = text.slice(0, 400);
	const dateline = head.match(/^[^\n]{0,80}?\((AP|Reuters|AFP)\)\s*[-—–]/m);
	if (dateline) return hit(svc(dateline[1] === "AP" ? "Associated Press" : dateline[1]), "dateline", dateline[0]);
	const tail = text.slice(-1500);
	const credit = tail.match(/Reporting by [^.\n]{3,200}?(Editing|Writing|Additional reporting) by [^.\n]{3,120}/);
	if (credit) return hit("Reuters", "credit_line", credit[0]);
	const copyright = tail.match(/(?:Copyright|©)\s*\d{4}\s*(The Associated Press|Reuters|AFP)/i);
	if (copyright) return hit(svc(copyright[1]), "credit_line", copyright[0]);
	const contributed = text.match(/[^.\n]{0,120}\b(The Associated Press|Associated Press|Reuters|AFP|Agence France-Presse)\b[^.\n]{0,80}\bcontributed\b[^.\n]{0,60}/);
	if (contributed) return hit(svc(contributed[1]), "contributed", contributed[0]);
	const onScene = text.match(/[^.\n]{0,80}\b(Associated Press|Reuters|AFP) (?:reporters?|journalists?|photographers?|correspondents?) (?:saw|witnessed|reported|observed|counted|heard)[^.\n]{0,80}/);
	if (onScene) return hit(svc(onScene[1]), "contributed", onScene[0]);
	return null;
}

export class FetchArticleError extends Error {}

export function normalizeDomain(input: string): string {
	let host = input.trim().toLowerCase();
	try {
		if (host.includes("/") || host.includes(":")) {
			host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
		}
	} catch {
		// fall through with raw input
	}
	return host.replace(/^www\./, "").replace(/\.$/, "");
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
	mdash: "—",
	ndash: "–",
	hellip: "…",
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[code.toLowerCase()] ?? m;
	});
}

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

// Pull the first NewsArticle-ish object out of arbitrary JSON-LD.
function findArticleLd(node: unknown): Record<string, unknown> | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const n of node) {
			const hit = findArticleLd(n);
			if (hit) return hit;
		}
		return null;
	}
	const obj = node as Record<string, unknown>;
	const types = ([] as unknown[]).concat(obj["@type"] ?? []).map(String);
	if (types.some((t) => /Article|BlogPosting|Report/i.test(t))) return obj;
	return findArticleLd(obj["@graph"]);
}

function ldName(v: unknown): string | null {
	if (!v) return null;
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		const names = v.map(ldName).filter(Boolean);
		return names.length ? names.join(", ") : null;
	}
	if (typeof v === "object") return ldName((v as Record<string, unknown>).name);
	return null;
}

export async function fetchArticle(url: string): Promise<Article> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new FetchArticleError(`Not a valid URL: ${url}`);
	}
	if (!/^https?:$/.test(parsed.protocol)) throw new FetchArticleError("Only http(s) URLs are supported.");

	let res: Response;
	try {
		res = await fetch(parsed.toString(), {
			redirect: "follow",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});
	} catch (e) {
		const reason = e instanceof Error && e.name === "TimeoutError" ? "timed out" : String(e);
		throw new FetchArticleError(`Could not reach ${parsed.hostname}: ${reason}`);
	}
	if (!res.ok) {
		const hint = res.status === 401 || res.status === 403 ? " (likely a paywall or bot block — ask the user to paste the text)" : "";
		throw new FetchArticleError(`${parsed.hostname} returned HTTP ${res.status}${hint}`);
	}
	const ctype = res.headers.get("content-type") ?? "";
	if (!ctype.includes("html")) throw new FetchArticleError(`Expected an HTML page, got "${ctype || "unknown"}".`);

	const meta: Record<string, string> = {};
	let title = "";
	let lang: string | null = null;
	const ldBlocks: string[] = [];

	let skipDepth = 0;
	let articleDepth = 0;
	let para: string | null = null;
	let paraInArticle = false;
	let paraSkipped = false;
	const articleParas: string[] = [];
	const pageParas: string[] = [];
	const flushPara = () => {
		if (para === null) return;
		const t = clean(para);
		para = null;
		if (!paraSkipped && t.length >= 30) (paraInArticle ? articleParas : pageParas).push(t);
	};

	const rewriter = new HTMLRewriter()
		.on("html", {
			element(e) {
				lang = e.getAttribute("lang");
			},
		})
		.on("title", {
			text(t) {
				title += t.text;
			},
		})
		.on("meta", {
			element(e) {
				const key = (e.getAttribute("property") ?? e.getAttribute("name") ?? e.getAttribute("itemprop"))?.toLowerCase();
				const content = e.getAttribute("content");
				if (key && content && !(key in meta)) meta[key] = content;
			},
		})
		.on('script[type="application/ld+json"]', {
			element() {
				ldBlocks.push("");
			},
			text(t) {
				ldBlocks[ldBlocks.length - 1] += t.text;
			},
		})
		.on(SKIP_SELECTORS.join(", "), {
			element(e) {
				if (onEnd(e, () => skipDepth--)) skipDepth++;
			},
		})
		.on("article, [itemprop=articleBody], main", {
			element(e) {
				if (onEnd(e, () => articleDepth--)) articleDepth++;
			},
		})
		.on("p, h2, h3, blockquote, li", {
			element(e) {
				// HTMLRewriter has no tree builder: implicitly closed <p>/<li> never fire onEndTag, so a
				// new block start also flushes the previous one.
				flushPara();
				para = "";
				paraInArticle = articleDepth > 0;
				paraSkipped = skipDepth > 0;
				onEnd(e, flushPara);
			},
			// Element text handlers also receive text from descendants (links, <em>, …).
			text(t) {
				if (para !== null && skipDepth === 0) para += t.text;
			},
		});

	await rewriter.transform(res).arrayBuffer();
	flushPara();

	let ld: Record<string, unknown> | null = null;
	for (const block of ldBlocks) {
		try {
			ld = findArticleLd(JSON.parse(block));
			if (ld) break;
		} catch {
			// malformed JSON-LD is common; ignore
		}
	}

	const warnings: string[] = [];
	// JSON-LD bodies often glue paragraphs together ("grievances.Interior"); restore the break.
	const ldBody = typeof ld?.articleBody === "string" ? clean(ld.articleBody).replace(/([a-z][.!?]["”’]?)([A-Z])/g, "$1\n\n$2") : "";
	let text: string;
	let text_source: Article["text_source"];
	const articleText = dedupe(articleParas).join("\n\n");
	if (ldBody.length > 500 && ldBody.length >= articleText.length * 0.8) {
		text = ldBody;
		text_source = "json-ld";
	} else if (articleText.length > 500) {
		text = articleText;
		text_source = "article-paragraphs";
	} else {
		text = dedupe([...articleParas, ...pageParas]).join("\n\n");
		text_source = "page-paragraphs";
		warnings.push("No clear <article> body found; text may include non-article content.");
	}
	if (text.length < 300) warnings.push("Very little text extracted — possibly paywalled or rendered by JavaScript. Ask the user to paste the article if needed.");

	const truncated = text.length > MAX_TEXT_CHARS;
	if (truncated) text = text.slice(0, MAX_TEXT_CHARS) + " …";

	const finalUrl = res.url || parsed.toString();
	const publisher = ldName(ld?.publisher);
	const pick = (...vals: (unknown)[]) => {
		for (const v of vals) if (typeof v === "string" && v.trim()) return clean(v);
		return null;
	};

	const author = pick(ldName(ld?.author), meta["author"], meta["article:author"], meta["parsely-author"], meta["sailthru.author"]);

	return {
		url,
		final_url: finalUrl,
		domain: normalizeDomain(finalUrl),
		outlet: pick(meta["og:site_name"], publisher, meta["application-name"]),
		headline: pick(ld?.headline, meta["og:title"], meta["twitter:title"], title),
		description: pick(meta["og:description"], meta["description"], ld?.description),
		author,
		published: pick(ld?.datePublished, meta["article:published_time"], meta["datepublished"], meta["pubdate"], meta["parsely-pub-date"]),
		modified: pick(ld?.dateModified, meta["article:modified_time"], meta["datemodified"]),
		language: lang,
		word_count: text.split(/\s+/).filter(Boolean).length,
		truncated,
		text_source,
		text,
		wire: detectWire(author, text),
		warnings,
	};
}

// Void/self-closing elements throw on onEndTag; report whether an end handler was attached.
function onEnd(e: Element, fn: () => void): boolean {
	try {
		e.onEndTag(fn);
		return true;
	} catch {
		return false;
	}
}

function dedupe(paras: string[]): string[] {
	const seen = new Set<string>();
	return paras.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}
