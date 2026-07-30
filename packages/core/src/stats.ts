import {
  addCounts,
  addExtras,
  axisScore,
  coverageRatio,
  emptyAxes,
  emptyExtras,
  type AxisCount,
  type CoverageCount,
} from "./metrics.js";
import { emptyEvents, type Period } from "./periods.js";

/**
 * 능력치 6개.
 *
 * 축(readScope, indexedRetrieval 등)은 측정 가능한 것에서 거꾸로 나온 기술 지표라
 * 스탯 이름으로 읽히지 않는다. 여기서는 "어떤 능력을 보고 싶은가"에서 출발해 6개를 정하고,
 * 축과 보조 신호를 그 아래 구성요소로 넣는다.
 *
 * 합성으로 얻는 것이 셋 있다. 이름이 능력치처럼 읽히고, 신호 하나가 흔들려도 합성값이
 * 덜 튀고, 단독 축으로는 못 쓴 신호(interrupt·큐 개입·재작업)를 구성요소로 살릴 수 있다.
 */
export type StatKey =
  | "retrieval"
  | "context"
  | "verification"
  | "autonomy"
  | "delivery"
  | "discipline";

export interface StatComponent {
  label: string;
  /** 0~1. 높을수록 좋게 맞춘 값. */
  value: number | null;
  denominator: number;
}

export interface StatValue {
  key: StatKey;
  label: string;
  question: string;
  /** 0~100 */
  score: number | null;
  components: StatComponent[];
}

export const STAT_ORDER: StatKey[] = [
  "retrieval",
  "verification",
  "delivery",
  "autonomy",
  "discipline",
  "context",
];

export const STAT_LABELS: Record<StatKey, string> = {
  retrieval: "탐색력",
  context: "컨텍스트 관리",
  verification: "검증력",
  autonomy: "자율성",
  delivery: "완수력",
  discipline: "규율",
};

export const STAT_QUESTIONS: Record<StatKey, string> = {
  retrieval: "원하는 정보를 정확히 찾나",
  context: "필요한 만큼만 읽고 기억하나",
  verification: "주장 전에 확인하나",
  autonomy: "사람 개입 없이 완주하나",
  delivery: "산출물까지 도달하나",
  discipline: "정한 규칙과 도구 경로를 지키나",
};

/**
 * 자율성 상한.
 *
 * assistant 턴 100회당 개입 6건을 바닥(0점)으로 본다. 표본에서 주행 중 큐 개입이
 * 세션당 p90 2.74건이었으므로 6건은 넉넉한 상한이다. 상한이 필요한 이유는 개입 빈도가
 * 비율이 아니라 발생률이라 1로 정규화할 자연스러운 분모가 없기 때문이다.
 */
const AUTONOMY_CAP_PER_100_TURNS = 6;

function ratio(count: AxisCount): number | null {
  return count.den === 0 ? null : count.num / count.den;
}

function inverse(value: number | null): number | null {
  return value === null ? null : 1 - value;
}

