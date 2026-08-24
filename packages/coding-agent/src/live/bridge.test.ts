import { describe, expect, test } from "bun:test";
import { Bridge, type BridgeHandlers, type ResolveDecisionRequest } from "./bridge";

let port = 9200;

function handlers(overrides?: Partial<BridgeHandlers>): BridgeHandlers {
	return {
		onStop: () => {},
		onToggleMute: () => {},
		...overrides,
	};
}

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("connect failed"));
	});
	return ws;
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
	return new Promise(resolve => {
		ws.onmessage = ev => resolve(JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()));
	});
}

function collect(ws: WebSocket): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [];
	ws.onmessage = ev => frames.push(JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()));
	return frames;
}

describe("Bridge — additive capabilities", () => {
	test("canResolve is true only when onResolveDecision is wired; a v1 client ignoring the field stays connected", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p, callId: "call-1", recordingMode: "full" });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		expect(hello.type).toBe("hello");
		expect(hello.v).toBe(1); // protocol version is NOT bumped by this additive change
		expect(hello.callId).toBe("call-1");
		expect(hello.canResolve).toBe(false);
		expect(hello.recordingMode).toBe("full");
		expect(hello.decisions).toEqual([]);
		expect(hello.interruptPolicy).toBe("allow");
		ws.close();
		bridge.close();
	});

	test("canResolve is true once onResolveDecision is wired", async () => {
		const p = port++;
		const bridge = new Bridge(handlers({ onResolveDecision: () => ({ ok: false, reason: "not-supported" }) }), {
			port: p,
		});
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		expect(hello.canResolve).toBe(true);
		ws.close();
		bridge.close();
	});
});

describe("Bridge — Origin allowlist", () => {
	test("a plain request from a disallowed Origin is refused before any upgrade", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p, allowedOrigins: ["http://good.example"] });
		expect(bridge.open()).toBe(true);
		const response = await fetch(`http://127.0.0.1:${p}`, { headers: { origin: "http://evil.example" } });
		expect(response.status).toBe(403);
		bridge.close();
	});

	test("a request with no Origin header (a non-browser caller) is allowed through to the normal 426", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p, allowedOrigins: ["http://good.example"] });
		expect(bridge.open()).toBe(true);
		const response = await fetch(`http://127.0.0.1:${p}`);
		expect(response.status).toBe(426); // websocket only, but not origin-refused
		bridge.close();
	});

	test("an allowed Origin connects normally", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p, allowedOrigins: ["http://good.example"] });
		expect(bridge.open()).toBe(true);
		const ws = new WebSocket(`ws://127.0.0.1:${p}`, { headers: { origin: "http://good.example" } } as never);
		const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
			ws.onmessage = ev => resolve(JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()));
			ws.onerror = () => reject(new Error("should have connected"));
		});
		expect(hello.type).toBe("hello");
		ws.close();
		bridge.close();
	});

	test("no allowlist configured (the default) accepts any Origin, same as today", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const response = await fetch(`http://127.0.0.1:${p}`, { headers: { origin: "http://anything.example" } });
		expect(response.status).toBe(426);
		bridge.close();
	});
});

