// Daily activity counters: what media-lens did today, for the desk display's summary.
// One small JSON value per UTC day. Read-modify-write is racy under concurrent calls, which is
// fine for a display summary.

export interface Activity {
	links_checked: number; // assess_articles links + fetch_article reads
	stories_compared: number; // find_other_angles runs
	angles_found: number; // recommended angles across those runs
	copies_spotted: number; // outlets found running another outlet's (usually wire) text
	note?: { text: string; t: number }; // Fo's latest message for the user
}

const EMPTY: Activity = { links_checked: 0, stories_compared: 0, angles_found: 0, copies_spotted: 0 };
const key = (t = Date.now()) => `activity:${new Date(t).toISOString().slice(0, 10)}`;

export async function getActivity(kv: KVNamespace): Promise<Activity> {
	return { ...EMPTY, ...((await kv.get<Activity>(key(), "json")) ?? {}) };
}

export async function bumpActivity(kv: KVNamespace, delta: Partial<Omit<Activity, "note">> & { note?: string }): Promise<void> {
	try {
		const a = await getActivity(kv);
		for (const k of ["links_checked", "stories_compared", "angles_found", "copies_spotted"] as const) a[k] += delta[k] ?? 0;
		if (delta.note) a.note = { text: delta.note, t: Date.now() };
		await kv.put(key(), JSON.stringify(a), { expirationTtl: 14 * 86400 });
	} catch {
		// Counters are best-effort; never fail a tool call over them.
	}
}