/** 구성요소의 평균. 값이 없는 구성요소는 빼고 낸다. */
function meanOf(components: StatComponent[]): number | null {
  const values = components
    .map((c) => c.value)
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function component(
  label: string,
  value: number | null,
  denominator: number,
): StatComponent {
  return { label, value, denominator };
}

export function computeStats(period: Period): StatValue[] {
  const a = period.axes;
  const e = period.extras;

  const byKey: Record<StatKey, StatComponent[]> = {
    retrieval: [
      component(
        "인덱스 우선 탐색",
        axisScore("indexedRetrieval", a.indexedRetrieval),
        a.indexedRetrieval.den,
      ),
      component(
        "검색 한 번에 찾기",
        inverse(ratio(e.searchRepeat)),
        e.searchRepeat.den,
      ),
    ],
    context: [
      component(
        "읽기 범위 규율",
        axisScore("readScope", a.readScope),
        a.readScope.den,
      ),
      component(
        "읽은 것 기억하기",
        axisScore("readRevisit", a.readRevisit),
        a.readRevisit.den,
      ),
    ],
    verification: [
      component(
        "커밋 전 검증 신선도",
        axisScore("verificationFreshness", a.verificationFreshness),
        a.verificationFreshness.den,
      ),
      component(
        "검증 공회전 없음",
        axisScore("verificationRedundancy", a.verificationRedundancy),
        a.verificationRedundancy.den,
      ),
    ],
    autonomy: [
      component("사람 개입 없음", autonomyScore(period), e.assistantTurns),
    ],
    delivery: [
      component("산출물 도달", ratio(period.delivery), period.delivery.den),
      component("재작업 없음", inverse(ratio(e.rework)), e.rework.den),
    ],
    discipline: [
      component(
        "계측 채널 준수",
        axisScore("instrumentedChannel", a.instrumentedChannel),
        a.instrumentedChannel.den,
      ),
      component(
        "규칙 위반 시도 없음",
        inverse(ratio(e.ruleFriction)),
        e.ruleFriction.den,
      ),
    ],
  };

  return STAT_ORDER.map((key) => {
    const components = byKey[key];
    const mean = meanOf(components);
    return {
      key,
      label: STAT_LABELS[key],
      question: STAT_QUESTIONS[key],
      score: mean === null ? null : mean * 100,
      components,
    };
  });
}

/**
 * 개입 빈도를 0~1 점수로 바꾼다.
 *
 * interrupt 단독으로는 세션의 78%가 0이라 축이 서지 않았다. 도구 체인을 끊지 않는
 * 큐 개입과 도구 거부를 합치면 분포가 산다.
 */
function autonomyScore(period: Period): number | null {
  const turns = period.extras.assistantTurns;
  if (turns === 0) return null;
  const interventions =
    period.events.interrupt +
    period.events.queueMidflight +
    period.events.userRejected;
  const per100 = (interventions / turns) * 100;
  return Math.max(0, 1 - per100 / AUTONOMY_CAP_PER_100_TURNS);
}

export type Rank = "S" | "A" | "B" | "C" | "D" | "-";

export interface StatEntry extends StatValue {
  /** 이력 분포에서의 위치. 등급의 근거. */
  percentile: number | null;
  rank: Rank;
  /** 통상 범위 p25~p75 */
  typicalLow: number | null;
  typicalHigh: number | null;
  /** 개인 최고 기록. 성장 목표로 쓴다. */
  best: number | null;
}

export interface StatWindow {
  periodIndex: number;
  startedAt: string;
  endedAt: string;
  sessionCount: number;
  coverage: number | null;
  judgeable: boolean;
  stats: StatEntry[];
  overall: number | null;
  overallRank: Rank;
  level: number;
  historyWindows: number;
}

const COVERAGE_FLOOR = 0.5;

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const x = sorted[lo];
  const y = sorted[hi];
  if (x === undefined || y === undefined) return null;
  return x + (y - x) * (pos - lo);
}

function percentileOf(sorted: number[], value: number): number | null {
  if (sorted.length < 4) return null;
  let below = 0;
  for (const v of sorted) if (v < value) below += 1;
  return (below / sorted.length) * 100;
}

/**
 * 등급은 절대 임계가 아니라 내 이력 분포에서 매긴다.
 *
 * 절대 임계를 쓰면 "87점이 좋은 건지" 답할 근거가 없다. 좋은 세션 라벨이 없으므로
 * 외부 기준을 만들 수 없고, 만들면 그게 곧 근거 없는 숫자가 된다.
 * 이력 대비로 매기면 "내 평소보다 나은가"라는, 데이터가 답할 수 있는 질문이 된다.
 */
function rankFromPercentile(percentile: number | null): Rank {
  if (percentile === null) return "-";
  if (percentile >= 90) return "S";
  if (percentile >= 70) return "A";
  if (percentile >= 40) return "B";
  if (percentile >= 15) return "C";
  return "D";
}

