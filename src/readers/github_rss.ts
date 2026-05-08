// GitHub README + arbitrary RSS readers.
// GitHub: unauthenticated REST works for public repos at low volume.
// RSS: minimal Atom/RSS 2.0 parser via fast-xml-parser.

import { XMLParser } from "fast-xml-parser";
import type { SourceDocument } from "../types.ts";

export interface GithubTarget {
  owner: string;
  repo: string;
}

export function parseGithubInput(input: string): GithubTarget | null {
  const m = input.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export async function fetchGithubReadme(owner: string, repo: string): Promise<SourceDocument | null> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
  const resp = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github.v3.raw",
      "User-Agent": "verifiable-research-lab/0.1 (sample)",
    },
  });
  if (!resp.ok) return null;
  const text = await resp.text();
  if (!text) return null;
  return {
    kind: "github",
    url: `https://github.com/${owner}/${repo}#readme`,
    title: `${owner}/${repo} README`,
    text: text.slice(0, 12000),
    fetched_at: new Date().toISOString(),
  };
}

export async function fetchRSS(feedUrl: string, limit: number): Promise<SourceDocument[]> {
  const resp = await fetch(feedUrl, {
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml",
      "User-Agent": "verifiable-research-lab/0.1 (sample)",
    },
  });
  if (!resp.ok) {
    throw new Error(`RSS fetch failed (${resp.status}): ${await resp.text()}`);
  }
  const xml = await resp.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const parsed = parser.parse(xml) as any;
  const fetched_at = new Date().toISOString();

  // RSS 2.0
  const channel = parsed?.rss?.channel;
  if (channel?.item) {
    const items = Array.isArray(channel.item) ? channel.item : [channel.item];
    return items.slice(0, limit).map((it: any) => ({
      kind: "rss" as const,
      url: it?.link ?? feedUrl,
      title: (it?.title ?? "").toString(),
      published_at: it?.pubDate,
      text: stripTags((it?.["content:encoded"] ?? it?.description ?? "").toString()).slice(0, 8000),
      fetched_at,
    }));
  }
  // Atom
  const feed = parsed?.feed;
  if (feed?.entry) {
    const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
    return entries.slice(0, limit).map((it: any) => {
      const linkHref = Array.isArray(it?.link)
        ? it.link.find((l: any) => l?.["@_rel"] !== "self")?.["@_href"]
        : it?.link?.["@_href"] ?? it?.link;
      const content = (it?.content?.["#text"] ?? it?.content ?? it?.summary?.["#text"] ?? it?.summary ?? "").toString();
      return {
        kind: "rss" as const,
        url: linkHref ?? feedUrl,
        title: (it?.title?.["#text"] ?? it?.title ?? "").toString(),
        published_at: it?.published ?? it?.updated,
        text: stripTags(content).slice(0, 8000),
        fetched_at,
      };
    });
  }
  return [];
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
