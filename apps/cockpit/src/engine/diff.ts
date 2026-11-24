/** Minimal LCS line diff producing a git-style unified diff (single full-context hunk). */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  if (before === after) return "";
  const a = before === null || before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) lines.push(`-${a[i++]}`);
  while (j < m) lines.push(`+${b[j++]}`);
  const oldHeader = before === null ? "/dev/null" : `a/${path}`;
  const oldRange = n === 0 ? "0,0" : `1,${n}`;
  return [`--- ${oldHeader}`, `+++ b/${path}`, `@@ -${oldRange} +1,${m} @@`, ...lines].join("\n") + "\n";
}
