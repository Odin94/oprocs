import stripAnsi from "strip-ansi";
import uFuzzy from "@leeoniya/ufuzzy";

export type SearchMode = "substring" | "fuzzy" | "regex";

export type SearchRequest = {
  id: number;
  lines: string[];
  query: string;
  mode: SearchMode;
  caseSensitive: boolean;
};

export type Match = { lineIndex: number; start: number; end: number };

export type SearchResponse = {
  id: number;
  matches: Match[];
  filteredLineIndices: number[];
};

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const runSubstring = (
  plainLines: string[],
  query: string,
  caseSensitive: boolean
): { matches: Match[]; filteredLineIndices: number[] } => {
  const matches: Match[] = [];
  const filteredLineIndices: number[] = [];
  const flags = caseSensitive ? "g" : "gi";
  let re: RegExp;
  try {
    re = new RegExp(escapeRegex(query), flags);
  } catch {
    return { matches: [], filteredLineIndices: [] };
  }
  for (let i = 0; i < plainLines.length; i++) {
    const line = plainLines[i];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    let lineHasMatch = false;
    while ((m = re.exec(line)) !== null) {
      matches.push({ lineIndex: i, start: m.index, end: m.index + m[0].length });
      lineHasMatch = true;
    }
    if (lineHasMatch) filteredLineIndices.push(i);
  }
  return { matches, filteredLineIndices };
};

const runRegex = (
  plainLines: string[],
  query: string,
  caseSensitive: boolean
): { matches: Match[]; filteredLineIndices: number[] } => {
  const matches: Match[] = [];
  const filteredLineIndices: number[] = [];
  const flags = caseSensitive ? "g" : "gi";
  let re: RegExp;
  try {
    re = new RegExp(query, flags);
  } catch {
    return { matches: [], filteredLineIndices: [] };
  }
  for (let i = 0; i < plainLines.length; i++) {
    const line = plainLines[i];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    let lineHasMatch = false;
    while ((m = re.exec(line)) !== null) {
      matches.push({ lineIndex: i, start: m.index, end: m.index + m[0].length });
      lineHasMatch = true;
    }
    if (lineHasMatch) filteredLineIndices.push(i);
  }
  return { matches, filteredLineIndices };
};

const runFuzzy = (
  plainLines: string[],
  query: string
): { matches: Match[]; filteredLineIndices: number[] } => {
  const matches: Match[] = [];
  const filteredLineIndices: number[] = [];
  if (!query.trim()) return { matches, filteredLineIndices };
  const uf = new uFuzzy({ intraMode: 0 });
  const idxs = uf.filter(plainLines, query);
  if (!idxs || idxs.length === 0) return { matches, filteredLineIndices };
  const info = uf.info(idxs, plainLines, query);
  if (!info) return { matches, filteredLineIndices };
  const order = uf.sort(info, plainLines, query);
  const seenLines = new Set<number>();
  for (let i = 0; i < order.length; i++) {
    const infoIdx = order[i];
    const lineIdx = info.idx[infoIdx];
    const rangePairs = info.ranges[infoIdx];
    if (!rangePairs) continue;
    seenLines.add(lineIdx);
    for (let j = 0; j < rangePairs.length; j += 2) {
      matches.push({
        lineIndex: lineIdx,
        start: rangePairs[j],
        end: rangePairs[j + 1],
      });
    }
  }
  filteredLineIndices.push(...Array.from(seenLines).sort((a, b) => a - b));
  matches.sort((a, b) =>
    a.lineIndex !== b.lineIndex ? a.lineIndex - b.lineIndex : a.start - b.start
  );
  return { matches, filteredLineIndices };
};

self.onmessage = (e: MessageEvent<SearchRequest>) => {
  const { id, lines, query, mode, caseSensitive } = e.data;
  const plainLines = lines.map((l) => stripAnsi(l));
  let result: SearchResponse;
  if (!query.trim()) {
    result = { id, matches: [], filteredLineIndices: [] };
  } else if (mode === "substring") {
    const r = runSubstring(plainLines, query, caseSensitive);
    result = { id, ...r };
  } else if (mode === "regex") {
    const r = runRegex(plainLines, query, caseSensitive);
    result = { id, ...r };
  } else {
    const r = runFuzzy(plainLines, query);
    result = { id, ...r };
  }
  self.postMessage(result);
};