describe("Bridge — resolveDecision control-frame authorization", () => {
	async function setup(overrides?: { token?: string; onResolveDecision?: BridgeHandlers["onResolveDecision"] }) {
		const p = port++;
		const bridge = new Bridge(
			handlers({
				onResolveDecision:
					overrides?.onResolveDecision ??
					(async (request: ResolveDecisionRequest) => ({
						ok: true,
						decision: {
							id: request.decisionId,
							prompt: "?",
							options: [{ index: 0, label: request.label, consequence: "" }],
							requiresConfirmation: false,
							state: "answered" as const,
							createdAt: 0,
							updatedAt: 0,
							resolution: { optionIndex: request.optionIndex, label: request.label, source: "ui" as const },
						},
					})),
			}),
			{ port: p, controlToken: overrides?.token },
		);
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		return { bridge, ws, sessionId: hello.sessionId as string };
	}

	test("a request missing the token is refused with an explicit controlAck reason", async () => {
		const { bridge, ws, sessionId } = await setup({ token: "secret-1" });
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ type: "controlAck", requestId: "req-1", ok: false, reason: "invalid-token" });
		ws.close();
		bridge.close();
	});

	test("a request with the wrong token is refused the same way", async () => {
		const { bridge, ws, sessionId } = await setup({ token: "secret-1" });
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				token: "wrong",
				sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(frames[0]).toMatchObject({ ok: false, reason: "invalid-token" });
		ws.close();
		bridge.close();
	});

	test("the correct token but the wrong sessionId is refused as wrong-session", async () => {
		const { bridge, ws } = await setup({ token: "secret-1" });
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				token: "secret-1",
				sessionId: "not-the-real-session",
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(frames[0]).toMatchObject({ ok: false, reason: "wrong-session" });
		ws.close();
		bridge.close();
	});

	test("token and session both correct — the handler runs and its result is acked directly to the requester", async () => {
		const { bridge, ws, sessionId } = await setup({ token: "secret-1" });
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				token: "secret-1",
				sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "Keep it",
			}),
		);
		await settle();
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ type: "controlAck", requestId: "req-1", ok: true });
		expect((frames[0]?.decision as Record<string, unknown>)?.resolution).toMatchObject({ label: "Keep it" });
		ws.close();
		bridge.close();
	});

	test("with no token configured, a frame with no token field is accepted (no broker in front of a bare /live)", async () => {
		const { bridge, ws, sessionId } = await setup();
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(frames[0]).toMatchObject({ ok: true });
		ws.close();
		bridge.close();
	});

	test("resolveDecision with no handler wired is refused as not-supported", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				sessionId: hello.sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(frames[0]).toMatchObject({ ok: false, reason: "not-supported" });
		ws.close();
		bridge.close();
	});

	test("a frame with no requestId is dropped silently — never thrown, never acked", async () => {
		const { bridge, ws, sessionId } = await setup();
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(frames).toHaveLength(0);
		ws.close();
		bridge.close();
	});

	test("the handler's own rejection reason (e.g. label-mismatch) passes through the ack verbatim", async () => {
		const { bridge, ws, sessionId } = await setup({
			onResolveDecision: async () => ({ ok: false, reason: "label-mismatch" }),
		});
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "wrong label",
			}),
		);
		await settle();
		expect(frames[0]).toMatchObject({ ok: false, reason: "label-mismatch" });
		ws.close();
		bridge.close();
	});

	test("a handler that throws is acked as handler-error, never crashes the bridge", async () => {
		const { bridge, ws, sessionId } = await setup({
			onResolveDecision: async () => {
				throw new Error("boom");
			},
		});
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(frames[0]).toMatchObject({ ok: false, reason: "handler-error" });
		ws.close();
		bridge.close();
	});

	test("an ack is directed to the requesting socket only — a second viewer sees nothing", async () => {
		const p = port++;
		const bridge = new Bridge(handlers({ onResolveDecision: async () => ({ ok: true }) }), { port: p });
		expect(bridge.open()).toBe(true);
		const requester = await connect(`ws://127.0.0.1:${p}`);
		const helloA = await nextMessage(requester);
		const bystander = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(bystander); // its own hello
		const requesterFrames = collect(requester);
		const bystanderFrames = collect(bystander);
		requester.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "resolveDecision",
				requestId: "req-1",
				sessionId: helloA.sessionId,
				decisionId: "d1",
				optionIndex: 0,
				label: "x",
			}),
		);
		await settle();
		expect(requesterFrames).toHaveLength(1);
		expect(requesterFrames[0]?.type).toBe("controlAck");
		expect(bystanderFrames).toHaveLength(0);
		requester.close();
		bystander.close();
		bridge.close();
	});
});

describe("Bridge — setInterruptPolicy", () => {
	test("an authorized setInterruptPolicy frame reaches the handler and is acked", async () => {
		const p = port++;
		const seen: string[] = [];
		const bridge = new Bridge(
			handlers({
				onSetInterruptPolicy: request => {
					seen.push(request.policy);
					return { ok: true };
				},
			}),
			{ port: p },
		);
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "setInterruptPolicy",
				requestId: "r1",
				sessionId: hello.sessionId,
				policy: "doNotInterrupt",
			}),
		);
		await settle();
		expect(seen).toEqual(["doNotInterrupt"]);
		expect(frames[0]).toMatchObject({ ok: true });
		ws.close();
		bridge.close();
	});

	test("a malformed policy value is refused", async () => {
		const p = port++;
		const bridge = new Bridge(handlers({ onSetInterruptPolicy: () => ({ ok: true }) }), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		const frames = collect(ws);
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "setInterruptPolicy",
				requestId: "r1",
				sessionId: hello.sessionId,
				policy: "nonsense",
			}),
		);
		await settle();
		expect(frames[0]).toMatchObject({ ok: false, reason: "malformed-request" });
		ws.close();
		bridge.close();
	});
});