function rankFromScore(score: number | null): Rank {
  if (score === null) return "-";
  if (score >= 90) return "S";
  if (score >= 78) return "A";
  if (score >= 62) return "B";
  if (score >= 45) return "C";
  return "D";
}

export interface StatWindowOptions {
  /**
   * 전수 집계처럼 창 자체가 기준선인 경우 이력 백분위로 등급을 매기면 안 된다.
   * 집계는 이벤트 가중이고 구간 이력은 구간 가중이라, 같은 데이터인데도 집계값이
   * 구간 중앙값보다 낮게 나와 84점이 C가 되는 일이 생긴다.
   */
  rankByAbsoluteScore?: boolean;
}

export function buildStatWindow(
  current: Period,
  history: Period[],
  options: StatWindowOptions = {},
): StatWindow {
  const closed = history.filter((p) => !p.open);
  const currentStats = computeStats(current);
  const historyStats = closed.map((p) => computeStats(p));

  const stats: StatEntry[] = currentStats.map((stat, index) => {
    const series = historyStats
      .map((s) => s[index]?.score)
      .filter((v): v is number => v !== undefined && v !== null)
      .sort((x, y) => x - y);
    const percentile =
      stat.score === null ? null : percentileOf(series, stat.score);
    return {
      ...stat,
      percentile,
      rank:
        options.rankByAbsoluteScore === true
          ? rankFromScore(stat.score)
          : rankFromPercentile(percentile),
      typicalLow: quantile(series, 0.25),
      typicalHigh: quantile(series, 0.75),
      best: series.length === 0 ? null : (series.at(-1) ?? null),
    };
  });

  const scored = stats
    .map((s) => s.score)
    .filter((v): v is number => v !== null);
  const overall =
    scored.length === 0
      ? null
      : scored.reduce((a, b) => a + b, 0) / scored.length;

  const coverage = coverageRatio(current.coverage);

  return {
    periodIndex: current.index,
    startedAt: current.startedAt,
    endedAt: current.endedAt,
    sessionCount: current.sessionIds.length,
    coverage,
    judgeable: coverage === null || coverage >= COVERAGE_FLOOR,
    stats,
    overall,
    overallRank: rankFromScore(overall),
    level: overall === null ? 0 : Math.max(1, Math.round(overall)),
    historyWindows: closed.length,
  };
}

/**
 * 여러 구간을 하나의 창으로 합친다.
 *
 * 전수 집계는 구간 하나만 보는 것과 다른 질문에 답한다. 구간 하나는 "지금 어떤가",
 * 전수는 "평소 어떤가"다. 후자가 기준선이므로 개별 구간을 읽기 전에 먼저 봐야 한다.
 */
export function mergePeriods(periods: Period[]): Period | null {
  const closed = periods.filter((p) => !p.open);
  const first = closed[0];
  const last = closed.at(-1);
  if (first === undefined || last === undefined) return null;

  const axes = emptyAxes();
  const extras = emptyExtras();
  const events = emptyEvents();
  const delivery = { num: 0, den: 0 };
  const coverage: CoverageCount = { observable: 0, offChannel: 0, opaque: 0 };
  const sessionIds: string[] = [];

  for (const p of closed) {
    addCounts(axes, p.axes);
    addExtras(extras, p.extras);
    events.interrupt += p.events.interrupt;
    events.queueMidflight += p.events.queueMidflight;
    events.userRejected += p.events.userRejected;
    delivery.num += p.delivery.num;
    delivery.den += p.delivery.den;
    coverage.observable += p.coverage.observable;
    coverage.offChannel += p.coverage.offChannel;
    coverage.opaque += p.coverage.opaque;
    sessionIds.push(...p.sessionIds);
  }

  return {
    index: -1,
    sessionIds,
    startedAt: first.startedAt,
    endedAt: last.endedAt,
    axes,
    extras,
    events,
    delivery,
    coverage,
    closedByBudget: true,
    unfilledAxes: [],
    open: false,
  };
}
