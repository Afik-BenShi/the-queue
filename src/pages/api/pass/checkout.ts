import type { APIRoute } from "astro";
import { checkout } from "@wix/ecom";
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
		const createdCheckout = await checkout.createCheckout({
			channelType: checkout.ChannelType.WEB,
			lineItems: [
				{
					quantity: 1,
					catalogReference,
				},
			],
		});
		const passLineItem = createdCheckout.lineItems.find(
			(lineItem) =>
				lineItem.catalogReference.catalogItemId === product._id &&
				lineItem.quantity === 1,
		);

		if (!createdCheckout._id || !passLineItem) {
			console.error(
				"Unexpected Wix checkout response",
				JSON.stringify({
					checkoutId: createdCheckout._id,
					calculationErrors: createdCheckout.calculationErrors,
					violations: createdCheckout.violations,
				}),
			);
			throw new Error("Wix checkout did not include the pass line item.");
		}

		const session = await redirects.createRedirectSession({
			ecomCheckout: { checkoutId: createdCheckout._id },
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
