// Built-in outlet table for outlet_profile.
//
// Values are a hand-compiled snapshot of public ratings from three raters. Ratings change and
// raters rate different things (AllSides: online news bias; MBFC: bias + factual reporting;
// Ad Fontes: bias + reliability of sampled articles). null = not recorded here → "unknown".
// Never fill a gap by guessing; add a value only after checking the rater's own page.

import { normalizeDomain } from "./article";

export type Leaning = "left" | "lean_left" | "center" | "lean_right" | "right";
export const LEANINGS: Leaning[] = ["left", "lean_left", "center", "lean_right", "right"];
export const LEANING_SCORE: Record<Leaning, number> = { left: -2, lean_left: -1, center: 0, lean_right: 1, right: 2 };

type AllSides = "Left" | "Lean Left" | "Center" | "Lean Right" | "Right";
type MbfcBias = "Left" | "Left-Center" | "Least Biased" | "Right-Center" | "Right" | "Questionable";
type MbfcFactual = "Very High" | "High" | "Mostly Factual" | "Mixed" | "Low" | "Very Low";
type AfBias = "Left" | "Skews Left" | "Middle" | "Skews Right" | "Right";
type AfReliability = "Reliable" | "Generally Reliable" | "Mixed Reliability" | "Unreliable";

interface Outlet {
	name: string;
	domains: string[];
	country: string;
	allsides: AllSides | null;
	mbfc_bias: MbfcBias | null;
	mbfc_factual: MbfcFactual | null;
	adfontes_bias: AfBias | null;
	adfontes_reliability: AfReliability | null;
}

const _ = null;
// prettier-ignore
const ROWS: [string, string[], string, AllSides | null, MbfcBias | null, MbfcFactual | null, AfBias | null, AfReliability | null][] = [
	// name                       domains                                   country  AllSides       MBFC bias        MBFC factual      AF bias        AF reliability
	["Reuters",                   ["reuters.com"],                          "INT", "Center",     "Least Biased", "Very High",      "Middle",      "Reliable"],
	["Associated Press",          ["apnews.com"],                           "US",  "Lean Left",  "Left-Center",  "High",           "Middle",      "Reliable"],
	["BBC News",                  ["bbc.com", "bbc.co.uk"],                 "UK",  "Center",     "Left-Center",  "High",           "Middle",      "Reliable"],
	["NPR",                       ["npr.org"],                              "US",  "Lean Left",  "Left-Center",  "High",           "Skews Left",  "Reliable"],
	["PBS NewsHour",              ["pbs.org"],                              "US",  _,            "Left-Center",  "High",           "Middle",      "Reliable"],
	["Christian Science Monitor", ["csmonitor.com"],                        "US",  "Center",     _,              "High",           "Middle",      _],
	["The New York Times",        ["nytimes.com"],                          "US",  "Lean Left",  "Left-Center",  "High",           "Skews Left",  "Generally Reliable"],
	["The Washington Post",       ["washingtonpost.com"],                   "US",  "Lean Left",  "Left-Center",  _,                "Skews Left",  "Generally Reliable"],
	["The Wall Street Journal",   ["wsj.com"],                              "US",  "Center",     "Right-Center", _,                "Middle",      "Reliable"],
	["Los Angeles Times",         ["latimes.com"],                          "US",  "Lean Left",  "Left-Center",  "High",           _,             _],
	["USA Today",                 ["usatoday.com"],                         "US",  "Lean Left",  "Left-Center",  _,                _,             _],
	["NBC News",                  ["nbcnews.com"],                          "US",  "Lean Left",  "Left-Center",  "High",           "Skews Left",  _],
	["CBS News",                  ["cbsnews.com"],                          "US",  "Lean Left",  "Left-Center",  "High",           _,             _],
	["ABC News",                  ["abcnews.go.com", "abcnews.com"],        "US",  "Lean Left",  "Left-Center",  "High",           _,             _],
	["CNN",                       ["cnn.com"],                              "US",  "Left",       "Left",         "Mixed",          "Skews Left",  _],
	["MSNBC",                     ["msnbc.com"],                            "US",  "Left",       "Left",         "Mixed",          "Skews Left",  "Mixed Reliability"],
	["Fox News",                  ["foxnews.com"],                          "US",  "Right",      "Right",        "Mixed",          "Skews Right", "Mixed Reliability"],
	["Politico",                  ["politico.com", "politico.eu"],          "US",  "Lean Left",  "Left-Center",  "High",           _,             _],
	["Axios",                     ["axios.com"],                            "US",  _,            "Left-Center",  "High",           _,             _],
	["The Hill",                  ["thehill.com"],                          "US",  "Center",     _,              _,                "Middle",      _],
	["Bloomberg",                 ["bloomberg.com"],                        "US",  "Lean Left",  "Left-Center",  "High",           "Middle",      _],
	["Newsweek",                  ["newsweek.com"],                         "US",  "Center",     _,              _,                _,             _],
	["Time",                      ["time.com"],                             "US",  "Lean Left",  "Left-Center",  "High",           "Skews Left",  _],
	["The Atlantic",              ["theatlantic.com"],                      "US",  "Lean Left",  "Left-Center",  "High",           "Skews Left",  _],
	["Vox",                       ["vox.com"],                              "US",  "Left",       "Left",         "High",           "Skews Left",  _],
	["HuffPost",                  ["huffpost.com", "huffingtonpost.com"],   "US",  "Left",       "Left",         _,                "Skews Left",  _],
	["Mother Jones",              ["motherjones.com"],                      "US",  "Left",       "Left",         "High",           "Skews Left",  _],
	["The Intercept",             ["theintercept.com"],                     "US",  "Left",       "Left",         _,                "Skews Left",  _],
	["Reason",                    ["reason.com"],                           "US",  "Lean Right", "Right-Center", "High",           _,             _],
	["New York Post",             ["nypost.com"],                           "US",  "Lean Right", "Right-Center", "Mixed",          "Skews Right", "Mixed Reliability"],
	["Washington Examiner",       ["washingtonexaminer.com"],               "US",  "Lean Right", "Right",        _,                "Skews Right", _],
	["National Review",           ["nationalreview.com"],                   "US",  "Right",      "Right",        "Mostly Factual", "Skews Right", _],
	["The Daily Wire",            ["dailywire.com"],                        "US",  "Right",      "Right",        "Mixed",          "Skews Right", _],
	["The Daily Caller",          ["dailycaller.com"],                      "US",  "Right",      "Right",        "Mixed",          _,             _],
	["The Federalist",            ["thefederalist.com"],                    "US",  "Right",      "Right",        _,                _,             _],
	["Newsmax",                   ["newsmax.com"],                          "US",  "Right",      "Right",        _,                "Right",       _],
	["Breitbart",                 ["breitbart.com"],                        "US",  "Right",      "Questionable", "Mixed",          "Right",       "Unreliable"],
	["The Guardian",              ["theguardian.com", "guardian.co.uk"],    "UK",  _,            "Left-Center",  _,                "Skews Left",  _],
	["The Independent",           ["independent.co.uk"],                    "UK",  "Lean Left",  "Left-Center",  _,                _,             _],
	["The Telegraph",             ["telegraph.co.uk"],                      "UK",  "Lean Right", "Right-Center", _,                _,             _],
	["Daily Mail",                ["dailymail.co.uk"],                      "UK",  "Right",      _,              _,                _,             _],
	["The Economist",             ["economist.com"],                        "UK",  "Lean Left",  _,              "High",           _,             _],
	["Financial Times",           ["ft.com"],                               "UK",  "Center",     _,              "High",           _,             _],
	["Al Jazeera",                ["aljazeera.com"],                        "QA",  "Lean Left",  "Left-Center",  "Mixed",          _,             _],
	["Deutsche Welle",            ["dw.com"],                               "DE",  _,            _,              "High",           _,             _],
];

