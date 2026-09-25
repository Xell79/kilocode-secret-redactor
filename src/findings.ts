export type FindingSource = "builtin" | "betterleaks" | "env";

export interface Finding {
  readonly category: string;
  readonly value: string;
  readonly source: FindingSource;
}

const SOURCE_RANK: Record<FindingSource, number> = {
  env: 3,
  betterleaks: 2,
  builtin: 1,
};

export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const byValue = new Map<string, Finding>();
  for (const finding of findings) {
    const current = byValue.get(finding.value);
    if (!current || SOURCE_RANK[finding.source] > SOURCE_RANK[current.source]) {
      byValue.set(finding.value, finding);
    }
  }
  return [...byValue.values()].sort((left, right) => right.value.length - left.value.length);
}