describe("Bridge — decision broadcast and the retained snapshot", () => {
	test("publishDecision broadcasts to every viewer and a late joiner's hello carries open decisions", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const first = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(first);
		const frames = collect(first);

		const open = {
			id: "d1",
			prompt: "Which name?",
			options: [{ index: 0, label: "Keep it", consequence: "" }],
			requiresConfirmation: false,
			state: "open" as const,
			createdAt: 0,
			updatedAt: 0,
		};
		bridge.publishDecision(open);
		await settle();
		expect(frames[0]).toMatchObject({ type: "decision", decision: { id: "d1", state: "open" } });

		const late = await connect(`ws://127.0.0.1:${p}`);
		const lateHello = await nextMessage(late);
		expect(lateHello.decisions).toEqual([open]);

		bridge.publishDecision({
			...open,
			state: "answered",
			resolution: { optionIndex: 0, label: "Keep it", source: "ui" },
		});
		await settle();
		const evenLater = await connect(`ws://127.0.0.1:${p}`);
		const evenLaterHello = await nextMessage(evenLater);
		// The bridge is presentation, not the record: a terminal decision drops out
		// of the retained snapshot once it is broadcast.
		expect(evenLaterHello.decisions).toEqual([]);

		first.close();
		late.close();
		evenLater.close();
		bridge.close();
	});

	test("decisionClass is carried additively through the broadcast frame and a late joiner's hello snapshot", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const first = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(first);
		const frames = collect(first);

		const destructive = {
			id: "d2",
			prompt: "Merge to main?",
			options: [{ index: 0, label: "Merge it", consequence: "" }],
			requiresConfirmation: false,
			decisionClass: "destructive" as const,
			state: "open" as const,
			createdAt: 0,
			updatedAt: 0,
		};
		bridge.publishDecision(destructive);
		await settle();
		expect(frames[0]).toMatchObject({ type: "decision", decision: { id: "d2", decisionClass: "destructive" } });

		const late = await connect(`ws://127.0.0.1:${p}`);
		const lateHello = await nextMessage(late);
		expect(lateHello.decisions).toEqual([destructive]);

		first.close();
		late.close();
		bridge.close();
	});

	test("a decision with no decisionClass carries no such field — old and new clients see the same shape", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws);
		const frames = collect(ws);
		bridge.publishDecision({
			id: "d3",
			prompt: "Rename a variable?",
			options: [{ index: 0, label: "Keep it", consequence: "" }],
			requiresConfirmation: false,
			state: "open",
			createdAt: 0,
			updatedAt: 0,
		});
		await settle();
		expect(frames[0]?.decision).not.toHaveProperty("decisionClass");
		ws.close();
		bridge.close();
	});
});

describe("Bridge — terminal frame carries the idle-hangup reason additively", () => {
	test("close(error, reason) broadcasts the reason; a v1 client that ignores it sees the same error/null contract", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws);
		const frames = collect(ws);
		bridge.close(undefined, "idle");
		await settle();
		expect(frames[0]).toMatchObject({ type: "terminal", error: null, reason: "idle" });
		ws.close();
	});

	test("close() with no reason omits the field entirely, exactly as before this change", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws);
		const frames = collect(ws);
		bridge.close();
		await settle();
		expect(frames[0]).toEqual({
			v: 1,
			sessionId: expect.any(String),
			seq: expect.any(Number),
			type: "terminal",
			error: null,
		});
		expect(frames[0]).not.toHaveProperty("reason");
		ws.close();
	});
});

/** Builds a client→server mic-audio binary frame: tag `0x01` + little-endian `Float32` PCM. */
function micFrame(samples: Float32Array): Uint8Array {
	const frame = new Uint8Array(1 + samples.byteLength);
	frame[0] = 0x01;
	frame.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 1);
	return frame;
}

function nextBinaryMessage(ws: WebSocket): Promise<Uint8Array> {
	ws.binaryType = "arraybuffer";
	return new Promise(resolve => {
		ws.onmessage = ev => resolve(new Uint8Array(ev.data as ArrayBuffer));
	});
}

