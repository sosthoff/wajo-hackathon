# media-lens — Wajo hackathon project

## What this is
A remote MCP server (Cloudflare Workers, TypeScript) that gives **Fo** — Wajo's real-world agent — media-literacy tools. Fo registers this server and calls its tools like its own. Goal: a proactive news coach that helps users become more media-savvy: check claims against primary sources, see how different outlets frame the same story, understand political leaning, and track the balance of their own media diet.

2-day hackathon. Keep everything small, free and demo-reliable.

## Judging criteria (weight)
- Real need — 30
- Get things done — 25
- Pushes the boundaries — 25
- Trust by design — 20
- Agent craft — 20
- Hardware bonus — +5 (optional: LaMetric Time display)

## Architecture
- **Fo = reasoning + action.** Fo reads the user's Gmail newsletters, texts/emails the user, runs on schedules, makes calls and purchases, and asks for approval before money, irreversible actions, or contacting anyone the user didn't name. Fo can also run sandboxed code and make HTTP requests.
- **This server = deterministic data + tools.** No LLM inside the server and no API keys: Fo does the judgment, the server supplies trustworthy inputs. Keeps it free and makes the split clear to judges.
- **Storage:** Cloudflare KV (free tier) for the media-diet log.
- **LaMetric (optional):** LaMetric indicator app in *poll* mode reads a raw gist URL serving `lametric.json` (`{"frames":[{"text":"...","icon":"i1234"}]}`). The server updates that file in a gist via the GitHub API (fine-grained token as a Worker secret). Raw GitHub URLs cache for a few minutes — fine for a daily meter.

## Deployment
- Created from template `cloudflare/ai/demos/remote-mcp-authless` (no auth).
- Live at `https://media-lens.wajohack.workers.dev`, MCP endpoint `/mcp`.
- Deploy: `npx wrangler deploy` from this folder.
- Already registered with Fo and verified end to end (Fo listed tools and called demo `add(2,3)` → 5). After redeploying, Fo picks up tool changes; ask Fo to re-list tools to confirm.
- The SSL handshake error printed after the very first deploy was just the new subdomain's certificate not being issued yet — ignore.

