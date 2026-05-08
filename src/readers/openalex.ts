// OpenAlex reader. Free, polite-pool friendly when you set a mailto.
// Docs: https://docs.openalex.org/

import type { SourceDocument } from "../types.ts";

const OPENALEX_API = "https://api.openalex.org/works";

export async function searchOpenAlex(query: string, limit: number): Promise<SourceDocument[]> {
  const params = new URLSearchParams({
    search: query,
    per_page: String(Math.min(Math.max(1, limit), 10)),
  });
  // OpenAlex prefers a contact email for the "polite pool". Use a sample
  // address; doesn't authenticate, just identifies traffic.
  params.append("mailto", "verifiable-research-lab@example.com");

  const resp = await fetch(`${OPENALEX_API}?${params}`);
  if (!resp.ok) {
    throw new Error(`OpenAlex search failed (${resp.status}): ${await resp.text()}`);
  }
  const data = (await resp.json()) as any;
  const works = (data?.results ?? []) as any[];
  const fetched_at = new Date().toISOString();

  return works.map((w) => {
    const title = (w?.title ?? "").toString();
    const authors: string[] = (w?.authorships ?? [])
      .map((a: any) => a?.author?.display_name)
      .filter(Boolean);
    const url: string = w?.doi ?? w?.id ?? "";
    // Reconstruct abstract from the inverted index OpenAlex returns.
    const abstract = reconstructAbstract(w?.abstract_inverted_index);
    const venueName = w?.host_venue?.display_name ?? "";
    const text = [
      abstract,
      venueName ? `Venue: ${venueName}` : "",
      w?.publication_date ? `Published: ${w.publication_date}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      kind: "openalex" as const,
      url,
      title,
      authors,
      published_at: w?.publication_date,
      text,
      fetched_at,
    };
  });
}

function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) slots[pos] = word;
  }
  return slots.filter(Boolean).join(" ");
}
