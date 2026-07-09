import type { APIRoute } from "astro";
import { currentCart } from "@wix/ecom";
import { redirects } from "@wix/redirects";
import { getPassCatalogReference, getPassProduct } from "../../../lib/pass";
import { json } from "../queue/_shared";

function cleanOrigin(value: unknown) {
	try {
		const url = new URL(String(value || ""));
		if (!["https:", "http:"].includes(url.protocol)) return null;
		return url.origin;
	} catch {
		return null;
	}
}

function callbackUrl(origin: string, passState: string) {
	const url = new URL(origin);
	url.searchParams.set("pass", passState);
	return url.toString();
}

export const POST: APIRoute = async ({ request }) => {
	try {
		const body = await request.json();
		const origin = cleanOrigin(body.origin);
		if (!origin) return json({ error: "Missing checkout origin." }, 400);

		const product = await getPassProduct();
		const catalogReference = await getPassCatalogReference(product._id);

		try {
			const cart = await currentCart.getCurrentCart();
			const passLineIds = (cart.lineItems ?? [])
				.filter((lineItem) => lineItem.catalogReference?.catalogItemId === product._id)
				.map((lineItem) => lineItem._id)
				.filter((lineItemId): lineItemId is string => Boolean(lineItemId));

			if (passLineIds.length > 0) {
				await currentCart.removeLineItemsFromCurrentCart(passLineIds);
			}
		} catch {
			// A visitor may not have a cart yet; adding below creates one.
		}

		await currentCart.addToCurrentCart({
			lineItems: [
				{
					quantity: 1,
					catalogReference,
				},
			],
		});

		const checkout = await currentCart.createCheckoutFromCurrentCart({
			channelType: currentCart.ChannelType.WEB,
		});

		if (!checkout.checkoutId) {
			throw new Error("Wix checkout did not return a checkout ID.");
		}

		const session = await redirects.createRedirectSession({
			ecomCheckout: { checkoutId: checkout.checkoutId },
			callbacks: {
				thankYouPageUrl: callbackUrl(origin, "redeem"),
				postFlowUrl: callbackUrl(origin, "cancelled"),
			},
		});
		const url = session.redirectSession?.fullUrl;

		if (!url) {
			throw new Error("Wix checkout did not return a redirect URL.");
		}

		return json({ url });
	} catch (error) {
		console.error(error);
		return json({ error: "Unable to create a pass checkout." }, 500);
	}
};
