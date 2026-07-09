import {
  DEFAULT_HTTP_TIMEOUT_MS,
  type FetchLike,
  asFiniteNumber,
  asTrimmedString,
  fetchJson,
  isRecord,
  requireCredential,
} from "./common";
import { ProviderError, providerValidationError } from "./errors";

const DEFAULT_CALA_BASE_URL = "https://api.cala.ai";
const KNOWLEDGE_QUERY_PATH = "/v1/knowledge/query";

export interface CalaSource {
  id: string;
  title: string;
  url: string;
  publisher?: string;
  excerpt?: string;
  publishedAt?: string;
}

export interface CalaMover {
  ticker: string;
  company: string;
  direction: "up" | "down";
  changePct: number;
  catalyst: string;
  sourceIds: string[];
}

export interface CalaResearch {
  query: string;
  answer?: string;
  sources: CalaSource[];
  gainers: CalaMover[];
  decliners: CalaMover[];
}

export interface CalaQueryInput {
  query: string;
}

export interface CalaProviderOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

interface SourceCandidate {
  aliases: string[];
  title?: string;
  url?: string;
  publisher?: string;
  excerpt?: string;
  publishedAt?: string;
}

interface NormalizedSources {
  sources: CalaSource[];
  aliases: Map<string, string>;
  urls: Map<string, string>;
}

export class CalaProvider {
  private readonly apiKey: string;
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: CalaProviderOptions) {
    this.apiKey = requireCredential(options.apiKey, "cala", "Cala API key");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_CALA_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ProviderError("Cala timeout must be a positive number.", {
        provider: "cala",
        code: "CONFIGURATION",
        retryable: false,
      });
    }
  }

  async queryMarketMovers(input: CalaQueryInput): Promise<CalaResearch> {
    const query = validateQuery(input.query);
    const payload = await fetchJson({
      provider: "cala",
      fetch: this.fetch,
      url: `${this.baseUrl}${KNOWLEDGE_QUERY_PATH}`,
      timeoutMs: this.timeoutMs,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": this.apiKey,
        },
        body: JSON.stringify({
          input: buildMoverQuestion(query),
          return_entities: true,
        }),
      },
    });

    return normalizeCalaResponse(payload, query);
  }

  query(input: CalaQueryInput): Promise<CalaResearch> {
    return this.queryMarketMovers(input);
  }
}

export function createCalaProvider(options: CalaProviderOptions): CalaProvider {
  return new CalaProvider(options);
}

export function normalizeCalaResponse(payload: unknown, query: string): CalaResearch {
  const rows = extractRows(payload);
  if (rows.length === 0) {
    throw providerValidationError("cala", "Cala returned no structured market movers.");
  }

  const sourceCandidates = [
    ...extractResponseSourceCandidates(payload),
    ...rows.flatMap(extractRowSourceCandidates),
  ];
  const normalizedSources = normalizeSources(sourceCandidates);

  if (normalizedSources.sources.length === 0) {
    throw providerValidationError("cala", "Cala returned no valid source URLs.");
  }

  const explainability = extractExplainability(payload);
  const seenTickers = new Set<string>();
  const movers: CalaMover[] = [];

  for (const row of rows) {
    const mover = normalizeMover(row, normalizedSources, explainability);
    if (!mover || seenTickers.has(mover.ticker)) continue;
    seenTickers.add(mover.ticker);
    movers.push(mover);
  }

  const gainers = movers.filter((mover) => mover.direction === "up").slice(0, 2);
  const decliners = movers.filter((mover) => mover.direction === "down").slice(0, 2);

  if (gainers.length + decliners.length === 0) {
    throw providerValidationError(
      "cala",
      "Cala movers were missing valid fields or source references.",
    );
  }

  const usedSourceIds = new Set(
    [...gainers, ...decliners].flatMap((mover) => mover.sourceIds),
  );

  return {
    query,
    answer: extractAnswer(payload),
    sources: normalizedSources.sources.filter((source) => usedSourceIds.has(source.id)),
    gainers,
    decliners,
  };
}

function validateQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw providerValidationError("cala", "Cala query is required.");
  }

  const query = value.trim();
  if (query.length > 4_000) {
    throw providerValidationError("cala", "Cala query is too long.");
  }
  return query;
}

