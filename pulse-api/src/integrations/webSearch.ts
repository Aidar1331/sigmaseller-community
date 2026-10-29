import { getProviderSettings } from '../services/aiSettings.js';

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export async function searchWeb(query: string): Promise<{ results: WebSearchResult[]; note?: string }> {
  const settings = await getProviderSettings('web_search');
  const apiKey = settings.apiKey ?? undefined;
  const baseUrl = settings.baseUrl ?? undefined;

  if (!apiKey || !baseUrl) {
    return { results: [], note: 'WEB_SEARCH is not configured' };
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 5 }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Web search error ${res.status}: ${text.slice(0, 200)}`);
  }

  try {
    const payload = JSON.parse(text);
    if (payload?.web?.results) {
      return {
        results: payload.web.results.map((r: any) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          snippet: String(r.description ?? r.snippet ?? ''),
        })),
      };
    }
    if (Array.isArray(payload?.results)) {
      return {
        results: payload.results.map((r: any) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? r.link ?? ''),
          snippet: String(r.content ?? r.snippet ?? r.description ?? ''),
        })),
      };
    }
  } catch {
    // fallthrough
  }

  return { results: [], note: 'Web search returned no parsable results' };
}
