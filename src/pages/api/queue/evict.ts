import type { APIRoute } from "astro";
import {
	advanceStateByExits,
	cleanSessionId,
	entryHasReachedTurn,
	evictEntry,
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

		const reachedTurn = await entryHasReachedTurn(entry);
		const now = new Date().toISOString();
		const evictedEntry = await evictEntry(entry, now);
		state = await advanceStateByExits(state, 1, reachedTurn ? 0 : 1, now);

		return json(await snapshot(state, evictedEntry));
	} catch (error) {
		console.error(error);
		return json({ error: "Unable to evict your place." }, 500);
	}
};
