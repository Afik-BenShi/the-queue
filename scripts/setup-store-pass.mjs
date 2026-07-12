import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e";
const PASS_HANDLE = "queue-pass-over-one-person";
const PASS_NAME = "Pass Over One Person";

const config = JSON.parse(readFileSync(new URL("../wix.config.json", import.meta.url), "utf8"));
const siteId = config.siteId;

if (!siteId) {
  throw new Error("Missing siteId in wix.config.json");
}

const token = execFileSync("npx", ["@wix/cli@latest", "token", "--site", siteId], {
  encoding: "utf8",
}).trim();

const headers = {
  Authorization: `Bearer ${token}`,
  "wix-site-id": siteId,
  "Content-Type": "application/json",
};

async function wix(path, body, method = "POST") {
  const response = await fetch(`https://www.wixapis.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: response.ok, status: response.status, json };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWrongCatalogVersion(result) {
  const rendered = JSON.stringify(result.json);
  return /CATALOG_V1_SITE_CALLING_CATALOG_V3_API|wrong catalog version/i.test(rendered);
}

async function createCollection(collection) {
  const result = await wix("/wix-data/v2/collections", { collection });
  if (result.ok) return result.json.collection;

  const rendered = JSON.stringify(result.json);
  if (result.status === 409 || /already|exist/i.test(rendered)) {
    console.log(`Collection ${collection.id} already exists`);
    return collection;
  }

  throw new Error(`Failed to create ${collection.id}: ${result.status} ${rendered}`);
}

async function installStores() {
  const result = await wix("/apps-installer-service/v1/app-instance/install", {
    tenant: { tenantType: "SITE", id: siteId },
    appInstance: { appDefId: STORES_APP_ID, enabled: true },
  });

  const rendered = JSON.stringify(result.json);
  if (result.ok || result.status === 409 || /already|installed|exist/i.test(rendered)) {
    return;
  }

  throw new Error(`Failed to install Wix Stores: ${result.status} ${rendered}`);
}

async function getCatalogVersion() {
  const result = await wix("/stores/v3/provision/version", null, "GET");
  if (!result.ok) {
    throw new Error(`Failed to read Stores catalog version: ${result.status} ${JSON.stringify(result.json)}`);
  }

  return result.json.catalogVersion;
}

async function waitForCatalogV3() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const catalogVersion = await getCatalogVersion();
    if (catalogVersion === "V3_CATALOG") {
      return catalogVersion;
    }

    console.log(`Waiting for Wix Stores Catalog V3 provisioning (${catalogVersion || "unknown"}, ${attempt}/20)`);
    await sleep(3000);
  }

  throw new Error("Wix Stores did not finish Catalog V3 provisioning in time.");
}

async function queryProducts() {
  let result;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    result = await wix("/stores/v3/products/query", {
      query: { paging: { limit: 100 } },
      fields: ["PLAIN_DESCRIPTION"],
    });

    if (result.ok || !isWrongCatalogVersion(result)) break;

    console.log(`Waiting for Wix Stores Catalog V3 query readiness (${attempt}/6)`);
    await sleep(5000);
  }

  if (!result.ok) {
    throw new Error(`Failed to query products: ${result.status} ${JSON.stringify(result.json)}`);
  }

  return result.json.products ?? result.json.items ?? [];
}

async function getProduct(productId) {
  const result = await wix(`/stores/v3/products/${productId}`, null, "GET");
  if (!result.ok) {
    throw new Error(`Failed to get product: ${result.status} ${JSON.stringify(result.json)}`);
  }

  return result.json.product;
}

async function uploadPassFile() {
  const uploadUrlResult = await wix("/site-media/v1/files/generate-upload-url", {
    mimeType: "text/plain",
    fileName: "the-queue-pass.txt",
    private: true,
  });

  if (!uploadUrlResult.ok || !uploadUrlResult.json.uploadUrl) {
    throw new Error(
      `Failed to generate pass file upload URL: ${uploadUrlResult.status} ${JSON.stringify(uploadUrlResult.json)}`,
    );
  }

  const uploadResponse = await fetch(uploadUrlResult.json.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "This file is the receipt for one gloriously pointless place in The Queue.\n",
  });
  const uploadJson = await uploadResponse.json();

  if (!uploadResponse.ok || !uploadJson.file?.id) {
    throw new Error(`Failed to upload pass file: ${uploadResponse.status} ${JSON.stringify(uploadJson)}`);
  }

  return uploadJson.file.id;
}

async function deleteProducts(productIds) {
  if (productIds.length === 0) return;
  const result = await wix("/stores/v3/bulk/products/delete", { productIds });
  if (!result.ok) {
    throw new Error(`Failed to clean sample products: ${result.status} ${JSON.stringify(result.json)}`);
  }
}

function richTextDescription() {
  return {
    nodes: [
      {
        type: "PARAGRAPH",
        id: "queue-pass-desc",
        nodes: [
          {
            type: "TEXT",
            textData: {
              text:
                "A tiny paid interruption for The Queue. Redeem it after checkout to move one ticket number closer to the front.",
            },
          },
        ],
        paragraphData: { textStyle: { textAlignment: "AUTO" } },
      },
    ],
    metadata: { version: 1, id: "queue-pass-description" },
  };
}

async function createPassProduct(digitalFileId) {
  const result = await wix("/stores/v3/bulk/products-with-inventory/create", {
    products: [
      {
        name: PASS_NAME,
        slug: "pass-over-one-person",
        handle: PASS_HANDLE,
        productType: "DIGITAL",
        visible: true,
        visibleInPos: false,
        description: richTextDescription(),
        variantsInfo: {
          variants: [
            {
              visible: true,
              price: { actualPrice: { amount: "0.50" } },
              inventoryItem: { inStock: true, preorderInfo: { enabled: false } },
              digitalProperties: { digitalFile: { id: digitalFileId } },
              choices: [],
            },
          ],
        },
      },
    ],
    returnEntity: true,
  });

  if (!result.ok) {
    throw new Error(`Failed to create pass product: ${result.status} ${JSON.stringify(result.json)}`);
  }

  const created = result.json.productResults?.results?.[0];
  if (!created?.itemMetadata?.success) {
    throw new Error(`Pass product was not created: ${JSON.stringify(result.json)}`);
  }

  return created.item;
}

await installStores();
const catalogVersion = await waitForCatalogV3();

await createCollection({
  id: "pass-redemptions",
  displayName: "Pass Redemptions",
  fields: [
    { key: "orderId", displayName: "Order ID", type: "TEXT" },
    { key: "sessionId", displayName: "Session ID", type: "TEXT" },
    { key: "ticketBefore", displayName: "Ticket Before", type: "NUMBER" },
    { key: "ticketAfter", displayName: "Ticket After", type: "NUMBER" },
    { key: "redeemedAt", displayName: "Redeemed At", type: "DATETIME" },
  ],
  permissions: {
    read: "ADMIN",
    insert: "ADMIN",
    update: "ADMIN",
    remove: "ADMIN",
  },
});

let products = await queryProducts();
let passProduct = products.find((product) => product.handle === PASS_HANDLE);

if (passProduct) {
  const productId = passProduct.id ?? passProduct._id;
  const fullProduct = await getProduct(productId);
  const hasDigitalFile = fullProduct.variantsInfo?.variants?.some(
    (variant) => variant.digitalProperties?.digitalFile?.id,
  );

  if (!hasDigitalFile) {
    await deleteProducts([productId]);
    products = products.filter((product) => (product.id ?? product._id) !== productId);
    passProduct = undefined;
  }
}

if (!passProduct) {
  await deleteProducts(products.map((product) => product.id ?? product._id).filter(Boolean));
  const digitalFileId = await uploadPassFile();
  passProduct = await createPassProduct(digitalFileId);
  products = await queryProducts();
  passProduct = products.find((product) => product.handle === PASS_HANDLE) ?? passProduct;
}

const summary = {
  siteId,
  storesAppId: STORES_APP_ID,
  catalogVersion,
  passProduct: {
    id: passProduct.id ?? passProduct._id,
    handle: passProduct.handle ?? PASS_HANDLE,
    name: passProduct.name ?? PASS_NAME,
    price: "0.50",
    currency: passProduct.currency ?? null,
  },
  collections: {
    passRedemptions: {
      id: "pass-redemptions",
      fields: ["orderId", "sessionId", "ticketBefore", "ticketAfter", "redeemedAt"],
    },
  },
};

writeFileSync(new URL("../src/pass-store.json", import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
