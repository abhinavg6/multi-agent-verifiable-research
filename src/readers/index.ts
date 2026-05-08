// Public-good source readers. Each returns a normalized SourceDocument list
// (not just hits) so the Reader agent can pick the most relevant doc to pin.
//
// All endpoints used here are free + no-auth. Rate limits are gentle for
// demo-scale use; we don't add caching since the demo's value is showing
// fresh fetches mapped to fresh Walrus blobs.

import type { SourceDocument, SourceKind } from "../types.ts";
import { searchArxiv } from "./arxiv.ts";
import { searchWikipedia } from "./wikipedia.ts";
import { searchOpenAlex } from "./openalex.ts";
import { searchEuropePMC } from "./europepmc.ts";
import { fetchGithubReadme, fetchRSS, parseGithubInput } from "./github_rss.ts";

export interface ReaderOptions {
  query: string;
  kind: SourceKind;
  // For github: the input is "owner/repo"; for rss: a feed URL.
  hint?: string;
  maxResults?: number;
}

export async function searchSources(opts: ReaderOptions): Promise<SourceDocument[]> {
  const limit = opts.maxResults ?? 3;
  switch (opts.kind) {
    case "arxiv":
      return searchArxiv(opts.query, limit);
    case "wikipedia":
      return searchWikipedia(opts.query, limit);
    case "openalex":
      return searchOpenAlex(opts.query, limit);
    case "pubmed":
      return searchEuropePMC(opts.query, limit);
    case "github": {
      const target = opts.hint ?? guessGithubFromQuery(opts.query);
      if (!target) return [];
      const parsed = parseGithubInput(target);
      if (!parsed) return [];
      const doc = await fetchGithubReadme(parsed.owner, parsed.repo);
      return doc ? [doc] : [];
    }
    case "rss": {
      const feedUrl = opts.hint;
      if (!feedUrl) return [];
      return fetchRSS(feedUrl, limit);
    }
    default:
      return [];
  }
}

// Cheap heuristic for "github:owner/repo" or "owner/repo" embedded in a query.
function guessGithubFromQuery(q: string): string | null {
  const m = q.match(/([\w.-]+)\/([\w.-]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

export const SUPPORTED_KINDS: SourceKind[] = [
  "arxiv",
  "wikipedia",
  "openalex",
  "pubmed",
  "github",
  "rss",
];
