import { execFileSync } from "node:child_process";

/**
 * PR 결과 수집.
 *
 * 초판의 타당성 게이트는 사람이 세션마다 good/bad 라벨을 붙이는 설계였다. 그건 틀렸다.
 * 세션마다 사람이 판정해야 해서 확장이 안 되고, 남의 하네스를 평가하려면 그 사람의
 * 라벨이 필요하고, 사람이 이미 좋고 나쁨을 안다면 도구가 무엇을 더하는지 불분명하다.
 *
 * 품질의 외부 근거는 사람 머릿속이 아니라 git 과 GitHub 에 이미 기록돼 있다.
 * 여기서는 판단하지 않고 사실만 모은다. 어느 신호를 타당성 근거로 쓸지는 상관 분석이
 * 정하고, 그때 변별력 없는 신호를 걸러낸다.
 */

export interface PrOutcome {
  number: number;
  state: string;
  createdAt: string | null;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** 리뷰 제출 건수. 승인·변경요청·코멘트를 모두 센다. */
  reviewCount: number;
  /** 변경 요청이 한 번이라도 있었는가. */
  changesRequested: boolean;
  /** 리뷰어 수. 같은 사람이 여러 번 남겨도 하나로 센다. */
  reviewerCount: number;
  commentCount: number;
}

interface RawReview {
  state?: string;
  author?: { login?: string };
}

interface RawPr {
  number?: number;
  state?: string;
  createdAt?: string;
  mergedAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviews?: RawReview[];
  comments?: unknown[];
}

const FIELDS = [
  "number",
  "state",
  "createdAt",
  "mergedAt",
  "additions",
  "deletions",
  "changedFiles",
  "reviews",
  "comments",
].join(",");

/** 한 번에 부를 PR 수. 크게 부르면 reviews·comments 때문에 GraphQL 이 504 로 끊는다. */
const PAGE_SIZE = 60;

function toOutcome(pr: RawPr): PrOutcome | null {
  if (typeof pr.number !== "number") return null;
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  return {
    number: pr.number,
    state: pr.state ?? "UNKNOWN",
    createdAt: pr.createdAt ?? null,
    mergedAt: pr.mergedAt ?? null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    reviewCount: reviews.length,
    changesRequested: reviews.some((r) => r.state === "CHANGES_REQUESTED"),
    reviewerCount: new Set(
      reviews.map((r) => r.author?.login).filter((l): l is string => l != null),
    ).size,
    commentCount: Array.isArray(pr.comments) ? pr.comments.length : 0,
  };
}

/**
 * 저장소의 PR 을 한 번에 끌어온다.
 *
 * PR 마다 따로 부르면 117번 왕복한다. 목록 한 번으로 필요한 필드가 다 온다.
 * `gh` 가 없거나 인증이 없으면 빈 배열을 낸다. 없는 것과 못 본 것을 호출부가
 * 구별해야 하므로 예외를 삼키지 않고 그대로 던진다.
 */
export function fetchPrOutcomes(
  repoDir: string,
  limit = 500,
): Map<number, PrOutcome> {
  // 한 번에 크게 부르면 GraphQL 이 504 로 끊는다. reviews·comments 를 함께 달라고 해서
  // 응답이 무거워지기 때문이다. 상태별로 나눠 작게 부르고, 한 쪽이 실패해도 나머지를 남긴다.
  const out = new Map<number, PrOutcome>();
  for (const state of ["merged", "closed", "open"]) {
    let taken = 0;
    while (taken < limit) {
      const take = Math.min(PAGE_SIZE, limit - taken);
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          execFileSync(
            "gh",
            [
              "pr",
              "list",
              "--state",
              state,
              "--limit",
              String(taken + take),
              "--json",
              FIELDS,
            ],
            { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
          ),
        );
      } catch {
        break;
      }
      if (!Array.isArray(parsed)) break;
      const before = out.size;
      for (const item of parsed) {
        const outcome = toOutcome(item as RawPr);
        if (outcome !== null) out.set(outcome.number, outcome);
      }
      // 더 달라고 해도 새 PR 이 안 늘면 그 상태는 다 본 것이다.
      if (out.size === before || parsed.length < taken + take) break;
      taken += take;
    }
  }
  return out;
}

export interface SignalSpread {
  name: string;
  /** 값이 몇 갈래로 갈리는가. 한 갈래면 변별력이 0이다. */
  distinct: number;
  /** 가장 흔한 값이 차지하는 비율. 1에 가까우면 사실상 상수다. */
  topShare: number;
  summary: string;
}

/**
 * 신호의 변별력을 먼저 본다.
 *
 * 머지율이 99%면 머지 여부는 정보가 0이다. 상관을 재기 전에 이걸 걸러야 한다.
 * 변별력 없는 신호로 상관이 안 나온 것을 "지표가 틀렸다"로 읽으면 안 된다.
 */
export function signalSpreads(outcomes: PrOutcome[]): SignalSpread[] {
  if (outcomes.length === 0) return [];
  const share = (values: string[]): { distinct: number; topShare: number } => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const top = Math.max(...counts.values());
    return { distinct: counts.size, topShare: top / values.length };
  };

  const merged = outcomes.map((o) => (o.mergedAt !== null ? "merged" : "not"));
  const changes = outcomes.map((o) => String(o.changesRequested));
  const rounds = outcomes.map((o) => String(Math.min(o.reviewCount, 5)));
  const reviewers = outcomes.map((o) => String(Math.min(o.reviewerCount, 3)));
  const comments = outcomes.map((o) => String(Math.min(o.commentCount, 5)));

  const mergedShare = share(merged);
  const changesShare = share(changes);
  return [
    {
      name: "머지 여부",
      ...mergedShare,
      summary: `머지 ${outcomes.filter((o) => o.mergedAt !== null).length}/${
        outcomes.length
      }`,
    },
    {
      name: "변경 요청",
      ...changesShare,
      summary: `있음 ${outcomes.filter((o) => o.changesRequested).length}/${
        outcomes.length
      }`,
    },
    {
      name: "리뷰 라운드",
      ...share(rounds),
      summary: `중앙값 ${median(outcomes.map((o) => o.reviewCount))}`,
    },
    {
      name: "리뷰어 수",
      ...share(reviewers),
      summary: `중앙값 ${median(outcomes.map((o) => o.reviewerCount))}`,
    },
    {
      name: "코멘트 수",
      ...share(comments),
      summary: `중앙값 ${median(outcomes.map((o) => o.commentCount))}`,
    },
  ];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
