import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@wix/sdk";
import { forms } from "@wix/forms";

const FORMS_APP_ID = "225dd912-7dea-4738-8688-4b8c6955ffc2";
const FORM_NAME = "The Queue Complaints";
const NAMESPACE = "wix.form_app.form";
const config = JSON.parse(readFileSync(new URL("../wix.config.json", import.meta.url), "utf8"));
const siteId = config.siteId;

if (!siteId) throw new Error("Missing siteId in wix.config.json");

const token = execFileSync("yarn", ["wix", "token", "--site", siteId], {
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

function option(label, value) {
  return { _id: randomUUID(), label, value };
}

function textField(target, label, { required = false, hidden = false, maxLength = 1000 } = {}) {
  return {
    _id: randomUUID(),
    hidden,
    identifier: target,
    fieldType: "INPUT",
    inputOptions: {
      target,
      required,
      inputType: "STRING",
      stringOptions: {
        componentType: "TEXT_INPUT",
        textInputOptions: { label, showLabel: true },
        validation: { maxLength },
      },
    },
  };
}

function dropdownField(target, label, options) {
  return {
    _id: randomUUID(),
    identifier: target,
    fieldType: "INPUT",
    inputOptions: {
      target,
      required: true,
      inputType: "STRING",
      stringOptions: {
        componentType: "DROPDOWN",
        dropdownOptions: { label, showLabel: true, options },
        validation: { enum: options.map(({ value }) => value) },
      },
    },
  };
}

const install = await wix("/apps-installer-service/v1/app-instance/install", {
  tenant: { tenantType: "SITE", id: siteId },
  appInstance: { appDefId: FORMS_APP_ID, enabled: true },
});
const installMessage = JSON.stringify(install.json);
if (!install.ok && install.status !== 409 && !/already|installed|exist/i.test(installMessage)) {
  throw new Error(`Failed to install Wix Forms: ${install.status} ${installMessage}`);
}

const client = createClient({
  auth: {
    getAuthHeaders: () => ({
      headers: { Authorization: `Bearer ${token}`, "wix-site-id": siteId },
    }),
    getActiveToken: () => token,
  },
  modules: { forms },
  headers: { "wix-site-id": siteId },
});
const queried = await client.forms
  .queryForms()
  .eq("namespace", NAMESPACE)
  .eq("name", FORM_NAME)
  .limit(1)
  .find();
let form = queried.items[0];
if (!form) {
  const categories = [
    option("The line moved", "line_moved"),
    option("The line did not move", "line_did_not_move"),
    option("Someone is ahead of me", "someone_ahead"),
    option("Someone is behind me", "someone_behind"),
    option("My number feels incorrect", "number_feels_incorrect"),
    option("Other procedural concern", "other"),
  ];
  const outcomes = [
    option("Official acknowledgement", "acknowledgement"),
    option("A thorough lack of action", "no_action"),
    option("Referral to another department", "referral"),
  ];
  form = await client.forms.createForm({
      name: FORM_NAME,
      namespace: NAMESPACE,
      enabled: true,
      spamFilterProtectionLevel: "NONE",
      formFields: [
        dropdownField("complaint_category", "Complaint category", categories),
        textField("complaint", "Complaint", { required: true, maxLength: 1000 }),
        dropdownField("requested_outcome", "Requested outcome", outcomes),
        textField("ticket_number", "Ticket number", { hidden: true, maxLength: 20 }),
        textField("queue_position", "Queue position", { hidden: true, maxLength: 20 }),
        textField("queue_session", "Queue session", { hidden: true, maxLength: 100 }),
        textField("submitted_at", "Submitted at", { hidden: true, maxLength: 40 }),
      ],
  });
}

if (!form._id) throw new Error("Wix Forms did not return a complaint form ID.");

const summary = {
  siteId,
  formsAppId: FORMS_APP_ID,
  namespace: NAMESPACE,
  formId: form._id,
  formName: form.name ?? FORM_NAME,
};
writeFileSync(new URL("../src/complaint-form.json", import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
