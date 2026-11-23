type Edit = { kind: " " | "+" | "-"; line: string };

const contextLines = 3;
const maxDiffCells = 1_000_000;

function splitLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function computeEdits(before: string[], after: string[]): Edit[] {
  const edits: Edit[] = [];
  let start = 0;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) {
    edits.push({ kind: " ", line: before[start++]! });
  }
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  const columns = newCount + 1;
  // Oversized edited regions still produce a valid diff without an unbounded LCS matrix.
  if ((oldCount + 1) * columns > maxDiffCells) {
    for (let index = start; index < oldEnd; index++) edits.push({ kind: "-", line: before[index]! });
    for (let index = start; index < newEnd; index++) edits.push({ kind: "+", line: after[index]! });
  } else {
    const lengths = new Uint32Array((oldCount + 1) * columns);
    for (let old = oldCount - 1; old >= 0; old--) {
      for (let next = newCount - 1; next >= 0; next--) {
        const index = old * columns + next;
        lengths[index] = before[start + old] === after[start + next]
          ? 1 + lengths[index + columns + 1]!
          : Math.max(lengths[index + columns]!, lengths[index + 1]!);
      }
    }
    let old = 0;
    let next = 0;
    while (old < oldCount || next < newCount) {
      const index = old * columns + next;
      if (old < oldCount && next < newCount && before[start + old] === after[start + next]) {
        edits.push({ kind: " ", line: before[start + old++]! });
        next++;
      } else if (old < oldCount && (next === newCount || lengths[index + columns]! >= lengths[index + 1]!)) {
        edits.push({ kind: "-", line: before[start + old++]! });
      } else {
        edits.push({ kind: "+", line: after[start + next++]! });
      }
    }
  }
  for (let index = oldEnd; index < before.length; index++) edits.push({ kind: " ", line: before[index]! });
  return edits;
}

function isText(data: Buffer, encoded: string) {
  return !data.includes(0) && data.equals(Buffer.from(encoded));
}

export function unifiedDiff(path: string, before: Buffer | null, after: Buffer): string {
  if (before?.equals(after)) return "";
  const header = `--- a/${path}\n+++ b/${path}\n`;
  const oldText = before?.toString("utf8") ?? "";
  const newText = after.toString("utf8");
  if ((before && !isText(before, oldText)) || !isText(after, newText)) {
    return `${header}Binary files a/${path} and b/${path} differ\n`;
  }

  const edits = computeEdits(splitLines(oldText), splitLines(newText));
  const ranges: { start: number; end: number }[] = [];
  edits.forEach(({ kind }, index) => {
    if (kind === " ") return;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(edits.length, index + contextLines + 1);
    const last = ranges.at(-1);
    if (last && last.end >= start) last.end = end;
    else ranges.push({ start, end });
  });

  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  const result = [header];
  for (const { start, end } of ranges) {
    while (cursor < start) {
      if (edits[cursor]?.kind !== "+") oldLine++;
      if (edits[cursor]?.kind !== "-") newLine++;
      cursor++;
    }
    const hunk = edits.slice(start, end);
    const oldCount = hunk.filter(({ kind }) => kind !== "+").length;
    const newCount = hunk.filter(({ kind }) => kind !== "-").length;
    result.push(`@@ -${oldLine - Number(oldCount === 0)},${oldCount} +${newLine - Number(newCount === 0)},${newCount} @@\n`);
    for (const { kind, line } of hunk) {
      result.push(kind, line);
      if (!line.endsWith("\n")) result.push("\n\\ No newline at end of file\n");
    }
  }
  return result.join("");
}
