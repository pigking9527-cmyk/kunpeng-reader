const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const CJK_CHARACTER_GLOBAL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

export interface SearchResult {
  readonly title?: string;
  readonly author?: string;
  readonly count?: number;
  readonly score?: number;
}

export type SearchResultSortMode = "title" | "author" | "hits" | string;

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    return "&gt;";
  });
}

export function cjkNgramsForHighlight(value: unknown): string[] {
  const characters = Array.from(String(value).match(CJK_CHARACTER_GLOBAL) ?? []);
  const result: string[] = [];
  for (const size of [3, 2]) {
    if (characters.length < size) continue;
    for (let index = 0; index + size <= characters.length; index += 1) {
      result.push(characters.slice(index, index + size).join(""));
    }
  }
  return result;
}

export function highlightNeedles(value: unknown): string[] {
  const raw = String(value || "").trim();
  const seen = new Set<string>();
  const result: string[] = [];

  function add(candidate: unknown, allowSingleCjk = false): void {
    const normalized = String(candidate || "").trim();
    if (normalized.length < 2 && !allowSingleCjk) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  }

  add(raw, CJK_CHARACTER.test(raw));
  (raw.match(/[A-Za-z0-9]{2,}/g) ?? []).forEach((candidate) => add(candidate));
  cjkNgramsForHighlight(raw).forEach((candidate) => add(candidate));
  return result.sort((left, right) => right.length - left.length);
}

export function highlightSnippet(snippet: unknown, term: unknown): string {
  const text = String(snippet || "");
  const needles = highlightNeedles(term);
  if (needles.length === 0) return escapeHtml(text);
  const lowerCaseText = text.toLowerCase();
  let html = "";
  let position = 0;
  while (position < text.length) {
    const match = needles.find((needle) =>
      lowerCaseText.startsWith(needle.toLowerCase(), position),
    );
    if (match) {
      html += `<mark>${escapeHtml(text.slice(position, position + match.length))}</mark>`;
      position += match.length;
    } else {
      html += escapeHtml(text[position]);
      position += 1;
    }
  }
  return html;
}

function rankingValue(result: SearchResult): number {
  return result.score || result.count || 0;
}

export function sortSearchResults<T extends SearchResult>(
  list: readonly T[] | unknown,
  mode: SearchResultSortMode,
): T[] {
  const results: T[] = Array.isArray(list) ? (list as T[]).slice() : [];
  if (mode === "title") {
    results.sort((left, right) =>
      (left.title || "").localeCompare(right.title || "", "zh"),
    );
  } else if (mode === "author") {
    results.sort((left, right) =>
      (left.author || "").localeCompare(right.author || "", "zh"),
    );
  } else if (mode === "hits") {
    results.sort((left, right) => (right.count ?? 0) - (left.count ?? 0));
  } else {
    results.sort((left, right) => rankingValue(right) - rankingValue(left));
  }
  return results;
}

export const searchResultRules = Object.freeze({
  cjkNgramsForHighlight,
  escapeHtml,
  highlightNeedles,
  highlightSnippet,
  sortSearchResults,
});

export type SearchResultRulesApi = typeof searchResultRules;

export function installSearchResultRules(
  target: Record<string, unknown>,
): SearchResultRulesApi {
  target.ReaderSearchResultRules = searchResultRules;
  return searchResultRules;
}
