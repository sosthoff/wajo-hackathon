import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { findOtherAngles } from "./angles";
import { FetchArticleError, fetchArticle } from "./article";
import { getMediaDiet, logArticle } from "./diet";
import { bumpActivity, getActivity } from "./activity";
import { publishFrames, summaryFrames } from "./meter";
import { LEANINGS, OUTLET_COUNT, outletProfile } from "./outlets";

type AppEnv = Env & { GITHUB_TOKEN?: string; MEDIACLOUD_API_KEY?: string };

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true });

function createServer(env: AppEnv) {
	const server = new McpServer({ name: "media-lens", version: "0.1.0" });

	server.registerTool(
		"fetch_article",
		{
			description:
				"Fetch a news article URL and return clean plain text plus metadata (headline, outlet, domain, author, publish date). Deterministic extraction, no summarizing. If the page is paywalled or JS-rendered the text may be short; warnings say so.",
			inputSchema: z.object({ url: z.string().describe("Full http(s) URL of the article") }),
		},
		async ({ url }) => {
			try {
				const article = await fetchArticle(url);
				await bumpActivity(env.MEDIA_DIET, { links_checked: 1 });
				return json(article);
			} catch (e) {
				return fail(e instanceof FetchArticleError ? e.message : `Unexpected failure fetching article: ${String(e)}`);
			}
		},
	);

	server.registerTool(
		"outlet_profile",
		{
			description: `Political leaning and factual-reliability ratings for a news outlet from a built-in table of ${OUTLET_COUNT} outlets, citing AllSides, Media Bias/Fact Check and Ad Fontes Media separately with source links. Shows where raters disagree and returns "unknown" for outlets or values not in the table. Leaning and factual reliability are reported separately; neither says anything about a specific article.`,
			inputSchema: z.object({ domain: z.string().describe("Outlet domain or any article URL, e.g. nytimes.com") }),
		},
		async ({ domain }) => json(outletProfile(domain)),
	);

	server.registerTool(
		"find_other_angles",
		{
			description:
				"Find how other outlets cover the same story, grouped by outlet leaning (left → right), with up to three recommended contrasting angles, likely wire-copy duplicates flagged, and suggested next steps. Give an article URL (its headline is fetched) and/or a headline. Checks AllSides' human-curated Headline Roundups first, then searches Media Cloud and Bing News. Syndicated copies are grouped (copy_group), so you can see how many genuinely different versions exist. Results are keyword matches, so confirm each is the same story.",
			inputSchema: z.object({
				url: z.string().optional().describe("The article the user is reading"),
				headline: z.string().optional().describe("Story headline; required if no url"),
				query: z.string().optional().describe("Recommended: 3–5 key words naming the story (who/where/what), e.g. 'France protests students living costs'. Without it a query is built from the headline."),
			}),
		},
		async ({ url, headline, query }) => {
			if (!headline && !url) return fail("Give a url or a headline.");
			let description: string | null = null;
			let author: string | null = null;
			let published: string | null = null;
			if (url) {
				try {
					const a = await fetchArticle(url);
					headline ??= a.headline ?? undefined;
					description = a.description;
					author = a.author;
					published = a.published;
				} catch (e) {
					if (!headline) return fail(`Couldn't read the article to get its headline (${e instanceof Error ? e.message : String(e)}). Pass the headline instead.`);
				}
			}
			if (!headline) return fail("The article has no detectable headline. Pass the headline instead.");
			const result = await findOtherAngles(env, { headline, description, author, published, source_url: url, query });
			await bumpActivity(env.MEDIA_DIET, {
				stories_compared: 1,
				angles_found: result.recommended_angles.filter((a) => a.outlet).length,
				copies_spotted:
					result.copy_groups.reduce((n, g) => n + g.size - 1, 0) +
					result.recommended_angles.filter((a) => "text_origin" in a && String(a.text_origin).includes("wire copy hosted by")).length,
			});
			return json(result);
		},
	);

	server.registerTool(
		"log_article",
		{
			description:
				"Record that the user read an article, for their media-diet tracking. If leaning is omitted it is taken from the outlet table (or stored as unknown). The same URL is only counted once (duplicate: true). Only log articles the user actually read or opened.",
			inputSchema: z.object({
				url: z.string(),
				outlet: z.string().optional().describe("Outlet name; defaults to the table name or domain"),
				leaning: z.enum([...LEANINGS, "unknown"]).optional().describe("Outlet leaning; omit to use the built-in table"),
				topic: z.string().describe("Short topic, e.g. 'economy', 'climate', 'ukraine'"),
				wire: z.string().optional().describe("Agency if fetch_article found wire copy, e.g. 'Associated Press'"),
				via: z.string().optional().describe("Where the user saw it, e.g. 'newsletter: Morning Brew'"),
			}),
		},
		async (input) => {
			const { entry, duplicate } = await logArticle(env.MEDIA_DIET, input);
			return json({ logged: !duplicate, duplicate, entry });
		},
	);

	server.registerTool(
		"assess_articles",
		{
			description:
				"Assess a batch of article links at once, e.g. everything linked from the user's newsletters this morning: outlet, leaning (with confidence) and factual rating per link, plus how the batch is balanced. Set log: true to add them to the media diet (duplicates are skipped) and get the diet before/after. Does not fetch article text; use fetch_article for the ones worth reading.",
			inputSchema: z.object({
				articles: z
					.array(z.object({ url: z.string(), topic: z.string().optional(), title: z.string().optional() }))
					.min(1)
					.max(30),
				log: z.boolean().default(false).describe("Add them to the media diet; only for articles the user actually reads"),
				via: z.string().optional().describe("Where they came from, e.g. 'newsletter: The Morning'"),
			}),
		},
		async ({ articles, log, via }) => {
			const before = log ? await getMediaDiet(env.MEDIA_DIET, 7) : null;
			const rows = [];
			for (const a of articles) {
				const p = outletProfile(a.url);
				const row = {
					url: a.url,
					title: a.title ?? null,
					domain: p.domain,
					outlet: p.found ? (p.outlet as string) : null,
					leaning: p.leaning as string,
					leaning_confidence: p.found ? (p.leaning_confidence as string) : "none",
					factual_reporting_mbfc: p.found ? (p.factual_reliability as { rating: string }[])[0].rating : "unknown",
					logged: false,
					duplicate: false,
				};
				if (log) {
					const r = await logArticle(env.MEDIA_DIET, { url: a.url, topic: a.topic ?? "general", via });
					row.logged = !r.duplicate;
					row.duplicate = r.duplicate;
				}
				rows.push(row);
			}
			const sideOf = (l: string) => (l === "left" || l === "lean_left" ? "left" : l === "center" ? "center" : l === "lean_right" || l === "right" ? "right" : "unrated");
			const sides = { left: 0, center: 0, right: 0, unrated: 0 };
			for (const r of rows) sides[sideOf(r.leaning)]++;
			const rated = rows.length - sides.unrated;
			await bumpActivity(env.MEDIA_DIET, { links_checked: rows.length });
			const after = log ? await getMediaDiet(env.MEDIA_DIET, 7) : null;
			return json({
				headline:
					`${rows.length} links: ${sides.left} left-leaning, ${sides.center} center, ${sides.right} right-leaning, ${sides.unrated} unrated outlets.` +
					(rated >= 3 && (sides.left === 0 || sides.right === 0) ? ` This batch has nothing from the ${sides.right === 0 ? "right" : "left"}.` : ""),
				sides,
				articles: rows,
				...(log
					? {
							diet_change: {
								balance_before: before!.balance_score,
								balance_after: after!.balance_score,
								lean_before: before!.lean,
								lean_after: after!.lean,
								signal_after: after!.signal,
								headline_after: after!.headline,
							},
						}
					: {}),
				suggested_actions: [
					{ action: "fetch_article + find_other_angles on the one or two links the user is most likely to read, to show other angles", needs_user_approval: false },
					...(log ? [{ action: "update_desk_display so the desk display reflects today's work and the updated week", needs_user_approval: false }] : []),
				],
				caveats: ["Leaning is per outlet, not per article. Unrated means not in our table, not neutral."],
			});
		},
	);

	server.registerTool(
		"get_media_diet",
		{
			description:
				"Summarize what the user has read over the last N days. Starts with a plain-language headline, a signal level (not_enough_data / balanced / mild_tilt / strong_tilt) with a suggested channel (display only, weekly report, or a short text), the blind spot with well-rated outlets to fill it, and suggested actions marked with needs_user_approval. Then the details: leaning distribution, balance score (-2 left … +2 right), outlet mix, wire-copy share, topics.",
			inputSchema: z.object({ days: z.number().int().min(1).max(180).default(7) }),
		},
		async ({ days }) => json(await getMediaDiet(env.MEDIA_DIET, days)),
	);

	server.registerTool(
		"update_desk_display",
		{
			description:
				"Refresh the user's LaMetric desk display with a rolling summary: today's work (links checked, stories compared, angles found, wire copies spotted), this week's left/center/right reading split, and a suggestion for the blind spot. Optional note (≤40 chars) is shown first and kept for 12 hours — use it to point at what you just sent, e.g. '3 angles in your texts'. Call after checking links, comparing a story, or sending the user something.",
			inputSchema: z.object({ note: z.string().max(40).optional() }),
		},
		async ({ note }) => {
			try {
				if (note) await bumpActivity(env.MEDIA_DIET, { note });
				const [a, d] = await Promise.all([getActivity(env.MEDIA_DIET), getMediaDiet(env.MEDIA_DIET, 7)]);
				const dist = d.leaning_distribution as Record<string, { count: number }>;
				const week = {
					left: dist.left.count + dist.lean_left.count,
					center: dist.center.count,
					right: dist.right.count + dist.lean_right.count,
					rated: d.articles_logged - dist.unknown.count,
				};
				const top = d.blind_spot?.well_rated_outlets[0];
				const frames = summaryFrames({
					note: a.note && Date.now() - a.note.t < 12 * 3600_000 ? a.note.text : null,
					links_checked: a.links_checked,
					stories_compared: a.stories_compared,
					angles_found: a.angles_found,
					copies_spotted: a.copies_spotted,
					week,
					suggestion: top ? `Try: ${top.replace(/ \(.*\)$/, "")}` : null,
				});
				return json({ ...(await publishFrames(env, frames)), today: { ...a, note: a.note?.text ?? null }, week });
			} catch (e) {
				return fail(e instanceof Error ? e.message : String(e));
			}
		},
	);

	return server;
}

export default {
	fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
		return createMcpHandler(() => createServer(env))(request, env, ctx);
	},
} satisfies ExportedHandler<AppEnv>;
