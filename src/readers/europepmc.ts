// Europe PMC reader. Free, no-auth, biomedical-focused (PubMed + more).
// Docs: https://europepmc.org/RestfulWebService

import type { SourceDocument } from "../types.ts";

const EPMC_API = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

export async function searchEuropePMC(query: string, limit: number): Promise<SourceDocument[]> {
  const params = new URLSearchParams({
    query,
    format: "json",
    pageSize: String(Math.min(Math.max(1, limit), 25)),
    resultType: "core",
  });
  const resp = await fetch(`${EPMC_API}?${params}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "verifiable-research-lab/0.1 (sample)",
    },
  });
  if (!resp.ok) {
    throw new Error(`Europe PMC search failed (${resp.status}): ${await resp.text()}`);
  }
  const data = (await resp.json()) as any;
  const hits = (data?.resultList?.result ?? []) as any[];
  const fetched_at = new Date().toISOString();

  return hits
    // Europe PMC frequently returns matches without an abstract (preprints,
    // index entries, conference proceedings). Drop those — they're unusable
    // for claim extraction, the Reader has no body to reason over.
    .filter((h: any) => typeof h?.abstractText === "string" && h.abstractText.trim().length > 0)
    .map((h) => {
      const id = h?.id ?? h?.pmid ?? h?.pmcid ?? "";
      const source = h?.source ?? "";
      const ftUrl: string | undefined = h?.fullTextUrlList?.fullTextUrl?.[0]?.url;
      const url: string =
        ftUrl
          ? ftUrl
          : h?.pmcid
            ? `https://europepmc.org/article/PMC/${String(h.pmcid).replace(/^PMC/, "")}`
            : h?.pmid
              ? `https://europepmc.org/article/MED/${h.pmid}`
              : `https://europepmc.org/article/${source}/${id}`;
      const authors: string[] = (h?.authorList?.author ?? [])
        .map((a: any) => a?.fullName ?? `${a?.firstName ?? ""} ${a?.lastName ?? ""}`.trim())
        .filter(Boolean);
      const text = [
        h?.title ?? "",
        h?.abstractText ?? "",
        h?.journalInfo?.journal?.title ? `Journal: ${h.journalInfo.journal.title}` : "",
        h?.firstPublicationDate ? `Published: ${h.firstPublicationDate}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        kind: "pubmed" as const,
        url,
        title: h?.title ?? "",
        authors,
        published_at: h?.firstPublicationDate,
        text,
        fetched_at,
      };
    });
}
