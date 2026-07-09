import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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

async function wix(path, body) {
  const response = await fetch(`https://www.wixapis.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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

async function createCollection(collection) {
  const result = await wix("/wix-data/v2/collections", { collection });
  if (result.ok) return result.json.collection;

  const rendered = JSON.stringify(result.json);
  if (result.status === 409 || /already|exist/i.test(rendered)) {
    console.log(`Collection ${collection.id} already exists`);
    return collection;
  }

  if ([400, 403, 500, 502, 503, 504].includes(result.status)) {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const retry = await wix("/wix-data/v2/collections", { collection });
    if (retry.ok) return retry.json.collection;
    const retryRendered = JSON.stringify(retry.json);
    if (retry.status === 409 || /already|exist/i.test(retryRendered)) {
      console.log(`Collection ${collection.id} already exists`);
      return collection;
    }
    throw new Error(`Failed to create ${collection.id}: ${retry.status} ${retryRendered}`);
  }

  throw new Error(`Failed to create ${collection.id}: ${result.status} ${rendered}`);
}

async function queryItems(dataCollectionId) {
  const result = await wix("/wix-data/v2/items/query", { dataCollectionId });
  if (!result.ok) {
    throw new Error(`Failed to query ${dataCollectionId}: ${result.status} ${JSON.stringify(result.json)}`);
  }
  return result.json.dataItems ?? result.json.items ?? [];
}

async function insertItems(dataCollectionId, dataItems) {
  const result = await wix("/wix-data/v2/bulk/items/insert", {
    dataCollectionId,
    dataItems: dataItems.map((data) => ({ data })),
    returnEntity: true,
  });
  if (!result.ok) {
    throw new Error(`Failed to insert ${dataCollectionId}: ${result.status} ${JSON.stringify(result.json)}`);
  }
  return result.json.results ?? [];
}

const permissions = {
  read: "ANYONE",
  insert: "ADMIN",
  update: "ADMIN",
  remove: "ADMIN",
};

await createCollection({
  id: "queue-state",
  displayName: "Queue State",
  fields: [
    { key: "title", displayName: "Title", type: "TEXT" },
    { key: "currentHead", displayName: "Current Head", type: "NUMBER" },
    { key: "lastIssued", displayName: "Last Issued", type: "NUMBER" },
    { key: "totalDepartures", displayName: "Total Departures", type: "NUMBER" },
    { key: "startingDepth", displayName: "Starting Depth", type: "NUMBER" },
    { key: "statement", displayName: "Statement", type: "RICH_TEXT" },
    { key: "updatedAt", displayName: "Updated At", type: "DATETIME" },
  ],
  permissions,
});

await createCollection({
  id: "queue-entries",
  displayName: "Queue Entries",
  fields: [
    { key: "ticketNumber", displayName: "Ticket Number", type: "NUMBER" },
    { key: "sessionId", displayName: "Session ID", type: "TEXT" },
    { key: "status", displayName: "Status", type: "TEXT" },
    { key: "joinedAt", displayName: "Joined At", type: "DATETIME" },
    { key: "leftAt", displayName: "Left At", type: "DATETIME" },
    { key: "lastSeenAt", displayName: "Last Seen At", type: "DATETIME" },
  ],
  permissions,
});

const stateItems = await queryItems("queue-state");
let stateId = stateItems[0]?.id ?? stateItems[0]?.data?._id;

if (!stateId) {
  const now = new Date().toISOString();
  const [created] = await insertItems("queue-state", [
    {
      title: "The Queue",
      currentHead: 1,
      lastIssued: 3179,
      totalDepartures: 0,
      startingDepth: 3179,
      statement:
        "<p>A line that exists for no reason. Join, wait, watch the number change, and leave so someone else can move.</p>",
      updatedAt: now,
    },
  ]);
  stateId = created?.dataItem?.id ?? created?.itemMetadata?.id;
}

const summary = {
  siteId,
  collections: {
    queueState: {
      id: "queue-state",
      itemId: stateId,
      fields: ["title", "currentHead", "lastIssued", "totalDepartures", "startingDepth", "statement", "updatedAt"],
    },
    queueEntries: {
      id: "queue-entries",
      fields: ["ticketNumber", "sessionId", "status", "joinedAt", "leftAt", "lastSeenAt"],
    },
  },
};

writeFileSync(new URL("../src/queue-cms.json", import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