const OUTLETS: Outlet[] = ROWS.map(([name, domains, country, allsides, mbfc_bias, mbfc_factual, adfontes_bias, adfontes_reliability]) => ({
	name,
	domains,
	country,
	allsides,
	mbfc_bias,
	mbfc_factual,
	adfontes_bias,
	adfontes_reliability,
}));

const ALLSIDES_TO: Record<AllSides, Leaning> = {
	Left: "left",
	"Lean Left": "lean_left",
	Center: "center",
	"Lean Right": "lean_right",
	Right: "right",
};
// "Questionable" is a reliability flag, not a position, so it does not map to a leaning.
const MBFC_TO: Partial<Record<MbfcBias, Leaning>> = {
	Left: "left",
	"Left-Center": "lean_left",
	"Least Biased": "center",
	"Right-Center": "lean_right",
	Right: "right",
};
const AF_TO: Record<AfBias, Leaning> = {
	Left: "left",
	"Skews Left": "lean_left",
	Middle: "center",
	"Skews Right": "lean_right",
	Right: "right",
};

export function findOutlet(domainOrUrl: string): Outlet | null {
	const host = normalizeDomain(domainOrUrl);
	return OUTLETS.find((o) => o.domains.some((d) => host === d || host.endsWith(`.${d}`))) ?? null;
}

function raterLinks(name: string) {
	const q = encodeURIComponent(name);
	return {
		allsides: `https://www.allsides.com/search?search=${q}`,
		mbfc: `https://mediabiasfactcheck.com/?s=${q}`,
		adfontes: `https://adfontesmedia.com/?s=${q}`,
	};
}

