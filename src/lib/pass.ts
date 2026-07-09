import { productsV3, readOnlyVariantsV3 } from "@wix/stores";

export const STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e";
export const PASS_PRODUCT_HANDLE = "queue-pass-over-one-person";

type ProductQueryResult = Awaited<ReturnType<ReturnType<typeof productsV3.queryProducts>["find"]>>;
type ProductItem = ProductQueryResult["items"][number];

export type PassProduct = ProductItem & { _id: string };

export async function getPassProduct(): Promise<PassProduct> {
	const result = await productsV3
		.queryProducts()
		.eq("handle", PASS_PRODUCT_HANDLE)
		.limit(1)
		.find();
	const product = result.items[0];

	if (!product?._id) {
		throw new Error("The pass product is missing from Wix Stores.");
	}

	return product as PassProduct;
}

export async function getPassVariantId(productId: string) {
	const variants = await readOnlyVariantsV3
		.queryVariants()
		.eq("productData.productId", productId)
		.limit(1)
		.find();
	const variant = variants.items[0];
	const variantId = variant?.variantId ?? variant?._id;

	if (!variantId) {
		throw new Error("The pass product has no purchasable variant.");
	}

	return variantId;
}

export async function getPassCatalogReference(productId: string) {
	const variantId = await getPassVariantId(productId);

	return {
		catalogItemId: productId,
		appId: STORES_APP_ID,
		options: { variantId },
	};
}