describe("Bridge — browser-audio-transport (concern 09)", () => {
	test("hello carries no audio field when onMicAudio is unwired — a v1 client sees exactly what it always saw", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		expect(hello).not.toHaveProperty("audio");
		ws.close();
		bridge.close();
	});

	test("hello advertises the audio transport, with its assumed sample rates and encoding, once onMicAudio is wired", async () => {
		const p = port++;
		const bridge = new Bridge(handlers({ onMicAudio: () => {} }), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const hello = await nextMessage(ws);
		expect(hello.audio).toEqual({
			transport: true,
			micSampleRate: 16_000,
			outputSampleRate: 24_000,
			outputEncoding: "pcm16le",
		});
		ws.close();
		bridge.close();
	});

	test("a binary mic frame reaches onMicAudio as the exact Float32 samples sent", async () => {
		const p = port++;
		const received: Float32Array[] = [];
		const bridge = new Bridge(handlers({ onMicAudio: samples => received.push(samples) }), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws); // hello
		const samples = new Float32Array([0.1, -0.2, 0.3, -0.4]);
		ws.send(micFrame(samples));
		await settle();
		expect(received).toHaveLength(1);
		expect([...(received[0] ?? [])]).toEqual([...samples]);
		ws.close();
		bridge.close();
	});

	test("a binary frame is dropped when onMicAudio is not wired — no error, no crash, the socket stays open", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws); // hello
		ws.send(micFrame(new Float32Array([1])));
		ws.send(JSON.stringify({ v: 1, type: "control", action: "toggleMute" }));
		await settle();
		ws.close();
		bridge.close();
		expect(true).toBe(true); // reaching here without the connection dying is the assertion
	});

	test("a malformed binary frame (wrong tag, or a byte length that is not a whole number of Float32 samples) is dropped", async () => {
		const p = port++;
		const received: Float32Array[] = [];
		const bridge = new Bridge(handlers({ onMicAudio: samples => received.push(samples) }), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws); // hello
		ws.send(new Uint8Array([0x02, 1, 2, 3, 4])); // the server→client tag, sent by a client — refused
		ws.send(new Uint8Array([0x01, 1, 2, 3])); // 3 payload bytes: not a whole Float32
		ws.send(new Uint8Array([0x01])); // tag only, no payload at all
		await settle();
		expect(received).toHaveLength(0);
		ws.close();
		bridge.close();
	});

	test("publishOutputAudio reaches a viewer as a binary frame tagged 0x02, carrying the exact bytes given", async () => {
		const p = port++;
		const bridge = new Bridge(handlers({ onMicAudio: () => {} }), { port: p });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws); // hello
		const next = nextBinaryMessage(ws);
		const bytes = new Uint8Array([9, 8, 7, 6, 5]);
		bridge.publishOutputAudio(bytes);
		const frame = await next;
		expect(frame[0]).toBe(0x02);
		expect([...frame.subarray(1)]).toEqual([...bytes]);
		ws.close();
		bridge.close();
	});

	test("publishOutputAudio with no listener and an empty payload are both no-ops", () => {
		const bridge = new Bridge(handlers({ onMicAudio: () => {} }), { port: port++ });
		expect(() => bridge.publishOutputAudio(new Uint8Array([1, 2, 3]))).not.toThrow(); // never opened; no sockets
		expect(() => bridge.publishOutputAudio(new Uint8Array(0))).not.toThrow();
	});

	test("mixing binary audio frames with the existing JSON control protocol on one connection does not disturb either", async () => {
		const p = port++;
		const calls = { stop: 0, toggleMute: 0 };
		const micSamples: Float32Array[] = [];
		const bridge = new Bridge(
			handlers({
				onStop: () => calls.stop++,
				onToggleMute: () => calls.toggleMute++,
				onMicAudio: samples => micSamples.push(samples),
			}),
			{ port: p },
		);
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws); // hello
		ws.send(JSON.stringify({ v: 1, type: "control", action: "toggleMute" }));
		ws.send(micFrame(new Float32Array([0.5, 0.25])));
		ws.send(JSON.stringify({ v: 1, type: "control", action: "stop" }));
		await settle();
		expect(calls).toEqual({ stop: 1, toggleMute: 1 });
		expect(micSamples).toHaveLength(1);
		expect([...(micSamples[0] ?? [])]).toEqual([0.5, 0.25]);
		ws.close();
		bridge.close();
	});
});

