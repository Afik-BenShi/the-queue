import type { APIRoute } from "astro";
import {
	cleanSessionId,
	elevatedUpdateEntry,
	findActiveEntry,
	findLatestEntry,
	getState,
	json,
	snapshot,
	sweepStaleEntries,
} from "./_shared";

export const POST: APIRoute = async ({ request }) => {
	try {
		const body = await request.json();
		const sessionId = cleanSessionId(body.sessionId);
		if (!sessionId) return json({ error: "Missing session." }, 400);

		let state = await getState();
		({ state } = await sweepStaleEntries(state));
		const entry = await findActiveEntry(sessionId);

		if (!entry) {
			return json(await snapshot(state, await findLatestEntry(sessionId)));
		}

		const refreshed = await elevatedUpdateEntry(entry, {
			lastSeenAt: new Date().toISOString(),
		});

		return json(await snapshot(state, refreshed));
	} catch (error) {
		console.error(error);
		return json({ error: "Unable to keep your place in line." }, 500);
	}
};
