import { z } from "zod";
import type { Tool } from "../types.js";
import { truncate } from "../paths.js";

// ---- HTML to something a model can read -------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", times: "×", middot: "·",
};

const decode = (s: string): string =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? m;
  });

/** Strip a page down to its prose, keeping headings, lists, links and code. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg|iframe|nav|footer|form)\b[\s\S]*?<\/\1>/gi, "");
  // Prefer the main content when the page marks it.
  const main = s.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (main && main[1]!.length > 500) s = main[1]!;
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, body: string) => `\n\n${"#".repeat(Number(lvl))} ${body}\n\n`);
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<(?:br)\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|section|tr|h[1-6]|ul|ol|pre|table)>/gi, "\n\n");
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, "").trim();
    return label && !href.startsWith("#") ? `${label} (${href})` : label;
  });
  s = s.replace(/<(?:code|kbd)\b[^>]*>([\s\S]*?)<\/(?:code|kbd)>/gi, "`$1`");
  s = s.replace(/<[^>]+>/g, "");
  s = decode(s);
  s = s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const FetchArgs = z.object({
  url: z.string().url(),
  /** Some pages are worth reading whole; most are not. */
  max_chars: z.number().int().min(500).max(80_000).optional(),
});

const BLOCKED = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1)/i;

export const webFetchTool: Tool<z.infer<typeof FetchArgs>> = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its readable text: documentation, a changelog, an issue, a raw file. HTML is reduced to prose with headings, lists and links kept. Use web_search first when you do not have the URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
      max_chars: { type: "integer", description: "Truncate the page to this many characters (default 20000)" },
    },
    required: ["url"],
  },
  parse: (raw) => FetchArgs.parse(raw),
  // Reaching the network is not a local mutation, but it does leave the machine.
  risk: () => "mutate",
  summary: (a) => `fetch ${a.url.replace(/^https?:\/\//, "").slice(0, 80)}`,
  async execute(a, ctx) {
    let url: URL;
    try {
      url = new URL(a.url);
    } catch {
      return { content: `Not a URL: ${a.url}`, isError: true };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { content: `Only http and https are supported (got ${url.protocol})`, isError: true };
    }
    // Don't let a page walk into the machine's own network.
    if (BLOCKED.test(url.hostname)) {
      return { content: `Refusing to fetch a private address: ${url.hostname}`, isError: true };
    }

    const timeout = AbortSignal.timeout(20_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow", signal, headers: { "User-Agent": "xcodit", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8" } });
    } catch (err) {
      return { content: `Could not fetch ${url.href}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    if (!res.ok) return { content: `${url.href} returned HTTP ${res.status}`, isError: true };

    const type = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const text = /html/i.test(type) ? htmlToText(raw) : raw;
    const limit = a.max_chars ?? 20_000;
    return { content: `${url.href}\n\n${truncate(text, limit)}` };
  },
};

// ---- search -----------------------------------------------------------------

const SearchArgs = z.object({
  query: z.string().min(2),
  max_results: z.number().int().min(1).max(10).optional(),
});

export interface SearchBackend {
  search(query: string, maxResults: number, signal?: AbortSignal): Promise<string>;
}

/**
 * Search runs through the gateway, so no key or vendor lands on the machine
 * and the cost is metered with everything else.
 */
export function makeWebSearchTool(backend: SearchBackend): Tool<z.infer<typeof SearchArgs>> {
  return {
    name: "web_search",
    description:
      "Search the web and get back an answer with source links. Use it for things outside the repository: library behaviour, error messages, release notes, API shapes. Follow up with web_fetch when you need the whole page.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", description: "Sources to consult, 1-10 (default 5)" },
      },
      required: ["query"],
    },
    parse: (raw) => SearchArgs.parse(raw),
    risk: () => "mutate",
    summary: (a) => `search ${JSON.stringify(a.query.slice(0, 70))}`,
    async execute(a, ctx) {
      try {
        const answer = await backend.search(a.query, a.max_results ?? 5, ctx.signal);
        return { content: truncate(answer, 24_000) };
      } catch (err) {
        return { content: `Search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
