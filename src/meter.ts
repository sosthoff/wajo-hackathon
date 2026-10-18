// LaMetric desk display: frames are written to a GitHub gist that a LaMetric indicator app polls.

// LaMetric gallery icons (https://developer.lametric.com/icons); "a" ids are animated.
const ICONS = { note: "i2258", search: "a1622", eye: "a1542", copies: "i1364", balance: "i2068", idea: "i673", ok: "i59", idle: "i1364" };

export interface MeterEnv {
	GITHUB_TOKEN?: string;
	GIST_ID?: string;
	LAMETRIC_FILE?: string;
}

export interface SummaryInput {
	note: string | null; // Fo's latest message, shown first
	links_checked: number;
	stories_compared: number;
	angles_found: number;
	copies_spotted: number;
	week: { left: number; center: number; right: number; rated: number };
	suggestion: string | null; // e.g. "Try: Reason" for the blind spot
}

type Frame = { text: string; icon: string };

// A rolling summary of what media-lens did today and how the week's reading is spread.
// Each frame is one short fact; empty facts are left out.
export function summaryFrames(m: SummaryInput): Frame[] {
	const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
	const frames: Frame[] = [];
	if (m.note) frames.push({ text: m.note.slice(0, 40), icon: ICONS.note });
	if (m.links_checked) frames.push({ text: `Today: ${plural(m.links_checked, "link")} checked`, icon: ICONS.search });
	if (m.stories_compared) frames.push({ text: `${plural(m.stories_compared, "story")} · ${plural(m.angles_found, "angle")}`.replace("storys", "stories"), icon: ICONS.eye });
	if (m.copies_spotted) frames.push({ text: `${plural(m.copies_spotted, "copy")} spotted`.replace("copys", "copies"), icon: ICONS.copies });
	if (m.week.rated) frames.push({ text: `Week: L${m.week.left} C${m.week.center} R${m.week.right}`, icon: ICONS.balance });
	if (m.suggestion) frames.push({ text: m.suggestion, icon: ICONS.idea });
	else if (m.week.rated >= 3) frames.push({ text: "Good mix", icon: ICONS.ok });
	if (!frames.length) frames.push({ text: "media-lens ready", icon: ICONS.idle });
	return frames;
}

export async function publishFrames(env: MeterEnv, frames: Frame[]) {
	if (!env.GITHUB_TOKEN || !env.GIST_ID) {
		throw new Error("LaMetric display not configured: set GIST_ID in wrangler.jsonc vars and the GITHUB_TOKEN secret.");
	}
	const body = JSON.stringify({ frames }, null, 2);

	const file = env.LAMETRIC_FILE || "lametric.json";
	const res = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "media-lens-mcp",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({ files: { [file]: { content: body } } }),
	});
	if (!res.ok) throw new Error(`GitHub gist update failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	const gist = (await res.json()) as { owner?: { login: string } };

	return {
		published: true,
		// Without a commit sha in the path, this URL always serves the latest revision.
		raw_url: `https://gist.githubusercontent.com/${gist.owner?.login ?? "<user>"}/${env.GIST_ID}/raw/${file}`,
		note: "Raw gist URLs are cached for a few minutes; the display updates on its next poll after that.",
		frames,
	};
}