export function outletProfile(domainOrUrl: string) {
	const domain = normalizeDomain(domainOrUrl);
	const o = findOutlet(domain);
	if (!o) {
		return {
			domain,
			found: false,
			leaning: "unknown",
			factual_reliability: "unknown",
			confidence: "none",
			note: "Outlet is not in the built-in table. Do not infer a leaning from the name; check the raters directly.",
			check_yourself: raterLinks(domain),
		};
	}

	const links = raterLinks(o.name);
	const ratings = [
		{ rater: "AllSides", measures: "political bias of online news", raw: o.allsides, leaning: o.allsides ? ALLSIDES_TO[o.allsides] : null, source: links.allsides },
		{ rater: "Media Bias/Fact Check", measures: "political bias", raw: o.mbfc_bias, leaning: o.mbfc_bias ? MBFC_TO[o.mbfc_bias] ?? null : null, source: links.mbfc },
		{ rater: "Ad Fontes Media", measures: "political bias of sampled articles", raw: o.adfontes_bias, leaning: o.adfontes_bias ? AF_TO[o.adfontes_bias] : null, source: links.adfontes },
	];
	const leaningRatings = ratings.filter((r) => r.leaning) as (typeof ratings[number] & { leaning: Leaning })[];
	const scores = leaningRatings.map((r) => LEANING_SCORE[r.leaning]);

	let leaning: Leaning | "unknown" = "unknown";
	let confidence: "high" | "medium" | "low" | "none" = "none";
	let disagreement: string | null = null;
	if (scores.length) {
		const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
		leaning = LEANINGS[Math.round(mean) + 2];
		const spread = Math.max(...scores) - Math.min(...scores);
		if (spread >= 2) {
			confidence = "low";
			disagreement = `Raters differ by ${spread} steps on the left–right scale: ${leaningRatings.map((r) => `${r.rater} says ${r.raw}`).join("; ")}.`;
		} else if (spread === 1) {
			confidence = scores.length >= 2 ? "medium" : "low";
			disagreement = `Raters differ by one step: ${leaningRatings.map((r) => `${r.rater} says ${r.raw}`).join("; ")}.`;
		} else {
			confidence = scores.length >= 2 ? "high" : "medium";
		}
	}

	return {
		domain,
		found: true,
		outlet: o.name,
		country: o.country,
		// Political leaning — a property of the outlet's overall output, not of any one article.
		leaning,
		leaning_confidence: confidence,
		raters_agree: disagreement === null && scores.length >= 2,
		disagreement,
		leaning_ratings: ratings.map(({ rater, measures, raw, leaning, source }) => ({ rater, measures, rating: raw ?? "unknown", maps_to: leaning ?? "unknown", source })),
		// Factual reliability — kept separate from leaning on purpose.
		factual_reliability: [
			{ rater: "Media Bias/Fact Check", measures: "factual reporting record", rating: o.mbfc_factual ?? "unknown", questionable_source_flag: o.mbfc_bias === "Questionable", source: links.mbfc },
			{ rater: "Ad Fontes Media", measures: "reliability of sampled articles", rating: o.adfontes_reliability ?? "unknown", source: links.adfontes },
		],
		caveats: [
			"Snapshot table compiled from the raters' public pages; ratings change over time. Follow the source links before citing a rating.",
			"An outlet rating describes the outlet on average. It says nothing about whether a specific article is accurate or how it frames this story — check those separately.",
		],
	};
}

// Outlets the raters broadly agree sit at a given leaning AND that have a recorded good factual
// rating (unknown doesn't qualify). Used to suggest a missing perspective in the media diet.
export function suggestOutlets(target: Leaning, limit = 3): string[] {
	const good = new Set<MbfcFactual>(["Very High", "High", "Mostly Factual"]);
	return OUTLETS.filter((o) => {
		const p = outletProfile(o.domains[0]);
		return p.leaning === target && p.leaning_confidence !== "low" && o.mbfc_factual !== null && good.has(o.mbfc_factual);
	})
		.slice(0, limit)
		.map((o) => `${o.name} (${o.domains[0]})`);
}

export const OUTLET_COUNT = OUTLETS.length;

// Main domains of rated outlets at the given leanings, best factual record first. Used for
// targeted searches when a general search buries a part of the spectrum.
export function outletDomains(target: Leaning[], limit = 8): string[] {
	const rank: Record<string, number> = { "Very High": 0, High: 1, "Mostly Factual": 2 };
	return OUTLETS.filter((o) => {
		const l = outletProfile(o.domains[0]).leaning;
		return l !== "unknown" && target.includes(l as Leaning) && o.mbfc_bias !== "Questionable";
	})
		.sort((a, b) => (rank[a.mbfc_factual ?? ""] ?? 3) - (rank[b.mbfc_factual ?? ""] ?? 3))
		.slice(0, limit)
		.map((o) => o.domains[0]);
}
