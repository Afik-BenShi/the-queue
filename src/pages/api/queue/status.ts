import type { APIRoute } from "astro";
import {
	cleanSessionId,
	findActiveEntry,
	findLatestEntry,
	getState,
	json,
	snapshot,
	sweepStaleEntries,
} from "./_shared";

export const GET: APIRoute = async ({ url }) => {
	try {
		const sessionId = cleanSessionId(url.searchParams.get("sessionId"));
		let state = await getState();
		({ state } = await sweepStaleEntries(state));
		const entry = (await findActiveEntry(sessionId)) ?? (await findLatestEntry(sessionId));
		return json(await snapshot(state, entry));
	} catch (error) {
		console.error(error);
		return json({ error: "Unable to read the queue." }, 500);
	}
};
