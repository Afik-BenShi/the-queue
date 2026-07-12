import { useEffect, useReducer, useRef, type FormEvent } from "react";

type QueueState = {
	_id?: string;
	currentHead?: number;
	lastIssued?: number;
	totalDepartures?: number;
	startingDepth?: number;
	waiting?: number;
};

type Entry = {
	ticketNumber?: number;
	status?: "waiting" | "left" | "evicted";
	joinedAt?: string;
	leftAt?: string;
	position?: number | null;
} | null;

type TurnState = {
	minimumWaitMs: number;
	serverNow: string;
	eligibleAt: string | null;
	remainingMs: number;
	isFirst: boolean;
	canTakeTurn: boolean;
};

const HEARTBEAT_INTERVAL_MS = 3000;
const UNFOCUS_GRACE_MS = 60000;
const DEFAULT_MINIMUM_WAIT_MS = 3 * 60 * 1000;
const SESSION_KEY = "the-queue-session-id";
const ENTRY_KEY = "the-queue-entry";
const PENDING_PASS_KEY = "the-queue-pending-pass-order";
const REDEEMED_PASSES_KEY = "the-queue-redeemed-pass-orders";
const TICKET_REPRIMANDS = [
	{ at: 5, message: "Stop that." },
	{ at: 11, message: "That's not nice." },
	{ at: 19, message: "You have been asked to stop." },
	{ at: 29, message: "This behavior is being noted." },
	{ at: 41, message: "Continued contact is unnecessary." },
	{ at: 55, message: "Your ticket has requested space." },
	{ at: 71, message: "This is your final informal warning." },
	{ at: 89, message: "Formal warning issued." },
	{ at: 109, message: "Your ticket has been informed.", informed: true },
];

const fmt = (v: unknown) => Number(v || 0).toLocaleString();
const pad = (v: unknown) => "#" + String(Math.max(0, Number(v) || 0)).padStart(5, "0");
const mmss = (secs: number) => {
	const s = Math.max(0, secs || 0);
	return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};

function sessionId() {
	let value = localStorage.getItem(SESSION_KEY);
	if (!value) {
		value = crypto.randomUUID();
		localStorage.setItem(SESSION_KEY, value);
	}
	return value;
}

function readEntry(): Entry {
	try {
		return JSON.parse(localStorage.getItem(ENTRY_KEY) || "null");
	} catch {
		return null;
	}
}

function redeemedOrders() {
	try {
		const values = JSON.parse(localStorage.getItem(REDEEMED_PASSES_KEY) || "[]");
		return new Set<string>(Array.isArray(values) ? values : []);
	} catch {
		return new Set<string>();
	}
}

function isFocusedHere() {
	return document.visibilityState === "visible" && document.hasFocus();
}

