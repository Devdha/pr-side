import type { PrRef } from "./types.js";

// href="/owner/repo/pull/123" 형태의 앵커를 전부 추출한다. hotkey 링크나
// fragment(#issuecomment-...), 쿼리스트링이 붙어 있어도 pull 번호까지만 취해 매칭한다.
const ANCHOR_RE = /<a\b[^>]*\bhref="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#][^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi;

function extractUpdatedAt(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.updatedAt === "string") return obj.updatedAt;
  if (typeof obj.createdAt === "string") return obj.createdAt;
  return undefined;
}

function extractIsDraft(obj: Record<string, unknown>): boolean | undefined {
  return typeof obj.isDraft === "boolean" ? obj.isDraft : undefined;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePullsHtml(html: string): PrRef[] {
  const seen = new Map<string, PrRef>();

  let match: RegExpExecArray | null;
  ANCHOR_RE.lastIndex = 0;
  while ((match = ANCHOR_RE.exec(html)) !== null) {
    const [, owner, repo, numberStr, inner] = match;
    const number = Number.parseInt(numberStr, 10);
    if (!Number.isFinite(number)) continue;

    const key = `${owner}/${repo}#${number}`;
    const title = stripTags(inner);

    const existing = seen.get(key);
    if (existing) {
      if (!existing.title && title) {
        existing.title = title;
      }
      continue;
    }

    seen.set(key, {
      owner,
      repo,
      number,
      ...(title ? { title } : {}),
    });
  }

  // 로그인 대시보드(github.com/pulls)는 React 렌더링이라 초기 HTML에 앵커가 없다.
  // <script type="application/json" data-target="react-app.embeddedData"> 안의
  // GraphQL 프리로드 데이터에서도 PR을 추출해 병합한다.
  for (const pr of parseEmbeddedData(html)) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.title && pr.title) {
        existing.title = pr.title;
      }
      if (!existing.updatedAt && pr.updatedAt) {
        existing.updatedAt = pr.updatedAt;
      }
      if (existing.isDraft === undefined && pr.isDraft !== undefined) {
        existing.isDraft = pr.isDraft;
      }
      continue;
    }
    seen.set(key, pr);
  }

  return Array.from(seen.values());
}

// data-target 속성 순서가 다를 수 있으므로 속성 목록 어디에 있든 매치되게 한다.
const EMBEDDED_DATA_RE =
  /<script\b[^>]*\bdata-target="react-app\.embeddedData"[^>]*>([\s\S]*?)<\/script>/gi;

const MAX_WALK_DEPTH = 30;

function collectPrNodes(node: unknown, seen: Map<string, PrRef>, depth: number): void {
  if (depth > MAX_WALK_DEPTH || node === null || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectPrNodes(item, seen, depth + 1);
    }
    return;
  }

  const obj = node as Record<string, unknown>;

  // 신형 pulls 대시보드 아이템: permalink가 PR URL을 그대로 담고 있다.
  // 예: {itemType:"pull_request", permalink:"https://github.com/o/r/pull/1",
  //      repoNameWithOwner:"o/r", number:1, title:"..."}
  const permalink = obj.permalink ?? obj.url;
  if (typeof permalink === "string" && obj.itemType !== "issue") {
    const linkMatch =
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
        permalink,
      );
    if (linkMatch) {
      const [, owner, repo, numberStr] = linkMatch;
      const number = Number.parseInt(numberStr, 10);
      const key = `${owner}/${repo}#${number}`;
      const rawTitle =
        typeof obj.title === "string"
          ? obj.title
          : typeof obj.titleHtml === "string"
            ? obj.titleHtml
            : undefined;
      const title = rawTitle ? stripTags(rawTitle) : undefined;
      const updatedAt = extractUpdatedAt(obj);
      const isDraft = extractIsDraft(obj);
      const existing = seen.get(key);
      if (existing) {
        if (!existing.title && title) existing.title = title;
        if (!existing.updatedAt && updatedAt) existing.updatedAt = updatedAt;
        if (existing.isDraft === undefined && isDraft !== undefined) {
          existing.isDraft = isDraft;
        }
      } else {
        seen.set(key, {
          owner,
          repo,
          number,
          ...(title ? { title } : {}),
          ...(updatedAt ? { updatedAt } : {}),
          ...(isDraft !== undefined ? { isDraft } : {}),
        });
      }
    }
  }

  const number = obj.number;
  const repository = obj.repository as
    | { name?: unknown; owner?: { login?: unknown } }
    | undefined;
  const typename = obj.__typename;

  if (
    typeof number === "number" &&
    Number.isFinite(number) &&
    repository != null &&
    typeof repository.name === "string" &&
    repository.owner != null &&
    typeof repository.owner.login === "string" &&
    typename !== "Issue" &&
    (typename === "PullRequest" || typename === undefined)
  ) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const key = `${owner}/${repo}#${number}`;

    const rawTitle =
      typeof obj.titleHtml === "string"
        ? obj.titleHtml
        : typeof obj.title === "string"
          ? obj.title
          : undefined;
    const title = rawTitle ? stripTags(rawTitle) : undefined;
    const updatedAt = extractUpdatedAt(obj);
    const isDraft = extractIsDraft(obj);

    const existing = seen.get(key);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.updatedAt && updatedAt) existing.updatedAt = updatedAt;
      if (existing.isDraft === undefined && isDraft !== undefined) {
        existing.isDraft = isDraft;
      }
    } else {
      seen.set(key, {
        owner,
        repo,
        number,
        ...(title ? { title } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(isDraft !== undefined ? { isDraft } : {}),
      });
    }
  }

  for (const value of Object.values(obj)) {
    collectPrNodes(value, seen, depth + 1);
  }
}

