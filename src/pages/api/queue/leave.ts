import type { APIRoute } from "astro";
import {
	cleanSessionId,
	advanceStateByDepartures,
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
		if (!entry) return json(await snapshot(state, await findLatestEntry(sessionId)));

		const now = new Date().toISOString();
		const leftEntry = await elevatedUpdateEntry(entry, {
			status: "left",
			leftAt: now,
			lastSeenAt: now,
		});
		state = await advanceStateByDepartures(state, 1, now);

		return json(await snapshot(state, leftEntry));
	} catch (error) {
		console.error(error);
		return json({ error: "Unable to leave the queue." }, 500);
	}
};
