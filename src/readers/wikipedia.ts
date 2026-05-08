// Wikipedia REST API reader.
// We do a search → top N pages → fetch the plain-text extract for each.
// No auth, generous rate limits for demo use.

import type { SourceDocument } from "../types.ts";

const WIKI_API = "https://en.wikipedia.org/w/api.php";

export async function searchWikipedia(query: string, limit: number): Promise<SourceDocument[]> {
  const searchParams = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(Math.min(Math.max(1, limit), 10)),
    format: "json",
    origin: "*",
  });
  const sresp = await fetch(`${WIKI_API}?${searchParams}`, {
    headers: { "User-Agent": "verifiable-research-lab/0.1 (sample)" },
  });
  if (!sresp.ok) {
    throw new Error(`Wikipedia search failed (${sresp.status}): ${await sresp.text()}`);
  }
  const sdata = (await sresp.json()) as any;
  const hits = (sdata?.query?.search ?? []) as Array<{ title: string; pageid: number }>;
  if (hits.length === 0) return [];

  // Fetch extracts for each hit in a single batched call.
  const titles = hits.map((h) => h.title).join("|");
  const extractParams = new URLSearchParams({
    action: "query",
    prop: "extracts|info",
    inprop: "url",
    explaintext: "1",
    exsectionformat: "plain",
    titles,
    format: "json",
    origin: "*",
  });
  const eresp = await fetch(`${WIKI_API}?${extractParams}`, {
    headers: { "User-Agent": "verifiable-research-lab/0.1 (sample)" },
  });
  if (!eresp.ok) {
    throw new Error(`Wikipedia extracts failed (${eresp.status}): ${await eresp.text()}`);
  }
  const edata = (await eresp.json()) as any;
  const pages = (edata?.query?.pages ?? {}) as Record<
    string,
    { title: string; extract?: string; fullurl?: string }
  >;

  const fetched_at = new Date().toISOString();
  const docs: SourceDocument[] = [];
  for (const hit of hits) {
    const page = Object.values(pages).find((p) => p.title === hit.title);
    if (!page) continue;
    const text = (page.extract ?? "").trim();
    if (!text) continue;
    docs.push({
      kind: "wikipedia",
      url: page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
      title: page.title,
      // Cap extracted text so we don't pin megabyte blobs from giant pages —
      // 8k chars is already enough for the readers to do meaningful work.
      text: text.slice(0, 8000),
      fetched_at,
    });
  }
  return docs;
}