function buildMoverQuestion(query: string): string {
  return [
    query,
    "Return one structured row per US-listed equity mover.",
    "Use exactly these fields: ticker, company, direction (up or down), change_pct (signed number), catalyst, source_id, source_title, source_url, publisher, and published_at.",
    "Prioritize two gainers and two decliners when the available sourced data supports them.",
    "Do not include a row without a direct HTTP or HTTPS source URL for its percentage and catalyst.",
  ].join("\n");
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("Cala base URL is invalid.", {
      provider: "cala",
      code: "CONFIGURATION",
      retryable: false,
    });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError("Cala base URL must use HTTP or HTTPS.", {
      provider: "cala",
      code: "CONFIGURATION",
      retryable: false,
    });
  }
  if (url.username || url.password) {
    throw new ProviderError("Cala base URL cannot contain credentials.", {
      provider: "cala",
      code: "CONFIGURATION",
      retryable: false,
    });
  }

  return url.toString().replace(/\/$/, "");
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  const gainers = arrayOfRecords(getField(payload, ["gainers", "winners"]))
    .map((row) => ({ ...row, direction: getField(row, ["direction"]) ?? "up" }));
  const decliners = arrayOfRecords(getField(payload, ["decliners", "losers"]))
    .map((row) => ({ ...row, direction: getField(row, ["direction"]) ?? "down" }));
  if (gainers.length || decliners.length) return [...gainers, ...decliners];

  for (const key of ["results", "movers", "rows", "data"]) {
    const candidate = getField(payload, [key]);
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) {
      const nested = extractRows(candidate);
      if (nested.length) return nested;
    }
  }

  const content = asTrimmedString(payload.content);
  if (!content) return [];
  const embedded = parseEmbeddedJson(content);
  return embedded === undefined ? [] : extractRows(embedded);
}

function extractResponseSourceCandidates(payload: unknown): SourceCandidate[] {
  if (!isRecord(payload)) return [];
  const candidates: SourceCandidate[] = [];

  for (const key of ["context", "sources"]) {
    for (const item of arrayOfRecords(getField(payload, [key]))) {
      candidates.push(...sourceCandidatesFromContainer(item));
    }
  }

  return candidates;
}

function sourceCandidatesFromContainer(container: Record<string, unknown>): SourceCandidate[] {
  const containerId = asTrimmedString(getField(container, ["id", "source_id", "sourceId"]));
  const excerpt = asTrimmedString(getField(container, ["content", "excerpt", "snippet"]));
  const origins = arrayOfRecords(getField(container, ["origins"]));

  if (origins.length === 0) {
    const candidate = sourceCandidateFromObject(container, containerId, excerpt, true);
    return candidate ? [candidate] : [];
  }

  return origins.flatMap((origin, index) => {
    const fallbackId = index === 0 || !containerId ? containerId : `${containerId}:${index + 1}`;
    const candidate = sourceCandidateFromObject(origin, fallbackId, excerpt, true);
    if (!candidate) return [];
    if (containerId && !candidate.aliases.includes(containerId)) candidate.aliases.push(containerId);
    return [candidate];
  });
}

function extractRowSourceCandidates(row: Record<string, unknown>): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  const flat = sourceCandidateFromObject(row, undefined, undefined, false);
  if (flat) candidates.push(flat);

  for (const key of ["source", "document"]) {
    const item = getField(row, [key]);
    if (!isRecord(item)) continue;
    const nested = sourceCandidateFromObject(item, undefined, undefined, true);
    if (nested) candidates.push(nested);
  }

  for (const key of ["sources", "origins"]) {
    for (const item of arrayOfRecords(getField(row, [key]))) {
      const nested = sourceCandidateFromObject(item, undefined, undefined, true);
      if (nested) candidates.push(nested);
    }
  }

  return candidates;
}