## Current state
All four tools are built and deployed (2026-10-17). Files: `src/index.ts` (tool registration), `src/article.ts` (HTMLRewriter extraction), `src/outlets.ts` (rater table, 45 outlets), `src/diet.ts` (KV log, records live in key metadata), `src/meter.ts` (LaMetric via GitHub contents API).
- KV namespace `MEDIA_DIET` = `82e42a1718f841dc99eeb9c177cd1ded`. Local `wrangler dev` uses a separate local KV.
- Tested: fetch_article works on BBC, Guardian, NPR; Reuters/NYT return 401/403 (bot block) → clear error, Fo should ask the user to paste text. Fox homepage (JS-heavy) yields no text.
- HTMLRewriter gotchas: `onDocument` text handlers don't receive element text; `onEndTag` throws on void elements and never fires for implicitly closed `<p>`/`<li>`. Skip-by-class selectors are therefore limited to always-closed containers.
- Outlet table values were compiled from memory and are **not yet spot-checked** against the rater sites; null = unknown. Verify before the demo.
- `publish_balance_meter` PATCHes gist `dc39ce16…` (file `gistfile1.txt`, LaMetric polls https://gist.githubusercontent.com/sosthoff/dc39ce16bafd683d514130b9292afa18/raw/gistfile1.txt). `GITHUB_TOKEN` secret is set (fine-grained, Gists r/w — revoke after hackathon). Verified end to end 2026-10-17; Icons: i1364 news (text), i2068 balance (bar), i625 unknown.
- `find_other_angles` (`src/angles.ts`, `src/allsides.ts`): sources in priority order: AllSides Headline Roundups RSS (human-curated L/C/R; story pages are behind a Cloudflare bot challenge, so we use only the feed), Media Cloud story-list API (US National collection 34412234; needs `MEDIACLOUD_API_KEY` secret, skipped without it), Bing News RSS (real URLs). Google News was dropped: it returns nothing from Cloudflare IPs. GDELT was tested and rejected (noisy, 1 req/5s global limit). Results are clustered by headline similarity (≥0.6) into `copy_group`s so syndicated copies count once; recommendations take one version per cluster per slot.
  - Per-slot targeted Bing searches (`site:` lists of rated outlets from `outletDomains`) fix the center/right being buried under local AP copies.
  - Picks: primary + secondary per slot (center, left, right); must be on-story (key names/places present, ≤2 days with ≥40% query words or ≤4 days with ≥60%). Top 4 on-story candidates per slot are read with `fetch_article` to detect wire copy (`detectWire`: byline, dateline, Reuters credit line, copyright, "contributed", "AP reporters saw"); wire copy counts as the agency's angle (`text_origin`) and a verified wire member marks its whole copy group. `considered_but_skipped` explains every rated outlet not picked.
- Tool responses share a shape: `headline` (one line for the user), `suggested_actions` with `needs_user_approval`, `caveats`. find_other_angles, get_media_diet and assess_articles have it; outlet_profile doesn't yet.
- `get_media_diet` adds `signal` (not_enough_data / balanced / mild_tilt / strong_tilt ≥70% one side with ≥5 rated reads) → `suggested_channel` (display only / + weekly report / + short text), `blind_spot` with well-rated outlets, `display` lines for the LaMetric.
- KV `list()` lags writes by up to ~60s, so `log_article` also appends to a direct-read `recent-log` key (last 100) that `get_media_diet` merges in.
- `log_article` dedupes by URL (tracking params stripped; `seen:<sha>` keys) and accepts `wire` and `via`. `assess_articles` = batch profile for newsletter links, optional logging with diet before/after.
- Desk display: tool `update_desk_display(note?)` (was publish_balance_meter). Rolling summary frames, no "diet" wording: Fo's note (i2258, kept 12h) → "Today: N links checked" (a1622) → "N stories · M angles" (a1542) → "N copies spotted" (i1364) → "Week: L6 C4 R2" (i2068) → "Try: <outlet>" for the blind spot (i673) or "Good mix" (i59). Counters live in KV `activity:YYYY-MM-DD` (`src/activity.ts`), bumped by fetch_article, assess_articles and find_other_angles.
- Demo inbox: wajohackathon@gmail.com, linked to Fo. Fo is subscribing it to free newsletters across the spectrum — 9 subscribed 2026-10-17: NPR Up First, CNN 5 Things, Vox Today Explained / AP Morning Wire, 1440, Semafor Flagship / Fox News First, NR Morning Jolt, Examiner Today. Guardian failed, Axios needs an account. Welcome emails have almost no article links; real issues arrive from the next morning.
- Fo picks up new tools/schemas only after re-listing, and the refresh goes live on the *next* message.

## Tools to build (in order)
1. `fetch_article(url)` → clean article text, headline, outlet name, domain, publish date, author if available. Strip nav/ads; return plain text. Handle fetch failures gracefully with a clear error.
2. `outlet_profile(domain)` → leaning and reliability for the outlet from a small built-in table (start with ~30–50 major US/international outlets), citing which rater each value comes from (AllSides, Ad Fontes Media, Media Bias/Fact Check). Show where raters disagree. Return "unknown" rather than guessing.
3. `log_article(url, outlet, leaning, topic)` / `get_media_diet(days)` → KV-backed record of what the user reads; summary of leaning distribution, outlet mix, topics never seen.
4. `publish_balance_meter(score, text)` → commits `lametric.json` to the GitHub repo.

## Trust-by-design principles (bake into tool outputs)
- Evidence, not verdicts: always return sources/links behind any rating.
- Keep three things separate: factual accuracy, framing, political leaning.
- Confidence levels on every label; "unknown" is an acceptable answer.
- Server never contacts third parties; any outreach (correction requests, verifying a quote with a press office, subscriptions) is done by Fo behind its approval gate — show that gate in the demo.

## Demo ideas
- Paste an article → Fo calls `fetch_article` + `outlet_profile`, extracts claims, checks them, compares framing with 2–3 outlets across the spectrum.
- Morning "three angles" text on the top story from the user's inbox.
- Weekly media-diet report; Fo suggests (and, with approval, subscribes to) a missing perspective.
- Boundary-pusher: Fo drafts a correction request to a newsroom, or emails/calls a press office to verify a quote — with explicit user approval.