export function parseEmbeddedData(html: string): PrRef[] {
  const seen = new Map<string, PrRef>();

  let match: RegExpExecArray | null;
  EMBEDDED_DATA_RE.lastIndex = 0;
  while ((match = EMBEDDED_DATA_RE.exec(html)) !== null) {
    const jsonText = match[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }
    collectPrNodes(parsed, seen, 0);
  }

  return Array.from(seen.values());
}

export type PrPageState = "open" | "merged" | "closed" | "unknown";

interface PrStateHit {
  value: Exclude<PrPageState, "unknown">;
  /** __typename이 "PullRequest"인 노드에서 나온 값이면 더 신뢰할 수 있다. */
  typed: boolean;
}

function normalizeStateValue(raw: string): Exclude<PrPageState, "unknown"> | undefined {
  switch (raw.toUpperCase()) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return undefined;
  }
}

function collectPrStateHits(node: unknown, hits: PrStateHit[], depth: number): void {
  if (depth > MAX_WALK_DEPTH || node === null || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectPrStateHits(item, hits, depth + 1);
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  const raw =
    typeof obj.state === "string"
      ? obj.state
      : typeof obj.displayState === "string"
        ? obj.displayState
        : undefined;
  if (raw) {
    const value = normalizeStateValue(raw);
    if (value) {
      hits.push({ value, typed: obj.__typename === "PullRequest" });
    }
  }

  for (const value of Object.values(obj)) {
    collectPrStateHits(value, hits, depth + 1);
  }
}

/**
 * 단일 PR 페이지 HTML(embedded JSON)에서 그 PR의 open/merged/closed 상태를
 * 판별한다. "리뷰한 PR 유지" 기능이 후보 PR이 아직 열려 있는지 확인하는 데
 * 쓴다. __typename이 "PullRequest"인 노드의 state/displayState를 우선하고,
 * 없으면 처음 발견되는 state/displayState 값으로 대체한다. 판별 불가면
 * "unknown"을 반환한다(안전하게 "열려 있을 수 있음"으로 취급하도록).
 */
export function parsePrPageState(html: string): PrPageState {
  const hits: PrStateHit[] = [];

  let match: RegExpExecArray | null;
  EMBEDDED_DATA_RE.lastIndex = 0;
  while ((match = EMBEDDED_DATA_RE.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    collectPrStateHits(parsed, hits, 0);
  }

  const typedHit = hits.find((hit) => hit.typed);
  if (typedHit) return typedHit.value;

  if (hits.length > 0) return hits[0].value;

  return "unknown";
}

export function isLoggedOut(finalUrl: string, html: string): boolean {
  if (/^https?:\/\/github\.com\/login\b/i.test(finalUrl)) {
    return true;
  }
  if (/action="\/session"/i.test(html)) {
    return true;
  }
  return false;
}
