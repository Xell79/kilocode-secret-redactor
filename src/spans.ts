export interface Span {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly label: string;
  readonly stage: "whitelist" | "blacklist" | "betterleaks";
}

export function overlaps(left: Span, right: Pick<Span, "start" | "end">): boolean {
  return left.start < right.end && right.start < left.end;
}

export function maskOccupied(text: string, occupied: readonly Span[]): string {
  if (occupied.length === 0 || text.length === 0) return text;
  const ranges = occupied
    .map((span) => ({
      start: clamp(span.start, text.length),
      end: clamp(span.end, text.length),
    }))
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  if (merged.length === 0) return text;
  let cursor = 0;
  let masked = "";
  for (const range of merged) {
    if (range.start > cursor) masked += text.slice(cursor, range.start);
    masked += " ".repeat(range.end - range.start);
    cursor = range.end;
  }
  if (cursor < text.length) masked += text.slice(cursor);
  return masked;
}

export function replaceSpans(
  text: string,
  spans: readonly Span[],
  tokenFor: (span: Span) => string,
): string {
  const ordered = [...spans].sort((left, right) => right.start - left.start);
  let result = text;
  for (const span of ordered) {
    result = result.slice(0, span.start) + tokenFor(span) + result.slice(span.end);
  }
  return result;
}

function clamp(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(index, length));
}

export function locateUnoccupied(text: string, value: string, occupied: readonly Span[]): Span[] {
  const found: Span[] = [];
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(value, from);
    if (start < 0) break;
    const candidate = { start, end: start + value.length };
    if (!occupied.some((span) => overlaps(span, candidate))) {
      found.push({ ...candidate, value, label: "", stage: "betterleaks" });
    }
    from = start + Math.max(value.length, 1);
  }
  return found;
}