async function request(path: string, body?: unknown, options: RequestInit = {}) {
	const response = await fetch(path, {
		method: body ? "POST" : "GET",
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
		...options,
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export default function Queue({ initialState }: { initialState: QueueState }) {
	const [, render] = useReducer((n: number) => n + 1, 0);

	// Mutable source of truth — refs so async intervals never read stale values.
	const state = useRef<QueueState>(initialState);
	const entry = useRef<Entry>(readEntry());
	const unfocusStartedAt = useRef<number | null>(null);
	const flags = useRef({ join: false, presence: false, leave: false });
	const unfocusTimer = useRef<number | null>(null);
	const clock = useRef("--:--:--");
	const passStatus = useRef("");
	const passBtnDisabled = useRef(false);
	const passOverlay = useRef<{ from: number; to: number } | null>(null);
	const checkoutUrl = useRef<string | null>(null);
	const turn = useRef<TurnState | null>(null);
	const serverClockOffset = useRef(0);
	const turnTicket = useRef<number | null>(null);
	const turnClickCount = useRef(0);
	const turnNotice = useRef("");
	const turnInformed = useRef(false);
	const turnNoticeTimer = useRef<number | null>(null);
	const complaintStatus = useRef("");
	const complaintSubmitting = useRef(false);

	const isWaiting = () => entry.current?.status === "waiting";
	const secondsUntilUnfocusLeave = () => {
		if (!unfocusStartedAt.current) return 60;
		return Math.max(0, Math.ceil((UNFOCUS_GRACE_MS - (Date.now() - unfocusStartedAt.current)) / 1000));
	};
	const minimumWaitRemainingMs = () => {
		const eligibleAt = turn.current?.eligibleAt;
		if (eligibleAt) {
			return Math.max(0, Date.parse(eligibleAt) - (Date.now() + serverClockOffset.current));
		}

		const joinedAt = entry.current?.joinedAt;
		if (!joinedAt) return DEFAULT_MINIMUM_WAIT_MS;
		const joinedAtMs = Date.parse(joinedAt);
		if (!Number.isFinite(joinedAtMs)) return DEFAULT_MINIMUM_WAIT_MS;
		return Math.max(0, joinedAtMs + DEFAULT_MINIMUM_WAIT_MS - Date.now());
	};

	function saveEntry(next: Entry) {
		entry.current = next;
		if (next) localStorage.setItem(ENTRY_KEY, JSON.stringify(next));
		else localStorage.removeItem(ENTRY_KEY);
	}

	function applyQueueData(data: any) {
		state.current = data.state || state.current;
		if (data.turn) {
			turn.current = data.turn;
			const serverNow = Date.parse(data.turn.serverNow);
			if (Number.isFinite(serverNow)) serverClockOffset.current = serverNow - Date.now();
		}
		if (data.entry) saveEntry(data.entry);
		else if (entry.current?.status === "waiting") saveEntry(null);
		render();
	}

	async function joinLine() {
		if (!isFocusedHere() || flags.current.join || isWaiting()) return;
		flags.current.join = true;
		render();
		try {
			const data = await request("/api/queue/join", { sessionId: sessionId() });
			applyQueueData(data);
			await tryRedeemPendingPass();
		} catch (error) {
			console.error(error);
		} finally {
			flags.current.join = false;
			render();
		}
	}

	async function heartbeat() {
		if (!isFocusedHere()) {
			startUnfocusGrace();
			return;
		}
		clearUnfocusGrace();

		if (!isWaiting()) {
			await joinLine();
			return;
		}

		if (flags.current.presence) return;
		flags.current.presence = true;
		try {
			const data = await request("/api/queue/heartbeat", { sessionId: sessionId() });
			applyQueueData(data);
			if (!isWaiting()) await joinLine();
			await tryRedeemPendingPass();
		} catch (error) {
			console.error(error);
		} finally {
			flags.current.presence = false;
		}
	}

	function startUnfocusGrace() {
		if (!isWaiting()) return;
		if (!unfocusStartedAt.current) unfocusStartedAt.current = Date.now();
		render();
		if (unfocusTimer.current) return;
		unfocusTimer.current = window.setInterval(() => {
			if (isFocusedHere()) {
				clearUnfocusGrace();
				heartbeat();
				return;
			}
			if (secondsUntilUnfocusLeave() <= 0) {
				clearUnfocusGrace();
				leaveLine();
				return;
			}
			render();
		}, 1000);
	}

	function clearUnfocusGrace() {
		unfocusStartedAt.current = null;
		if (unfocusTimer.current) window.clearInterval(unfocusTimer.current);
		unfocusTimer.current = null;
		render();
	}

	async function leaveLine(useBeacon = false) {
		if (!isWaiting() || flags.current.leave) return;
		flags.current.leave = true;
		const body = JSON.stringify({ sessionId: sessionId() });

		if (useBeacon && navigator.sendBeacon) {
			navigator.sendBeacon("/api/queue/leave", new Blob([body], { type: "application/json" }));
			saveEntry({ ...entry.current, status: "left", leftAt: new Date().toISOString() });
			flags.current.leave = false;
			return;
		}

		try {
			const data = await request("/api/queue/leave", { sessionId: sessionId() }, { keepalive: true });
			applyQueueData(data);
		} catch (error) {
			console.error(error);
		} finally {
			flags.current.leave = false;
		}
	}

	// Give up your turn and re-queue at the back: leave, then rejoin for a fresh
	// ticket. Rendered only at the end so the "removed" screen never flashes.
	async function goToBack() {
		if (!isWaiting() || flags.current.leave || flags.current.join) return;
		flags.current.leave = true;
		try {
			await request("/api/queue/leave", { sessionId: sessionId() });
			saveEntry(null);
			const data = await request("/api/queue/join", { sessionId: sessionId() });
			applyQueueData(data);
		} catch (error) {
			console.error(error);
			render();
		} finally {
			flags.current.leave = false;
		}
	}

	async function buyPass() {
		passBtnDisabled.current = true;
		passStatus.current = "Opening Wix checkout...";
		render();
		try {
			const data = await request("/api/pass/checkout", { origin: window.location.origin });
			// Open in an on-page modal instead of navigating away, so the heartbeat
			// keeps running and the buyer never loses their place in line.
			checkoutUrl.current = data.url;
			passStatus.current = "Complete your purchase — your place is held.";
			render();
		} catch (error) {
			passStatus.current = "The pass office failed to open.";
			passBtnDisabled.current = false;
			render();
			console.error(error);
		}
	}

	function clickQueuePlace() {
		turnClickCount.current += 1;
		const reprimand = TICKET_REPRIMANDS.find(({ at }) => at === turnClickCount.current);

		if (!reprimand) return;
		turnNotice.current = reprimand.message;
		if (reprimand.informed) turnInformed.current = true;
		if (turnNoticeTimer.current) window.clearTimeout(turnNoticeTimer.current);
		turnNoticeTimer.current = window.setTimeout(() => {
			turnNotice.current = "";
			render();
		}, 2200);
		render();
	}

	async function submitComplaint(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (complaintSubmitting.current) return;
		complaintSubmitting.current = true;
		complaintStatus.current = "Routing complaint...";
		render();
		const form = event.currentTarget;
		const data = new FormData(form);

		try {
			await request("/api/complaint", {
				category: data.get("category"),
				complaint: data.get("complaint"),
				outcome: data.get("outcome"),
				sessionId: sessionId(),
				ticketNumber: entry.current?.ticketNumber,
				position: entry.current?.position,
			});
			form.reset();
			complaintStatus.current =
				"Complaint received. It has been placed in the complaint queue. Current position: unavailable.";
		} catch (error) {
			complaintStatus.current = "Complaint rejected on procedural grounds. Try again.";
			console.error(error);
		} finally {
			complaintSubmitting.current = false;
			render();
		}
	}

	function closeCheckout() {
		checkoutUrl.current = null;
		passBtnDisabled.current = false;
		render();
	}

	// Fires on every iframe navigation. Once checkout redirects back to our own
	// origin (?pass=redeem / ?pass=cancelled) we can read it; Wix/payment steps
	// are cross-origin and throw, so we just wait for the next load.
	function onCheckoutFrameLoad(frame: HTMLIFrameElement) {
		let params: URLSearchParams;
		try {
			const loc = frame.contentWindow?.location;
			if (!loc || loc.origin !== window.location.origin) return;
			params = new URLSearchParams(loc.search);
		} catch {
			return;
		}
		if (!params.has("pass")) return;
		handlePassReturn(params.get("pass"), params.get("orderId") || params.get("orderid"));
		closeCheckout();
		tryRedeemPendingPass();
	}

	async function tryRedeemPendingPass() {
		const orderId = localStorage.getItem(PENDING_PASS_KEY);
		if (!orderId) return;

		if (!isWaiting()) {
			passStatus.current = "Pass bought. Entering the line to spend it.";
			render();
			return;
		}

		const redeemed = redeemedOrders();
		if (redeemed.has(orderId)) {
			localStorage.removeItem(PENDING_PASS_KEY);
			passStatus.current = "That pass was already spent.";
			render();
			return;
		}

		passStatus.current = "Spending pass...";
		render();
		const positionBefore = entry.current?.position ?? null;
		try {
			const data = await request("/api/pass/redeem", { sessionId: sessionId(), orderId });
			applyQueueData(data);
			redeemed.add(orderId);
			localStorage.setItem(REDEEMED_PASSES_KEY, JSON.stringify([...redeemed]));
			localStorage.removeItem(PENDING_PASS_KEY);
			if (data.redemption?.applied) {
				const positionAfter = entry.current?.position ?? null;
				passOverlay.current = { from: positionBefore ?? 0, to: positionAfter ?? 0 };
				passStatus.current = "";
			} else {
				passStatus.current = "Pass spent at the front. It had nowhere to go.";
			}
			render();
		} catch (error) {
			passStatus.current = "Pass not spent yet. The line is being difficult.";
			render();
			console.error(error);
		}
	}

	function handlePassReturn(pass: string | null, orderId?: string | null) {
		if (pass === "cancelled") {
			passStatus.current = "The pass was abandoned. The queue stayed pure.";
		}
		if (pass === "redeem") {
			if (orderId) {
				localStorage.setItem(PENDING_PASS_KEY, orderId);
				passStatus.current = "Pass bought. Preparing to spend it.";
			} else {
				passStatus.current = "Checkout returned without an order.";
			}
		}
	}

	// Legacy full-page-redirect return (still works if an old link lands here).
	function captureCheckoutReturn() {
		const params = new URLSearchParams(window.location.search);
		handlePassReturn(params.get("pass"), params.get("orderId") || params.get("orderid"));
		if (params.has("pass")) window.history.replaceState({}, "", window.location.pathname);
	}

	// Mount: clock, presence loop, focus/visibility wiring. Runs once (client:only).
	useEffect(() => {
		// If we're loaded INSIDE our own checkout iframe (the callback URL landed
		// here), notify the opener and stop — don't boot a second queue, don't strip
		// the URL. The parent closes the modal and handles the result.
		if (window.self !== window.top && window.parent) {
			const p = new URLSearchParams(window.location.search);
			if (p.has("pass")) {
				window.parent.postMessage(
					{
						type: "queue-pass-return",
						pass: p.get("pass"),
						orderId: p.get("orderId") || p.get("orderid"),
					},
					window.location.origin,
				);
				return;
			}
		}

		captureCheckoutReturn();

		const tick = () => {
			const d = new Date();
			const p = (n: number) => String(n).padStart(2, "0");
			clock.current = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
			render();
		};
		tick();
		const clockTimer = window.setInterval(tick, 1000);

		render();
		heartbeat();
		tryRedeemPendingPass();

		const beat = window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
		const onFocus = () => heartbeat();
		const onBlur = () => startUnfocusGrace();
		const onVis = () => {
			if (document.visibilityState === "hidden") startUnfocusGrace();
			else heartbeat();
		};
		const onPageHide = () => leaveLine(true);
		// The checkout iframe posts here when it lands on our callback URL.
		const onMessage = (ev: MessageEvent) => {
			if (ev.origin !== window.location.origin) return;
			const data = ev.data;
			if (!data || data.type !== "queue-pass-return") return;
			handlePassReturn(data.pass, data.orderId);
			closeCheckout();
			tryRedeemPendingPass();
		};
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		document.addEventListener("visibilitychange", onVis);
		window.addEventListener("pagehide", onPageHide);
		window.addEventListener("message", onMessage);

		return () => {
			window.clearInterval(clockTimer);
			window.clearInterval(beat);
			if (unfocusTimer.current) window.clearInterval(unfocusTimer.current);
			if (turnNoticeTimer.current) window.clearTimeout(turnNoticeTimer.current);
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
			document.removeEventListener("visibilitychange", onVis);
			window.removeEventListener("pagehide", onPageHide);
			window.removeEventListener("message", onMessage);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ---- derive view ----
	const s = state.current;
	const e = entry.current;
	const nowServing = Number(s.currentHead || 1);
	const lastIssued = Number(s.lastIssued || 0);
	const span = Math.max(0, Number(s.waiting || 0));
	const waiting = isWaiting();
	const position = waiting ? (e?.position ?? null) : null;
	const ahead = Math.max(0, (position ?? 1) - 1);
	const behind = Math.max(0, span - (position ?? span));
	const focused = typeof document !== "undefined" && isFocusedHere();
	const graceActive = waiting && !!unfocusStartedAt.current && !focused;
	const minimumRemainingMs = waiting ? minimumWaitRemainingMs() : DEFAULT_MINIMUM_WAIT_MS;
	const minimumRemainingSeconds = Math.ceil(minimumRemainingMs / 1000);
	const firstInLine = waiting && (turn.current?.isFirst ?? (position ?? 0) <= 1);
	const minimumWaitComplete = minimumRemainingMs === 0;
	const turnAvailable = turn.current?.canTakeTurn === true || (firstInLine && minimumWaitComplete);

	let phase: "joining" | "waiting" | "turn" | "removed" = "joining";
	if (e && (e.status === "left" || e.status === "evicted")) phase = "removed";
	else if (turnAvailable) phase = "turn";
	else if (waiting) phase = "waiting";

	const activeTurnTicket = waiting ? (e?.ticketNumber ?? null) : null;
	if (turnTicket.current !== activeTurnTicket) {
		turnTicket.current = activeTurnTicket;
		turnClickCount.current = 0;
		turnNotice.current = "";
		turnInformed.current = false;
	}

	const distanceFromFront = span > 1 && position ? ((position - 1) / (span - 1)) * 100 : 0;
	const markerPosition = Math.max(2.5, Math.min(97.5, 100 - distanceFromFront));

	// Rendered outside the phase switch so it survives a waiting→turn flip mid-purchase.
	const checkoutModal = checkoutUrl.current ? (
		<div
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 1000,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<div
				onClick={closeCheckout}
				style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.72)" }}
			/>
			<div
				style={{
					position: "relative",
					// 16:9; the 163vh cap keeps height (= width * 9/16) within the viewport.
					width: "min(1200px, 94vw, 163vh)",
					aspectRatio: "16 / 9",
					background: "#0f1115",
					border: "1px solid #2a2f37",
					borderRadius: 10,
					overflow: "hidden",
					display: "flex",
					flexDirection: "column",
					boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "10px 14px",
						borderBottom: "1px solid #2a2f37",
						fontSize: 11,
						letterSpacing: "0.14em",
						textTransform: "uppercase",
						color: "#9aa0aa",
					}}
				>
					<span>Wix Checkout · your place is held</span>
					<button
						type="button"
						onClick={closeCheckout}
						aria-label="Close checkout"
						style={{
							background: "none",
							border: "none",
							color: "#e6e8ea",
							fontSize: 18,
							cursor: "pointer",
							lineHeight: 1,
						}}
					>
						✕
					</button>
				</div>
				<iframe
					src={checkoutUrl.current}
					title="Pass checkout"
					onLoad={(ev) => onCheckoutFrameLoad(ev.currentTarget)}
					style={{ border: "none", flex: 1, width: "100%", background: "#fff" }}
				/>
			</div>
		</div>
	) : null;

	let content: JSX.Element;
	if (phase === "joining") {
		content = (
			<section className="phase phase-joining">
				<div className="join-kicker">The Queue — Facility 01</div>
				<div className="join-label">
					{focused ? "Assigning number" : "Focus this window to take a number"}
				</div>
				<div className="join-display">{pad(e?.ticketNumber || lastIssued + 1)}</div>
				<div className="join-bar">
					<div className="join-bar-fill" />
				</div>
				<div className="join-note">Do not close this window</div>
			</section>
		);
	} else if (phase === "removed") {
		content = (
			<section className="phase phase-removed">
				<div className="removed-kicker">Place Released</div>
				<div className="removed-title">You have left the line.</div>
				<div className="removed-copy">
					{e?.status === "evicted"
						? "Your presence lapsed for a full minute. Your place was released to the next visitor and cannot be recovered."
						: "Your place was released to the next visitor when you left. It cannot be recovered."}
				</div>
				<div className="removed-note">Reopen this page to take a new number</div>
			</section>
		);
	} else if (phase === "turn") {
		content = (
			<section className="phase phase-turn">
				{turnInformed.current && (
					<div className="turn-informed-marker">
						Ticket {pad(e!.ticketNumber)} informed · Incident recorded
					</div>
				)}
				<div className="turn-kicker">The Queue · Now Serving {pad(e!.ticketNumber)}</div>
				<div className="turn-title">This is your turn, congratulations!</div>
				{turnNotice.current && (
					<div className="ticket-reprimand on-turn" role="status">
						{turnNotice.current}
					</div>
				)}
					<div className="turn-note">
						 {
              behind === 0? "nobody is"
              : behind === 1 ? `${fmt(behind)} person is`
              : `${fmt(behind)} people are`
             } waiting for you to leave and finish your turn.</div>
				<button
					type="button"
					className="pass-button"
					style={{ marginTop: 32 }}
					disabled={flags.current.leave}
					onClick={goToBack}
				>
					Go to the back of the line
				</button>
			</section>
		);
	} else {
		// waiting
		content = (
			<>
			<section className="phase phase-waiting" aria-live="polite">
				<header className="wq-header">
					<div className="wq-brand">The Queue</div>
					<div className="wq-terminal">Facility 01 · Terminal A · {clock.current}</div>
				</header>

				{graceActive && (
					<div className="grace-banner">
						<span className="grace-dot" />
						<span>
							Tab unfocused · removal in {mmss(secondsUntilUnfocusLeave())} · return to keep your
							place
						</span>
					</div>
				)}

				<div className="wq-center">
					<div className="presence-row">
						{!graceActive ? (
							<span className="presence present">
								<span className="pdot" />
								Present
							</span>
						) : (
							<span className="presence unfocused">
								<span className="pdot" />
								Unfocused
							</span>
						)}
					</div>

					<div className="pos-label">Your position in line</div>

					<div className="pos-number" onClick={clickQueuePlace}>
						<span>{fmt(position)}</span>
						<span className="caret" />
					</div>

					<div className="pos-sub">
						{firstInLine && !minimumWaitComplete
							? `You are first · turn available in ${mmss(minimumRemainingSeconds)}`
							: `${fmt(ahead)} ${ahead === 1 ? "person" : "people"} ahead of you · ticket ${pad(e!.ticketNumber)}`}
					</div>

					{turnInformed.current && (
						<div className="ticket-informed-marker">
							Ticket {pad(e!.ticketNumber)} informed · Incident recorded
						</div>
					)}
				</div>

				{turnNotice.current && (
					<div className="ticket-reprimand" role="status">
						{turnNotice.current}
					</div>
				)}

				<section className="wq-lower">
					<div className="metrics">
						<div className="metric">
							<div className="metric-label">Now serving</div>
							<div className="metric-value">{pad(nowServing)}</div>
						</div>
						<div className="metric">
							<div className="metric-label">Last issued</div>
							<div className="metric-value">{pad(lastIssued)}</div>
						</div>
						<div className="metric">
							<div className="metric-label">Total departures</div>
							<div className="metric-value">{fmt(s.totalDepartures)}</div>
						</div>
						<div className="metric">
							<div className="metric-label">Minimum stay</div>
							<div className="metric-value">
								{minimumWaitComplete ? "CLEARED" : mmss(minimumRemainingSeconds)}
							</div>
						</div>
					</div>

					<div className="track-block">
						<div className="track-head">
							<span>Back of line</span>
							<span>Front of line</span>
						</div>
						<div
							className="track"
							role="img"
							aria-label={`You are position ${fmt(position)} of ${fmt(span)}. ${fmt(ahead)} ahead and ${fmt(behind)} behind.`}
						>
							<div className="track-fill" style={{ width: `${markerPosition}%` }} />
							<div className="track-marker" style={{ left: `${markerPosition}%` }} />
							<div className="track-you" style={{ left: `${markerPosition}%` }}>You</div>
							<div className="track-ticket" style={{ left: `${markerPosition}%` }}>
								{pad(e!.ticketNumber)}
							</div>
						</div>
						<div className="track-counts">
							<span>{fmt(behind)} behind</span>
							<strong>Position {fmt(position)} of {fmt(span)}</strong>
							<span>{fmt(ahead)} ahead</span>
						</div>
					</div>

					<div className="pass-module">
						<div className="pass-copy-cell">
							<div className="pass-title">Pass Over One Person</div>
							<div className="pass-copy">
								Advance your position by exactly one (1) place. Effect is immediate and permanent.
								No prize is conferred. Non-refundable. Form 12-A.
							</div>
							<div className="pass-status">{passStatus.current}</div>
						</div>
						<div className="pass-action-cell">
							<div className="pass-price">$0.50</div>
							<button
								className="pass-button"
								type="button"
								disabled={passBtnDisabled.current}
								onClick={buyPass}
							>
								Authorize Payment
							</button>
						</div>
					</div>

					<div className="wq-fine">
						The Queue is a work of collective patience. There is no prize. Leaving or losing focus
						for one minute releases your place.
					</div>

					<form className="complaint-form" onSubmit={submitComplaint}>
						<div className="complaint-heading">
							<div className="complaint-title">File a Complaint</div>
							<div className="complaint-reference">Wix Form · Department 4B</div>
						</div>
						<div className="complaint-grid">
							<label>
								<span>Complaint category</span>
								<select name="category" required defaultValue="">
									<option value="" disabled>Select category</option>
									<option value="line_moved">The line moved</option>
									<option value="line_did_not_move">The line did not move</option>
									<option value="someone_ahead">Someone is ahead of me</option>
									<option value="someone_behind">Someone is behind me</option>
									<option value="number_feels_incorrect">My number feels incorrect</option>
									<option value="other">Other procedural concern</option>
								</select>
							</label>
							<label>
								<span>Requested outcome</span>
								<select name="outcome" required defaultValue="">
									<option value="" disabled>Select outcome</option>
									<option value="acknowledgement">Official acknowledgement</option>
									<option value="no_action">A thorough lack of action</option>
									<option value="referral">Referral to another department</option>
								</select>
							</label>
							<label className="complaint-text-field">
								<span>Complaint</span>
								<textarea name="complaint" required maxLength={1000} rows={5} />
							</label>
						</div>
						<div className="complaint-footer">
							<div className="complaint-status" role="status">{complaintStatus.current}</div>
							<button className="complaint-button" type="submit" disabled={complaintSubmitting.current}>
								File Complaint
							</button>
						</div>
					</form>
				</section>

				{graceActive && <div className="grace-vignette" />}
			</section>

			{passOverlay.current && (
				<div className="pass-overlay">
					<div className="receipt">
						<div className="receipt-head">
							<span className="receipt-title">Pass Redeemed</span>
							<span className="receipt-status">Processed</span>
						</div>
						<div className="receipt-body">
							<div className="receipt-row">
								<span>PLACES ADVANCED</span>
								<span className="rv">1</span>
							</div>
							<div className="receipt-row">
								<span>POSITION</span>
								<span className="rv">
									{fmt(passOverlay.current.from)} → {fmt(passOverlay.current.to)}
								</span>
							</div>
							<div className="receipt-row">
								<span>CHARGED</span>
								<span className="rv">−$0.50</span>
							</div>
							<div className="receipt-note">
								You are now one place closer to nothing. Retain this receipt for your records.
							</div>
							<button
								className="receipt-button"
								type="button"
								onClick={() => {
									passOverlay.current = null;
									render();
								}}
							>
								Return to Line
							</button>
						</div>
					</div>
				</div>
			)}
		</>
		);
	}

	return (
		<>
			{content}
			{checkoutModal}
		</>
	);
}
