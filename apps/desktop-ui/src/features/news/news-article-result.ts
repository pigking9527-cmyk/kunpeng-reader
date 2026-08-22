import type {
  NewsArticleDocument,
  NewsArticleOpenResult,
  NewsNativeWebViewArticleResult,
  NewsTextArticleResult,
} from "./news-port.js";
import { safeHttpsUrl } from "./news-rules.js";

const MAX_ARTICLE_ID_LENGTH = 160;
const MAX_ARTICLE_TITLE_LENGTH = 320;
const MAX_ARTICLE_SOURCE_LENGTH = 160;
const MAX_ARTICLE_PARAGRAPHS = 1_200;
const MAX_PARAGRAPH_LENGTH = 12_000;
const HTML_TAG = /<\/?[a-z][^>]*>/iu;

function isPlainText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !HTML_TAG.test(value);
}

function isItemId(value: unknown): value is string {
  return isPlainText(value, MAX_ARTICLE_ID_LENGTH);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validOptionalPublishedAt(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validOptionalOriginalUrl(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && safeHttpsUrl(value) !== null);
}

function validTextArticle(value: unknown, itemId: string): NewsTextArticleResult | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== "text" || typeof input.article !== "object" || input.article === null) return null;
  const article = input.article as Record<string, unknown>;
  if (article.itemId !== itemId
    || !hasOnlyKeys(input, ["kind", "article"])
    || !hasOnlyKeys(article, ["itemId", "title", "sourceName", "publishedAt", "paragraphs", "originalUrl"])
    || !isPlainText(article.title, MAX_ARTICLE_TITLE_LENGTH)
    || !isPlainText(article.sourceName, MAX_ARTICLE_SOURCE_LENGTH)
    || !Array.isArray(article.paragraphs)
    || article.paragraphs.length > MAX_ARTICLE_PARAGRAPHS
    || !article.paragraphs.every((paragraph) => isPlainText(paragraph, MAX_PARAGRAPH_LENGTH))
    || !validOptionalPublishedAt(article.publishedAt)
    || !validOptionalOriginalUrl(article.originalUrl)) return null;
  const document: NewsArticleDocument = {
    itemId,
    title: article.title,
    sourceName: article.sourceName,
    paragraphs: article.paragraphs,
    ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
    ...(article.originalUrl ? { originalUrl: article.originalUrl } : {}),
  };
  return { kind: "text", article: document };
}

function validNativeWebView(value: unknown, itemId: string): NewsNativeWebViewArticleResult | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  return input.kind === "native-webview" && input.itemId === itemId && hasOnlyKeys(input, ["kind", "itemId"])
    ? { kind: "native-webview", itemId }
    : null;
}

/**
 * Converts a host response into the only two article results the UI accepts.
 * Any URL, HTML, host window ID or extra field is ignored; matching the
 * request's opaque feed ID prevents an injected reply from switching articles.
 */
export function parseNewsArticleOpenResult(value: unknown, itemId: string): NewsArticleOpenResult | null {
  if (!isItemId(itemId)) return null;
  return validTextArticle(value, itemId) ?? validNativeWebView(value, itemId);
}
