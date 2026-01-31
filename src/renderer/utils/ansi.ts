const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-Zcf-nqry=><]/g;

export type AnsiSegment = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
};

const PALETTE: Record<number, string> = {
  30: "#000000",
  31: "#cd3131",
  32: "#0dbc79",
  33: "#e5e510",
  34: "#2472c8",
  35: "#bc3fbc",
  36: "#11a8cd",
  37: "#e5e5e5",
  90: "#666666",
  91: "#f14c4c",
  92: "#23d18b",
  93: "#f5f543",
  94: "#3b8eea",
  95: "#d670d6",
  96: "#29b8db",
  97: "#e5e5e5",
};

const BG_PALETTE: Record<number, string> = {
  40: "#000000",
  41: "#cd3131",
  42: "#0dbc79",
  43: "#e5e510",
  44: "#2472c8",
  45: "#bc3fbc",
  46: "#11a8cd",
  47: "#e5e5e5",
  100: "#666666",
  101: "#f14c4c",
  102: "#23d18b",
  103: "#f5f543",
  104: "#3b8eea",
  105: "#d670d6",
  106: "#29b8db",
  107: "#e5e5e5",
};

export const parseAnsiToSegments = (raw: string): AnsiSegment[] => {
  const segments: AnsiSegment[] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let plainStart = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(ANSI_RE.source, "g");
  while ((match = re.exec(raw)) !== null) {
    const before = raw.slice(plainStart, match.index);
    if (before.length > 0) {
      segments.push({
        text: before,
        fg,
        bg,
        bold,
        dim,
        italic,
      });
    }
    plainStart = match.index + match[0].length;
    const code = match[0];
    if (code === "\u001b[0m" || code === "\u001b[0;0m") {
      fg = undefined;
      bg = undefined;
      bold = false;
      dim = false;
      italic = false;
      continue;
    }
    const m = code.match(/\u001b\[([\d;]*)m/);
    if (!m) continue;
    const parts = m[1].split(";").map(Number).filter(Boolean);
    for (const n of parts) {
      if (n === 0) {
        fg = undefined;
        bg = undefined;
        bold = false;
        dim = false;
        italic = false;
      } else if (n === 1) bold = true;
      else if (n === 2) dim = true;
      else if (n === 3) italic = true;
      else if (n === 22) bold = false;
      else if (n === 23) italic = false;
      else if (n >= 30 && n <= 37) fg = PALETTE[n];
      else if (n >= 90 && n <= 97) fg = PALETTE[n];
      else if (n >= 40 && n <= 47) bg = BG_PALETTE[n];
      else if (n >= 100 && n <= 107) bg = BG_PALETTE[n];
    }
  }
  const tail = raw.slice(plainStart);
  if (tail.length > 0) {
    segments.push({ text: tail, fg, bg, bold, dim, italic });
  }
  return segments.length > 0 ? segments : [{ text: raw }];
};
