// arXiv API reader. Atom feed, no auth.
// Docs: https://info.arxiv.org/help/api/user-manual.html

import { XMLParser } from "fast-xml-parser";
import type { SourceDocument } from "../types.ts";

const ARXIV_API = "https://export.arxiv.org/api/query";

export async function searchArxiv(query: string, limit: number): Promise<SourceDocument[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: "0",
    max_results: String(Math.min(Math.max(1, limit), 10)),
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const resp = await fetch(`${ARXIV_API}?${params}`, {
    headers: { Accept: "application/atom+xml" },
  });
  if (!resp.ok) {
    throw new Error(`arXiv search failed (${resp.status}): ${await resp.text()}`);
  }
  const xml = await resp.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const parsed = parser.parse(xml) as any;
  const entries = parsed?.feed?.entry;
  const list = !entries ? [] : Array.isArray(entries) ? entries : [entries];

  const fetched_at = new Date().toISOString();
  return list.map((e: any) => {
    const id: string = e.id ?? "";
    const summary = (e.summary ?? "").toString().trim();
    const title = (e.title ?? "").toString().replace(/\s+/g, " ").trim();
    const authors = toArray(e.author).map((a: any) => (a?.name ?? "").toString());
    const published = e.published ?? e.updated;
    return {
      kind: "arxiv" as const,
      url: id,
      title,
      authors,
      published_at: published,
      // arXiv API gives abstracts; full PDF text would need extra fetch + parse.
      // For a sample, abstracts are plenty to demo claim extraction + citation.
      text: summary,
      fetched_at,
    };
  });
}

function toArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}