describe("Bridge — backward compatibility", () => {
	test("existing control actions (stop, toggleMute, steer) are unaffected by the new authorization path", async () => {
		const p = port++;
		const calls = { stop: 0, toggleMute: 0, steer: [] as string[] };
		const bridge = new Bridge(
			handlers({
				onStop: () => calls.stop++,
				onToggleMute: () => calls.toggleMute++,
				onSteer: text => calls.steer.push(text),
			}),
			{ port: p },
		);
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		await nextMessage(ws);
		ws.send(JSON.stringify({ v: 1, type: "control", action: "toggleMute" }));
		ws.send(JSON.stringify({ v: 1, type: "control", action: "steer", text: "do the thing" }));
		ws.send(JSON.stringify({ v: 1, type: "control", action: "stop" }));
		await settle();
		expect(calls).toEqual({ stop: 1, toggleMute: 1, steer: ["do the thing"] });
		ws.close();
		bridge.close();
	});
});

describe("Bridge — fleet delegation (concern 12)", () => {
	/** Collects frames while letting a test await the next one matching a predicate. */
	function frameSink(ws: WebSocket) {
		const frames: Record<string, unknown>[] = [];
		const waiters: Array<{
			match: (f: Record<string, unknown>) => boolean;
			resolve: (f: Record<string, unknown>) => void;
		}> = [];
		ws.onmessage = ev => {
			const frame = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()) as Record<
				string,
				unknown
			>;
			frames.push(frame);
			const index = waiters.findIndex(w => w.match(frame));
			if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
		};
		return {
			frames,
			next(match: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
				const existing = frames.find(match);
				if (existing) return Promise.resolve(existing);
				return new Promise(resolve => waiters.push({ match, resolve }));
			},
		};
	}

	async function attachExecutor(
		p: number,
		opts?: { token?: string; context?: string; fleetEnabled?: boolean; onFleetContext?: (context: string) => void },
	) {
		const bridge = new Bridge(handlers(opts?.onFleetContext ? { onFleetContext: opts.onFleetContext } : {}), {
			port: p,
			controlToken: opts?.token,
			fleetEnabled: opts?.fleetEnabled ?? true,
		});
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const sink = frameSink(ws);
		const hello = await sink.next(f => f.type === "hello");
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "attachFleet",
				requestId: "attach-1",
				...(opts?.token === undefined ? {} : { token: opts.token }),
				sessionId: hello.sessionId,
				...(opts?.context === undefined ? {} : { context: opts.context }),
			}),
		);
		const ack = await sink.next(f => f.type === "controlAck" && f.requestId === "attach-1");
		return { bridge, ws, sink, hello, ack };
	}

	test("hello advertises canFleet only when the bridge was built fleet-enabled", async () => {
		const p1 = port++;
		const enabled = new Bridge(handlers(), { port: p1, fleetEnabled: true });
		expect(enabled.open()).toBe(true);
		const ws1 = await connect(`ws://127.0.0.1:${p1}`);
		const hello1 = await nextMessage(ws1);
		expect(hello1.canFleet).toBe(true);
		ws1.close();
		enabled.close();

		const p2 = port++;
		const disabled = new Bridge(handlers(), { port: p2 });
		expect(disabled.open()).toBe(true);
		const ws2 = await connect(`ws://127.0.0.1:${p2}`);
		const hello2 = await nextMessage(ws2);
		expect("canFleet" in hello2).toBe(false);
		ws2.close();
		disabled.close();
	});

	test("attachFleet requires the per-call token and the right session", async () => {
		const p = port++;
		const bridge = new Bridge(handlers(), { port: p, controlToken: "secret", fleetEnabled: true });
		expect(bridge.open()).toBe(true);
		const ws = await connect(`ws://127.0.0.1:${p}`);
		const sink = frameSink(ws);
		const hello = await sink.next(f => f.type === "hello");
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "attachFleet",
				requestId: "a1",
				token: "wrong",
				sessionId: hello.sessionId,
			}),
		);
		const bad = await sink.next(f => f.type === "controlAck" && f.requestId === "a1");
		expect(bad.ok).toBe(false);
		expect(bad.reason).toBe("invalid-token");
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "attachFleet",
				requestId: "a2",
				token: "secret",
				sessionId: "stale-session",
			}),
		);
		const stale = await sink.next(f => f.type === "controlAck" && f.requestId === "a2");
		expect(stale.ok).toBe(false);
		expect(stale.reason).toBe("wrong-session");
		// And an un-attached call still fails fast rather than waiting out a timeout.
		const result = await bridge.callFleetTool("fleet_roster", {});
		expect(result).toEqual({ status: "failed", detail: "no fleet executor is attached to this call" });
		ws.close();
		bridge.close();
	});

	test("attachFleet against a bridge without the fleet surface is not-supported", async () => {
		const p = port++;
		const { bridge, ws, ack } = await attachExecutor(p, { fleetEnabled: false });
		expect(ack.ok).toBe(false);
		expect(ack.reason).toBe("not-supported");
		ws.close();
		bridge.close();
	});

	test("attachFleet forwards a bounded context brief to onFleetContext", async () => {
		const p = port++;
		const contexts: string[] = [];
		const { bridge, ws, ack } = await attachExecutor(p, {
			token: "t",
			context: `[Room context]\n${"x".repeat(20_000)}`,
			onFleetContext: context => contexts.push(context),
		});
		expect(ack.ok).toBe(true);
		await settle();
		expect(contexts).toHaveLength(1);
		expect(Array.from(contexts[0]!).length).toBeLessThanOrEqual(16_000);
		expect(contexts[0]!.startsWith("[Room context]")).toBe(true);
		ws.close();
		bridge.close();
	});

	test("a fleet call round-trips: directed fleetCall out, authenticated fleetResult back", async () => {
		const p = port++;
		const { bridge, ws, sink, hello, ack } = await attachExecutor(p, { token: "t" });
		expect(ack.ok).toBe(true);
		const pending = bridge.callFleetTool("fleet_steer", { unitId: "u1", message: "go" });
		const call = await sink.next(f => f.type === "fleetCall");
		expect(call.tool).toBe("fleet_steer");
		expect(call.args).toEqual({ unitId: "u1", message: "go" });
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "fleetResult",
				requestId: "r1",
				token: "t",
				sessionId: hello.sessionId,
				fleetCallId: call.fleetCallId,
				result: { status: "ok", detail: "delivered", data: "unit u1 acknowledged" },
			}),
		);
		const result = await pending;
		expect(result).toEqual({ status: "ok", detail: "delivered", data: "unit u1 acknowledged" });
		const resultAck = await sink.next(f => f.type === "controlAck" && f.requestId === "r1");
		expect(resultAck.ok).toBe(true);
		ws.close();
		bridge.close();
	});

	test("a needs-decision result narrows through the wire with its deferredActionId intact", async () => {
		const p = port++;
		const { bridge, ws, sink, hello } = await attachExecutor(p, { token: "t" });
		const pending = bridge.callFleetTool("fleet_answer_gate", { unitId: "u1", answer: "merge it" });
		const call = await sink.next(f => f.type === "fleetCall");
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "fleetResult",
				requestId: "r1",
				token: "t",
				sessionId: hello.sessionId,
				fleetCallId: call.fleetCallId,
				result: {
					status: "needs-decision",
					decision: {
						prompt: "Approve the merge?",
						options: [
							{ label: "Approve", consequence: "merges" },
							{ label: "Reject", consequence: "nothing" },
						],
						deferredActionId: "d-1",
					},
				},
			}),
		);
		const result = await pending;
		expect(result.status).toBe("needs-decision");
		if (result.status !== "needs-decision") throw new Error("unreachable");
		expect(result.decision.deferredActionId).toBe("d-1");
		expect(result.decision.options.map(o => o.label)).toEqual(["Approve", "Reject"]);
		ws.close();
		bridge.close();
	});

	test("a malformed fleetResult payload resolves as an honest failure, never an unchecked object", async () => {
		const p = port++;
		const { bridge, ws, sink, hello } = await attachExecutor(p, { token: "t" });
		const pending = bridge.callFleetTool("fleet_roster", {});
		const call = await sink.next(f => f.type === "fleetCall");
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "fleetResult",
				requestId: "r1",
				token: "t",
				sessionId: hello.sessionId,
				fleetCallId: call.fleetCallId,
				result: { status: "surprise", exploit: true },
			}),
		);
		const result = await pending;
		expect(result).toEqual({ status: "failed", detail: "malformed fleet result" });
		ws.close();
		bridge.close();
	});

	test("a fleet call times out honestly when the executor never answers", async () => {
		const p = port++;
		const { bridge, ws } = await attachExecutor(p, { token: "t" });
		const result = await bridge.callFleetTool("fleet_roster", {}, 80);
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("unreachable");
		expect(result.detail).toContain("did not answer within 80ms");
		ws.close();
		bridge.close();
	});

	test("an executor disconnect fails its in-flight calls immediately", async () => {
		const p = port++;
		const { bridge, ws, sink } = await attachExecutor(p, { token: "t" });
		const pending = bridge.callFleetTool("fleet_roster", {}, 10_000);
		await sink.next(f => f.type === "fleetCall");
		ws.close();
		const result = await pending;
		expect(result).toEqual({ status: "failed", detail: "the fleet executor disconnected" });
		bridge.close();
	});

	test("a fleetResult from a socket that is not the attached executor is refused", async () => {
		const p = port++;
		const { bridge, ws, hello } = await attachExecutor(p, { token: "t" });
		const other = await connect(`ws://127.0.0.1:${p}`);
		const otherSink = frameSink(other);
		await otherSink.next(f => f.type === "hello");
		other.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "fleetResult",
				requestId: "r1",
				token: "t",
				sessionId: hello.sessionId,
				fleetCallId: "whatever",
				result: { status: "ok" },
			}),
		);
		const ack = await otherSink.next(f => f.type === "controlAck" && f.requestId === "r1");
		expect(ack.ok).toBe(false);
		expect(ack.reason).toBe("not-attached");
		other.close();
		ws.close();
		bridge.close();
	});

	test("a fleetResult for an unknown (already settled) call is acked unknown-fleet-call", async () => {
		const p = port++;
		const { bridge, ws, sink, hello } = await attachExecutor(p, { token: "t" });
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "fleetResult",
				requestId: "r9",
				token: "t",
				sessionId: hello.sessionId,
				fleetCallId: "long-gone",
				result: { status: "ok" },
			}),
		);
		const ack = await sink.next(f => f.type === "controlAck" && f.requestId === "r9");
		expect(ack.ok).toBe(false);
		expect(ack.reason).toBe("unknown-fleet-call");
		ws.close();
		bridge.close();
	});

	test("the latest attachFleet wins — a reattaching daemon replaces its predecessor", async () => {
		const p = port++;
		const { bridge, ws: first, hello } = await attachExecutor(p, { token: "t" });
		const second = await connect(`ws://127.0.0.1:${p}`);
		const secondSink = frameSink(second);
		await secondSink.next(f => f.type === "hello");
		second.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "attachFleet",
				requestId: "a2",
				token: "t",
				sessionId: hello.sessionId,
			}),
		);
		const ack2 = await secondSink.next(f => f.type === "controlAck" && f.requestId === "a2");
		expect(ack2.ok).toBe(true);
		const pending = bridge.callFleetTool("fleet_roster", {});
		const call = await secondSink.next(f => f.type === "fleetCall");
		second.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "fleetResult",
				requestId: "r2",
				token: "t",
				sessionId: hello.sessionId,
				fleetCallId: call.fleetCallId,
				result: { status: "ok", detail: "from the new executor" },
			}),
		);
		const result = await pending;
		expect(result).toEqual({ status: "ok", detail: "from the new executor" });
		first.close();
		second.close();
		bridge.close();
	});

	test("a v1 client that never heard of fleet frames stays connected and unaffected", async () => {
		const p = port++;
		const { bridge, ws, sink, hello } = await attachExecutor(p, { token: "t" });
		// A second, fleet-oblivious viewer.
		const viewer = await connect(`ws://127.0.0.1:${p}`);
		const viewerFrames = collect(viewer);
		await settle();
		const pending = bridge.callFleetTool("fleet_roster", {});
		const call = await sink.next(f => f.type === "fleetCall");
		ws.send(
			JSON.stringify({
				v: 1,
				type: "control",
				action: "fleetResult",
				requestId: "r1",
				token: "t",
				sessionId: hello.sessionId,
				fleetCallId: call.fleetCallId,
				result: { status: "ok" },
			}),
		);
		await pending;
		bridge.publishPhase("working");
		await settle();
		// The viewer saw its hello and the phase broadcast — never a directed fleetCall or the ack.
		expect(viewerFrames.some(f => f.type === "fleetCall")).toBe(false);
		expect(viewerFrames.some(f => f.type === "controlAck")).toBe(false);
		expect(viewerFrames.some(f => f.type === "phase")).toBe(true);
		viewer.close();
		ws.close();
		bridge.close();
	});
});
