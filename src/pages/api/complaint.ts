import type { APIRoute } from "astro";
import { submissions } from "@wix/forms";
import complaintForm from "../../complaint-form.json";
import { json } from "./queue/_shared";

const CATEGORIES = new Set([
	"line_moved",
	"line_did_not_move",
	"someone_ahead",
	"someone_behind",
	"number_feels_incorrect",
	"other",
]);
const OUTCOMES = new Set(["acknowledgement", "no_action", "referral"]);

function cleanString(value: unknown, maxLength: number) {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export const POST: APIRoute = async ({ request }) => {
	try {
		const body = await request.json();
		const category = cleanString(body.category, 50);
		const complaint = cleanString(body.complaint, 1000);
		const outcome = cleanString(body.outcome, 50);
		const queueSession = cleanString(body.sessionId, 100);

		if (!CATEGORIES.has(category) || !OUTCOMES.has(outcome) || !complaint || !queueSession) {
			return json({ error: "The complaint is procedurally incomplete." }, 400);
		}

		const ticketNumber = Math.max(0, Math.floor(Number(body.ticketNumber) || 0));
		const queuePosition = Math.max(0, Math.floor(Number(body.position) || 0));
		const created = await submissions.createSubmission({
			formId: complaintForm.formId,
			submissions: {
				complaint_category: category,
				complaint,
				requested_outcome: outcome,
				ticket_number: String(ticketNumber),
				queue_position: String(queuePosition),
				queue_session: queueSession,
				submitted_at: new Date().toISOString(),
			},
		});

		if (!created._id) throw new Error("Wix Forms did not return a submission ID.");

		return json({ submissionId: created._id });
	} catch (error) {
		console.error("Unable to file complaint", error);
		return json({ error: "The complaint department is unavailable." }, 500);
	}
};
