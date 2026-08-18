const REFLECT_OPEN = "<reflect";
const REFLECT_CLOSE = "</reflect>";

const REFLECT_OPEN_RE = /<reflect(?:\s+[^>]*)?>/g;
const REFLECT_UNIT_RE = /<reflect(?:\s+[^>]*)?>(.*?)<\/reflect>/gs;
const REFLECT_TYPED_RE = /<reflect\s+type="([^"]+)">(.*?)<\/reflect>/gs;
const ANY_CLOSER_RE = /<\/[^<>\n]{1,40}>/g;
const NESTED_CONTROL_TAG_RE =
	/<\/?(?:reflect|think(?:ing)?|tool(?:_call|_use)?|function(?:_call)?|assistant|user|system|developer)(?=[\s/>"'=])[^<>]*>/i;

/** Maximum UTF-8 size of one harvested reflect body. */
export const MAX_REFLECT_UNIT_BYTES = 4 * 1024;

/** Maximum UTF-8 size of one serialized fold. */
export const MAX_REFLECT_FOLD_BYTES = 64 * 1024;

export interface ReflectParserLimits {
	maxUnitBytes?: number;
	maxFoldBytes?: number;
}

export type ReflectTypedUnit = [atom: string, body: string];

function firstMatch(regex: RegExp, text: string, from: number): RegExpExecArray | null {
	regex.lastIndex = from;
	return regex.exec(text);
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function isSafeReflectBody(body: string, maxUnitBytes: number): boolean {
	return utf8Bytes(body) <= maxUnitBytes && !NESTED_CONTROL_TAG_RE.test(body);
}

/**
 * Rewrite malformed unit terminators to `</reflect>`.
 *
 * A genuine closer before the next opener always wins. Otherwise, the first
 * closing tag in that window is promoted. An in-flight trailing unit remains
 * unclosed, and applying the normalization repeatedly is a no-op.
 */
export function normalizeReflectClosers(text: string): string {
	if (!text?.includes(REFLECT_OPEN)) return text;

	const out: string[] = [];
	let index = 0;
	while (true) {
		const opener = firstMatch(REFLECT_OPEN_RE, text, index);
		if (!opener) {
			out.push(text.slice(index));
			return out.join("");
		}

		const openerEnd = opener.index + opener[0].length;
		out.push(text.slice(index, openerEnd));
		const nextOpener = firstMatch(REFLECT_OPEN_RE, text, openerEnd);
		const stop = nextOpener?.index ?? text.length;
		const window = text.slice(openerEnd, stop);
		if (window.includes(REFLECT_CLOSE)) {
			index = openerEnd;
			continue;
		}

		const closer = firstMatch(ANY_CLOSER_RE, window, 0);
		if (!closer) {
			index = openerEnd;
			continue;
		}

		out.push(window.slice(0, closer.index), REFLECT_CLOSE);
		index = openerEnd + closer.index + closer[0].length;
	}
}

/** Count all syntactically complete typed and untyped reflect units. */
export function countReflectUnits(text: string): number {
	if (!text) return 0;
	return Array.from(normalizeReflectClosers(text).matchAll(REFLECT_UNIT_RE)).length;
}

/** Return safe, complete typed or untyped unit bodies in source order. */
export function reflectUnits(text: string, limits: Pick<ReflectParserLimits, "maxUnitBytes"> = {}): string[] {
	const maxUnitBytes = limits.maxUnitBytes ?? MAX_REFLECT_UNIT_BYTES;
	const units: string[] = [];
	for (const match of normalizeReflectClosers(text || "").matchAll(REFLECT_UNIT_RE)) {
		const body = match[1].trim();
		if (isSafeReflectBody(body, maxUnitBytes)) units.push(body);
	}
	return units;
}

/**
 * Parse complete typed units, omitting bodies that exceed the byte limit or
 * contain nested model-control tags.
 */
export function parseReflectTypedUnits(
	text: string,
	limits: Pick<ReflectParserLimits, "maxUnitBytes"> = {},
): ReflectTypedUnit[] {
	const maxUnitBytes = limits.maxUnitBytes ?? MAX_REFLECT_UNIT_BYTES;
	const units: ReflectTypedUnit[] = [];
	for (const match of normalizeReflectClosers(text || "").matchAll(REFLECT_TYPED_RE)) {
		const body = match[2].trim();
		if (isSafeReflectBody(body, maxUnitBytes)) units.push([match[1], body]);
	}
	return units;
}

/** Drop everything after the final complete (possibly repaired) unit. */
export function truncateAtLastCompleteReflect(text: string): string {
	if (!text) return "";
	const normalized = normalizeReflectClosers(text);
	const index = normalized.lastIndexOf(REFLECT_CLOSE);
	if (index === -1) return "";
	return normalized.slice(0, index + REFLECT_CLOSE.length);
}

/**
 * Round-robin merge per-atom bodies into complete typed reflect units.
 * Unsafe or oversized units are omitted. A unit that would exceed the fold
 * limit is skipped and later units are still considered, so the result is
 * always complete markup within the cap.
 */
export function interleaveTypedUnitsByAtom(
	unitsPerAtom: Readonly<Record<string, readonly string[]>>,
	atomOrder: readonly string[],
	limits: ReflectParserLimits = {},
): string {
	const maxUnitBytes = limits.maxUnitBytes ?? MAX_REFLECT_UNIT_BYTES;
	const maxFoldBytes = limits.maxFoldBytes ?? MAX_REFLECT_FOLD_BYTES;
	let maxLength = 0;
	for (const atom of atomOrder) maxLength = Math.max(maxLength, unitsPerAtom[atom]?.length ?? 0);

	const out: string[] = [];
	let foldBytes = 0;
	for (let index = 0; index < maxLength; index++) {
		for (const atom of atomOrder) {
			const body = unitsPerAtom[atom]?.[index]?.trim();
			if (body === undefined || !isSafeReflectBody(body, maxUnitBytes)) continue;

			const serialized = `<reflect type="${atom}">${body}</reflect>`;
			const addedBytes = utf8Bytes(serialized) + (out.length === 0 ? 0 : 1);
			if (foldBytes + addedBytes > maxFoldBytes) continue;
			out.push(serialized);
			foldBytes += addedBytes;
		}
	}
	return out.join("\n");
}
