import { C } from "./theme.js";
import type { Seg } from "./box.js";

/**
 * A deliberately small highlighter: one regex pass over comments, strings,
 * numbers, keywords and call sites. It covers the languages that show up in
 * agent output without pulling in a grammar engine.
 */

const KEYWORDS: Record<string, string[]> = {
  ts: "import export from as const let var function return class extends implements interface type enum async await new this super if else for while do switch case break continue try catch finally throw typeof instanceof in of void null undefined true false public private protected readonly static get set yield satisfies keyof infer".split(" "),
  py: "import from as def class return lambda if elif else for while try except finally raise with yield async await pass break continue global nonlocal assert del not and or in is None True False self".split(" "),
  sh: "if then else elif fi for while do done case esac function return export local readonly set unset source echo cd exit trap".split(" "),
  go: "package import func return var const type struct interface map chan go defer if else for range switch case break continue select nil true false string int error".split(" "),
  rs: "use pub fn let mut const struct enum impl trait for while loop match if else return move ref where async await dyn crate self Some None Ok Err".split(" "),
  json: "true false null".split(" "),
};

const ALIASES: Record<string, keyof typeof KEYWORDS> = {
  ts: "ts", tsx: "ts", typescript: "ts", js: "ts", jsx: "ts", javascript: "ts", mjs: "ts", cjs: "ts",
  py: "py", python: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh",
  go: "go", golang: "go",
  rs: "rs", rust: "rs",
  json: "json", jsonc: "json",
};

export const languageOf = (tag: string | undefined): keyof typeof KEYWORDS | null =>
  (tag ? ALIASES[tag.toLowerCase().trim()] ?? null : null);

const TOKEN = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[0-9a-f]+\b)|([A-Za-z_$][\w$]*)(\s*\()?|([{}()[\];:,.<>=+\-*/%!&|?]+)/gi;

/** Tokenize one line. Multi-line strings and block comments are not tracked. */
export function highlightLine(line: string, lang: keyof typeof KEYWORDS | null): Seg[] {
  if (!lang) return [{ text: line, color: C.fg }];
  const keywords = new Set(KEYWORDS[lang] ?? []);
  const segs: Seg[] = [];
  let i = 0;
  for (const m of line.matchAll(TOKEN)) {
    const at = m.index!;
    if (at > i) segs.push({ text: line.slice(i, at), color: C.fg });
    const [all, comment, str, num, word, call, punct] = m;
    if (comment) segs.push({ text: all, color: C.synComment, italic: true });
    else if (str) segs.push({ text: all, color: C.synString });
    else if (num) segs.push({ text: all, color: C.synNumber });
    else if (word) {
      const isKeyword = keywords.has(word);
      segs.push({ text: word, color: isKeyword ? C.synKeyword : call ? C.synFunc : C.fg, bold: isKeyword });
      if (call) segs.push({ text: call, color: C.synPunct });
    } else if (punct) segs.push({ text: all, color: C.synPunct });
    i = at + all.length;
  }
  if (i < line.length) segs.push({ text: line.slice(i), color: C.fg });
  return segs.length ? segs : [{ text: line, color: C.fg }];
}