function sourceCandidateFromObject(
  value: Record<string, unknown>,
  fallbackId?: string,
  fallbackExcerpt?: string,
  allowGenericUrl = false,
): SourceCandidate | undefined {
  const source = isRecord(value.source) ? value.source : undefined;
  const document = isRecord(value.document) ? value.document : undefined;
  const url = firstString([
    document && getField(document, ["url", "document_url"]),
    getField(value, ["source_url", "sourceUrl", "document_url", "documentUrl"]),
    allowGenericUrl ? getField(value, ["url"]) : undefined,
    source && getField(source, ["url"]),
  ]);
  if (!url) return undefined;

  const aliases = uniqueStrings([
    asTrimmedString(getField(value, ["source_id", "sourceId", "id"])),
    fallbackId,
  ]);
  const title = firstString([
    document && getField(document, ["name", "title"]),
    getField(value, ["source_title", "sourceTitle", "document_title", "documentTitle"]),
    allowGenericUrl ? getField(value, ["title", "name"]) : undefined,
  ]);
  const publisher = firstString([
    source && getField(source, ["name", "publisher"]),
    getField(value, ["publisher", "source_name", "sourceName"]),
  ]);

  return {
    aliases,
    title,
    url,
    publisher,
    excerpt: firstString([getField(value, ["excerpt", "content", "snippet"]), fallbackExcerpt]),
    publishedAt: firstString([
      getField(value, ["published_at", "publishedAt", "date", "published"]),
      document && getField(document, ["published_at", "publishedAt", "date"]),
    ]),
  };
}

function normalizeSources(candidates: SourceCandidate[]): NormalizedSources {
  const sources: CalaSource[] = [];
  const aliases = new Map<string, string>();
  const urls = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const candidate of candidates) {
    const normalizedUrl = normalizeSourceUrl(candidate.url);
    if (!normalizedUrl) continue;

    const canonicalUrl = canonicalSourceUrl(normalizedUrl);
    const duplicateId = urls.get(canonicalUrl);
    if (duplicateId) {
      for (const alias of candidate.aliases) aliases.set(alias, duplicateId);
      continue;
    }

    const preferredId = candidate.aliases[0];
    const id = uniqueSourceId(preferredId, canonicalUrl, usedIds);
    usedIds.add(id);
    urls.set(canonicalUrl, id);
    aliases.set(id, id);
    for (const alias of candidate.aliases) aliases.set(alias, id);

    const parsedUrl = new URL(normalizedUrl);
    sources.push({
      id,
      title: candidate.title ?? candidate.publisher ?? parsedUrl.hostname,
      url: normalizedUrl,
      publisher: candidate.publisher,
      excerpt: candidate.excerpt,
      publishedAt: candidate.publishedAt,
    });
  }

  return { sources, aliases, urls };
}

function normalizeMover(
  row: Record<string, unknown>,
  normalizedSources: NormalizedSources,
  explainability: Record<string, unknown>[],
): CalaMover | undefined {
  const rawTicker = firstString([
    getField(row, ["ticker", "symbol", "stock_ticker", "stockTicker"]),
  ]);
  if (!rawTicker) return undefined;

  const ticker = rawTicker.replace(/^\$/, "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return undefined;

  const change = asFiniteNumber(
    getField(row, [
      "change_pct",
      "changePct",
      "percentage_change",
      "percent_change",
      "change",
      "performance",
    ]),
  );
  if (change === undefined || change === 0) return undefined;

  const direction = normalizeDirection(getField(row, ["direction", "movement", "side"]), change);
  if (!direction) return undefined;

  const company = firstString([
    getField(row, ["company", "company_name", "companyName", "name"]),
    ticker,
  ]);
  const catalyst = firstString([
    getField(row, ["catalyst", "reason", "cause", "driver", "explanation"]),
  ]);
  if (!company || !catalyst) return undefined;

  const rawSourceIds = extractSourceReferences(row);
  const sourceIds = new Set<string>();
  for (const sourceId of rawSourceIds) {
    const normalized = normalizedSources.aliases.get(sourceId);
    if (normalized) sourceIds.add(normalized);
  }

  for (const url of extractSourceUrls(row)) {
    const normalizedUrl = normalizeSourceUrl(url);
    if (!normalizedUrl) continue;
    const id = normalizedSources.urls.get(canonicalSourceUrl(normalizedUrl));
    if (id) sourceIds.add(id);
  }

  if (sourceIds.size === 0) {
    for (const step of explainability) {
      const content = asTrimmedString(getField(step, ["content", "text", "claim"]));
      if (!content || !mentionsMover(content, ticker, company)) continue;
      for (const reference of stringList(getField(step, ["references", "source_ids", "sourceIds"]))) {
        const normalized = normalizedSources.aliases.get(reference);
        if (normalized) sourceIds.add(normalized);
      }
    }
  }

  if (sourceIds.size === 0) return undefined;

  return {
    ticker,
    company,
    direction,
    changePct: direction === "down" ? -Math.abs(change) : Math.abs(change),
    catalyst,
    sourceIds: [...sourceIds],
  };
}

function extractSourceReferences(row: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...stringList(
      getField(row, [
        "source_ids",
        "sourceIds",
        "source_id",
        "sourceId",
        "references",
        "context_ids",
        "contextIds",
      ]),
    ),
    ...arrayOfRecords(getField(row, ["sources", "origins"]))
      .flatMap((source) => stringList(getField(source, ["id", "source_id", "sourceId"]))),
  ]);
}

