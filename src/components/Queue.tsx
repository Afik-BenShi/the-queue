import { useEffect, useReducer, useRef } from "react";

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
	leftAt?: string;
	position?: number | null;
} | null;

const HEARTBEAT_INTERVAL_MS = 3000;
const UNFOCUS_GRACE_MS = 60000;
const SESSION_KEY = "the-queue-session-id";
const ENTRY_KEY = "the-queue-entry";
const PENDING_PASS_KEY = "the-queue-pending-pass-order";
const REDEEMED_PASSES_KEY = "the-queue-redeemed-pass-orders";

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

	const isWaiting = () => entry.current?.status === "waiting";
	const secondsUntilUnfocusLeave = () => {
		if (!unfocusStartedAt.current) return 60;
		return Math.max(0, Math.ceil((UNFOCUS_GRACE_MS - (Date.now() - unfocusStartedAt.current)) / 1000));
	};

	function saveEntry(next: Entry) {
		entry.current = next;
		if (next) localStorage.setItem(ENTRY_KEY, JSON.stringify(next));
		else localStorage.removeItem(ENTRY_KEY);
	}

	function applyQueueData(data: any) {
		state.current = data.state || state.current;
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
		// While the checkout modal is open, keep beating regardless of focus — the
		// iframe steals window focus but the buyer is still here and must keep their
		// place (otherwise the 60s server-side stale sweep would evict them).
		if (!checkoutUrl.current && !isFocusedHere()) {
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
		// Focus moving into our own checkout iframe fires a window blur, but the
		// tab is still focused and the heartbeat is still alive — don't penalize it.
		if (checkoutUrl.current) return;
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
		handlePassReturn(params);
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
			state.current = data.state || state.current;
			if (data.entry) saveEntry(data.entry);
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

	function handlePassReturn(params: URLSearchParams) {
		if (params.get("pass") === "cancelled") {
			passStatus.current = "The pass was abandoned. The queue stayed pure.";
		}
		if (params.get("pass") === "redeem") {
			const orderId = params.get("orderId") || params.get("orderid");
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
		handlePassReturn(params);
		if (params.has("pass")) window.history.replaceState({}, "", window.location.pathname);
	}

	// Mount: clock, presence loop, focus/visibility wiring. Runs once (client:only).
	useEffect(() => {
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
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		document.addEventListener("visibilitychange", onVis);
		window.addEventListener("pagehide", onPageHide);

		return () => {
			window.clearInterval(clockTimer);
			window.clearInterval(beat);
			if (unfocusTimer.current) window.clearInterval(unfocusTimer.current);
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
			document.removeEventListener("visibilitychange", onVis);
			window.removeEventListener("pagehide", onPageHide);
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
	const behind = Math.max(0, span - 1);
	const focused = typeof document !== "undefined" && isFocusedHere();
	const graceActive = waiting && !!unfocusStartedAt.current && !focused;

	let phase: "joining" | "waiting" | "turn" | "removed" = "joining";
	if (e && (e.status === "left" || e.status === "evicted")) phase = "removed";
	else if (waiting && (position ?? 0) <= 1) phase = "turn";
	else if (waiting) phase = "waiting";

	const pct = span > 0 && position ? Math.max(3, Math.min(95, (position / span) * 100)) : 3;

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
					width: "min(480px, 94vw)",
					height: "min(760px, 92vh)",
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
				<div className="turn-kicker">The Queue · Now Serving {pad(e!.ticketNumber)}</div>
				<div className="turn-title">This is your turn, congratulations!</div>
					<div className="turn-note">
						 {
              behind === 0? "nobody is"
              : behind === 1 ? `${fmt(behind)} person is`
              : `${fmt(behind)} people are`
             } waiting for you to leave and finish your turn.</div>
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

					<div className="pos-number">
						<span>{fmt(position)}</span>
						<span className="caret" />
					</div>

					<div className="pos-sub">
						{fmt(ahead)} {ahead === 1 ? "person" : "people"} ahead of you · ticket{" "}
						{pad(e!.ticketNumber)}
					</div>
				</div>

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
					</div>

					<div className="track-block">
						<div className="track-head">
							<span>Front {pad(nowServing)}</span>
							<span>End {pad(lastIssued)}</span>
						</div>
						<div className="track">
							<div className="track-grid" />
							<div className="track-fill" style={{ width: `${pct}%` }} />
							<div className="track-marker" style={{ left: `${pct}%` }} />
							<div className="track-you" style={{ left: `${pct}%` }}>
								YOU
							</div>
							<div className="track-ticket" style={{ left: `${pct}%` }}>
								{pad(e!.ticketNumber)}
							</div>
						</div>
						<div className="track-note">
							{fmt(span)} visitors currently in line · you are {fmt(position)} from the front
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
