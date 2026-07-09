import type { APIRoute } from "astro";
import { auth } from "@wix/essentials";
import { orders } from "@wix/ecom";
import { getPassProduct, STORES_APP_ID } from "../../../lib/pass";
import {
	cleanOrderId,
	cleanSessionId,
	elevatedInsertPassRedemption,
	elevatedUpdateEntry,
	elevatedUpdateState,
	findActiveEntry,
	findPassRedemption,
	getState,
	json,
	snapshot,
	sweepStaleEntries,
} from "../queue/_shared";

const PAID_STATUSES = new Set(["PAID", "PARTIALLY_PAID"]);

function orderContainsPass(order: Awaited<ReturnType<typeof orders.getOrder>>, productId: string) {
	return (order.lineItems ?? []).some((lineItem) => {
		const reference = lineItem.catalogReference;
		return reference?.catalogItemId === productId && reference?.appId === STORES_APP_ID;
	});
}

export const POST: APIRoute = async ({ request }) => {
	try {
		const body = await request.json();
		const sessionId = cleanSessionId(body.sessionId);
		const orderId = cleanOrderId(body.orderId);
		if (!sessionId) return json({ error: "Missing session." }, 400);
		if (!orderId) return json({ error: "Missing order." }, 400);

		const product = await getPassProduct();
		const getOrder = auth.elevate(orders.getOrder) as typeof orders.getOrder;
		const order = await getOrder(orderId);

		if (!orderContainsPass(order, product._id)) {
			return json({ error: "That Wix order does not contain a Queue pass." }, 400);
		}

		if (!PAID_STATUSES.has(String(order.paymentStatus ?? ""))) {
			return json({ error: "That pass is not paid yet." }, 402);
		}

		let state = await getState();
		({ state } = await sweepStaleEntries(state));
		const existingRedemption = await findPassRedemption(orderId);
		const entry = await findActiveEntry(sessionId);

		if (existingRedemption) {
			return json({
				...(await snapshot(state, entry)),
				redemption: {
					alreadyRedeemed: true,
					applied: false,
				},
			});
		}

		if (!entry) {
			return json({ error: "Enter the line before spending this pass." }, 409);
		}

		const now = new Date().toISOString();
		const currentHead = Number(state.currentHead ?? 1);
		const ticketBefore = Number(entry.ticketNumber ?? currentHead);
		const ticketAfter = ticketBefore > currentHead ? ticketBefore - 1 : ticketBefore;

		const movedEntry = await elevatedUpdateEntry(entry, {
			ticketNumber: ticketAfter,
			lastSeenAt: now,
		});
		state = await elevatedUpdateState(state, { updatedAt: now });
		await elevatedInsertPassRedemption({
			orderId,
			sessionId,
			ticketBefore,
			ticketAfter,
			redeemedAt: now,
		});

		return json({
			...(await snapshot(state, movedEntry)),
			redemption: {
				alreadyRedeemed: false,
				applied: ticketAfter < ticketBefore,
				ticketBefore,
				ticketAfter,
			},
		});
	} catch (error) {
		console.error(error);
		return json({ error: "Unable to redeem the pass." }, 500);
	}
};