function extractSourceUrls(row: Record<string, unknown>): string[] {
  const urls = [
    ...stringList(getField(row, ["source_url", "sourceUrl", "document_url", "documentUrl"])),
  ];

  for (const key of ["source", "document"]) {
    const source = getField(row, [key]);
    if (isRecord(source)) urls.push(...stringList(getField(source, ["url"])));
  }
  for (const source of arrayOfRecords(getField(row, ["sources", "origins"]))) {
    urls.push(...stringList(getField(source, ["url", "source_url", "document_url"])));
    if (isRecord(source.document)) urls.push(...stringList(getField(source.document, ["url"])));
  }

  return uniqueStrings(urls);
}

function extractExplainability(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  return arrayOfRecords(getField(payload, ["explainability", "reasoning"]));
}

function extractAnswer(payload: unknown): string | undefined {
  return isRecord(payload) ? asTrimmedString(getField(payload, ["content", "answer"])) : undefined;
}

function normalizeDirection(value: unknown, change: number): "up" | "down" | undefined {
  const direction = asTrimmedString(value)?.toLowerCase();
  if (direction) {
    if (/^(up|gainer|gain|positive|rise|riser|winner|advance|higher)$/.test(direction)) return "up";
    if (/^(down|decliner|decline|negative|fall|faller|loser|lower)$/.test(direction)) return "down";
  }
  return change > 0 ? "up" : change < 0 ? "down" : undefined;
}

function normalizeSourceUrl(value: unknown): string | undefined {
  const candidate = asTrimmedString(value);
  if (!candidate) return undefined;

  try {
    const url = new URL(candidate);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return undefined;
    if (url.username || url.password || !url.hostname) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().toLowerCase();
}

function uniqueSourceId(preferred: string | undefined, url: string, used: Set<string>): string {
  const safePreferred = preferred?.trim().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
  const base = safePreferred || `source-${fnv1a(url)}`;
  if (!used.has(base)) return base;
  return `${base}-${fnv1a(url)}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseEmbeddedJson(content: string): unknown | undefined {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? (content.trim().startsWith("{") || content.trim().startsWith("[")
    ? content.trim()
    : undefined);
  if (!candidate) return undefined;

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function mentionsMover(content: string, ticker: string, company: string): boolean {
  const haystack = content.toLocaleLowerCase("en-US");
  return (
    new RegExp(`(^|[^a-z0-9])${escapeRegExp(ticker.toLowerCase())}([^a-z0-9]|$)`).test(haystack) ||
    haystack.includes(company.toLocaleLowerCase("en-US"))
  );
}

function getField(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (Object.hasOwn(record, alias)) return record[alias];
  }

  const normalizedAliases = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(record)) {
    if (normalizedAliases.has(normalizeKey(key))) return value;
  }
  return undefined;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asTrimmedString(value);
    if (text) return text;
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(stringList);
  const text = asTrimmedString(value);
  if (!text) return [];
  return text.includes(",") ? text.split(",").map((item) => item.trim()).filter(Boolean) : [text];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
