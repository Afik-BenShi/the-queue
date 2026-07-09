import type { APIRoute } from "astro";
import {
	cleanSessionId,
	elevatedInsertEntry,
	elevatedUpdateEntry,
	elevatedUpdateState,
	findActiveEntry,
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
		const existing = await findActiveEntry(sessionId);
		if (existing) {
			const refreshed = await elevatedUpdateEntry(existing, {
				lastSeenAt: new Date().toISOString(),
			});
			return json(await snapshot(state, refreshed));
		}

		const now = new Date().toISOString();
		const ticketNumber = Number(state.lastIssued ?? 0) + 1;
		state = await elevatedUpdateState(state, {
			lastIssued: ticketNumber,
			updatedAt: now,
		});

		const entry = await elevatedInsertEntry({
			ticketNumber,
			sessionId,
			status: "waiting",
			joinedAt: now,
			lastSeenAt: now,
		});

		return json(await snapshot(state, entry));
	} catch (error) {
		console.error(error);
		return json({ error: "Unable to join the queue." }, 500);
	}
};
