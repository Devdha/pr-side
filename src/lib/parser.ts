import type { PrRef } from "./types.js";

// href="/owner/repo/pull/123" 형태의 앵커를 전부 추출한다. hotkey 링크나
// fragment(#issuecomment-...), 쿼리스트링이 붙어 있어도 pull 번호까지만 취해 매칭한다.
const ANCHOR_RE = /<a\b[^>]*\bhref="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#][^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi;

function extractUpdatedAt(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.updatedAt === "string") return obj.updatedAt;
  if (typeof obj.createdAt === "string") return obj.createdAt;
  return undefined;
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
      const existing = seen.get(key);
      if (existing) {
        if (!existing.title && title) existing.title = title;
        if (!existing.updatedAt && updatedAt) existing.updatedAt = updatedAt;
      } else {
        seen.set(key, {
          owner,
          repo,
          number,
          ...(title ? { title } : {}),
          ...(updatedAt ? { updatedAt } : {}),
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

    const existing = seen.get(key);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.updatedAt && updatedAt) existing.updatedAt = updatedAt;
    } else {
      seen.set(key, {
        owner,
        repo,
        number,
        ...(title ? { title } : {}),
        ...(updatedAt ? { updatedAt } : {}),
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

export function isLoggedOut(finalUrl: string, html: string): boolean {
  if (/^https?:\/\/github\.com\/login\b/i.test(finalUrl)) {
    return true;
  }
  if (/action="\/session"/i.test(html)) {
    return true;
  }
  return false;
}
