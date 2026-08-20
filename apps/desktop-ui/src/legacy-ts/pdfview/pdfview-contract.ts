export interface PdfSearchMatch {
  readonly page: number;
  readonly snippet: string;
}

export interface PdfSearchResult extends PdfSearchMatch {
  readonly chapter: number;
}

export function countReadablePdfChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function boundedPdfSearchResults(
  matches: readonly PdfSearchMatch[],
  maximumBytes: number,
  serializedBytes: (value: unknown) => number,
): Readonly<{ readonly searchResults: readonly PdfSearchResult[]; readonly searchCount: number }> {
  const searchResults: PdfSearchResult[] = [];
  for (const match of matches) {
    const next = { page: match.page, chapter: match.page - 1, snippet: match.snippet };
    if (serializedBytes({ searchResults: [...searchResults, next], searchCount: matches.length }) > maximumBytes) break;
    searchResults.push(next);
  }
  return Object.freeze({ searchResults: Object.freeze(searchResults), searchCount: matches.length });
}

export function pdfTurnTarget(currentPage: number, direction: number, dualMode: boolean): number {
  return dualMode ? (currentPage % 2 === 1 ? currentPage : currentPage - 1) + direction * 2 : currentPage + direction;
}

export function clampPdfScale(value: number): number {
  return Math.max(0.4, Math.min(4, value));
}

export function fitPdfScale(windowWidth: number, nativeWidth: number, dualMode: boolean): number {
  const available = Math.max(200, windowWidth - 28);
  return clampPdfScale((dualMode ? (available - 12) / 2 : available) / nativeWidth);
}

export function normalisePdfPage(total: number, requested: number): number {
  return Math.max(1, Math.min(total, requested | 0));
}
