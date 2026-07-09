import { auth } from "@wix/essentials";
import { items } from "@wix/data";

const STATE_COLLECTION = "queue-state";
const ENTRIES_COLLECTION = "queue-entries";
const PASS_REDEMPTIONS_COLLECTION = "pass-redemptions";
export const HEARTBEAT_TTL_MS = 60000;
const MAX_STALE_SWEEP = 100;

type QueueState = {
	_id?: string;
	currentHead?: number;
	lastIssued?: number;
	totalDepartures?: number;
	startingDepth?: number;
	updatedAt?: string;
};

type QueueEntry = {
	_id?: string;
	ticketNumber?: number;
	sessionId?: string;
	status?: string;
	joinedAt?: string;
	leftAt?: string;
	lastSeenAt?: string;
};

type PassRedemption = {
	_id?: string;
	orderId?: string;
	sessionId?: string;
	ticketBefore?: number;
	ticketAfter?: number;
	redeemedAt?: string;
};

export function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function cleanSessionId(value: unknown) {
	return String(value || "")
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 80);
}

export function cleanOrderId(value: unknown) {
	return String(value || "")
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 120);
}

export async function getState() {
	const result = await items.query(STATE_COLLECTION).limit(1).find();
	const state = result.items[0] as QueueState | undefined;
	if (!state) {
		throw new Error("Queue state is missing");
	}
	return state;
}

export async function findActiveEntry(sessionId: string) {
	if (!sessionId) return null;
	const result = await items
		.query(ENTRIES_COLLECTION)
		.eq("sessionId", sessionId)
		.eq("status", "waiting")
		.descending("joinedAt")
		.limit(1)
		.find();
	return (result.items[0] as QueueEntry | undefined) ?? null;
}

export async function findLatestEntry(sessionId: string) {
	if (!sessionId) return null;
	const result = await items
		.query(ENTRIES_COLLECTION)
		.eq("sessionId", sessionId)
		.descending("joinedAt")
		.limit(1)
		.find();
	return (result.items[0] as QueueEntry | undefined) ?? null;
}

export function snapshot(state: QueueState, entry?: QueueEntry | null) {
	const currentHead = Number(state.currentHead ?? 1);
	const lastIssued = Number(state.lastIssued ?? 0);
	const waiting = Math.max(0, lastIssued - currentHead + 1);
	const isWaiting = entry?.status === "waiting";
	const ticketNumber = entry?.ticketNumber ? Number(entry.ticketNumber) : null;
	const position = isWaiting && ticketNumber ? Math.max(0, ticketNumber - currentHead + 1) : null;

	return {
		state: {
			currentHead,
			lastIssued,
			totalDepartures: Number(state.totalDepartures ?? 0),
			startingDepth: Number(state.startingDepth ?? lastIssued),
			waiting,
			updatedAt: state.updatedAt,
		},
		entry: entry
			? {
					ticketNumber,
					status: entry.status ?? "waiting",
					joinedAt: entry.joinedAt,
					leftAt: entry.leftAt,
					lastSeenAt: entry.lastSeenAt,
					position,
				}
			: null,
		presence: {
			heartbeatTtlMs: HEARTBEAT_TTL_MS,
			requiresFocus: true,
		},
	};
}

export async function elevatedInsertEntry(data: Record<string, unknown>) {
	const insertEntry = auth.elevate(items.insert);
	return (await insertEntry(ENTRIES_COLLECTION, data)) as QueueEntry;
}

export async function findPassRedemption(orderId: string) {
	if (!orderId) return null;
	const queryRedemptions = auth.elevate(items.query) as typeof items.query;
	const result = await queryRedemptions(PASS_REDEMPTIONS_COLLECTION)
		.eq("orderId", orderId)
		.limit(1)
		.find();
	return (result.items[0] as PassRedemption | undefined) ?? null;
}

export async function elevatedInsertPassRedemption(data: Record<string, unknown>) {
	const insertRedemption = auth.elevate(items.insert);
	return (await insertRedemption(PASS_REDEMPTIONS_COLLECTION, data)) as PassRedemption;
}

export async function elevatedUpdateState(state: QueueState, fields: Partial<QueueState>) {
	const updateState = auth.elevate(items.update);
	return (await updateState(STATE_COLLECTION, { ...state, ...fields })) as QueueState;
}

export async function elevatedUpdateEntry(entry: QueueEntry, fields: Partial<QueueEntry>) {
	const updateEntry = auth.elevate(items.update);
	return (await updateEntry(ENTRIES_COLLECTION, { ...entry, ...fields })) as QueueEntry;
}

async function findStaleEntries(now = Date.now()) {
	const cutoff = new Date(now - HEARTBEAT_TTL_MS).toISOString();
	const queryEntries = auth.elevate(items.query) as typeof items.query;
	const result = await queryEntries(ENTRIES_COLLECTION)
		.eq("status", "waiting")
		.lt("lastSeenAt", cutoff)
		.ascending("lastSeenAt")
		.limit(MAX_STALE_SWEEP)
		.find();
	return (result.items as QueueEntry[]) ?? [];
}

export async function advanceStateByDepartures(
	state: QueueState,
	count: number,
	now = new Date().toISOString(),
) {
	if (count <= 0) return state;

	const currentHead = Number(state.currentHead ?? 1);
	const lastIssued = Number(state.lastIssued ?? currentHead);
	return elevatedUpdateState(state, {
		currentHead: Math.min(lastIssued + 1, currentHead + count),
		totalDepartures: Number(state.totalDepartures ?? 0) + count,
		updatedAt: now,
	});
}

export async function evictEntry(entry: QueueEntry, now = new Date().toISOString()) {
	return elevatedUpdateEntry(entry, {
		status: "evicted",
		leftAt: now,
		lastSeenAt: now,
	});
}

export async function sweepStaleEntries(state?: QueueState) {
	let nextState = state ?? (await getState());
	const staleEntries = await findStaleEntries();
	if (staleEntries.length === 0) {
		return { state: nextState, evicted: [] as QueueEntry[] };
	}

	const now = new Date().toISOString();
	const evicted: QueueEntry[] = [];
	for (const entry of staleEntries) {
		evicted.push(await evictEntry(entry, now));
	}

	nextState = await advanceStateByDepartures(nextState, evicted.length, now);
	return { state: nextState, evicted };
}
