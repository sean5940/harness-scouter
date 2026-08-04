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
import { emptyEvents, emptyUsage, type Period } from "./periods.js";
import { COMPONENT_CRITERIA } from "./growth.js";
import { L, type Localized } from "./i18n.js";
import {
  availableCapabilities,
  axisMeasurable,
  CLAUDE_CODE_PROFILE,
  type Capability,
} from "./capability.js";

/**
 * 탐색력을 세 구성요소로 나눈 이유.
 *
 * 초판은 파일 찾기와 내용 찾기를 한 지표에 섞었고, 그래서 `find -name` 을 `Glob` 으로
 * 바꿔도 점수가 오르지 않았다(둘 다 분자). 반대로 검색이 아닌 `qmd get` 을 부르면
 * 분모만 늘어 점수가 올랐다. 정직한 경로는 막히고 조작 경로만 열려 있었다.
 *
 * 그리고 "검색한 것들 중 비율"만 보면 아예 안 찾고 고친 경우를 못 잡는다. 실측에서
 * 코드 편집의 19.9%가 그 파일을 읽지 않고 이뤄졌다. 근거 확보율이 그 구멍을 덮는다.
 *
 * 재검색률은 구간 길이와의 잔여 상관(-0.557)이 남아 스탯에서 빼고 진단으로만 남겼다.
 */

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

/**
 * 구성요소의 안정 키.
 *
 * 초판은 한국어 라벨을 그대로 조회 키로 썼다(`COMPONENT_CRITERIA[c.label]`). 표시 문자열이
 * 곧 식별자라 라벨을 한 글자만 고쳐도 기준표 조회와 구간 간 대조가 조용히 끊긴다. 화면
 * 언어를 늘리는 순간 이 결합이 바로 깨지므로 표시와 식별을 분리한다.
 */
export type ComponentKey =
  | "fileFind"
  | "indexedRetrieval"
  | "groundedEdit"
  | "readScope"
  | "readRevisit"
  | "outputBrevity"
  | "contextWeight"
  | "verificationFreshness"
  | "verificationRedundancy"
  | "humanIntervention"
  | "deliveryReach"
  | "rework"
  | "instrumentedChannel"
  | "gateRepeat";

export const COMPONENT_LABELS: Record<ComponentKey, Localized> = {
  fileFind: L("파일 찾기 규율", "File-finding discipline"),
  indexedRetrieval: L("내용 인덱스 우선", "Index-first retrieval"),
  groundedEdit: L("근거 확보율", "Evidence before edit"),
  readScope: L("읽기 범위 규율", "Read-scope discipline"),
  readRevisit: L("읽은 것 기억하기", "Recall of what was read"),
  outputBrevity: L("응답 간결성", "Response brevity"),
  contextWeight: L("컨텍스트 경량성", "Context lightness"),
  verificationFreshness: L("커밋 전 검증 신선도", "Pre-commit check freshness"),
  verificationRedundancy: L("검증 공회전 없음", "No redundant checks"),
  humanIntervention: L("사람 개입 없음", "No human intervention"),
  deliveryReach: L("산출물 도달", "Reached an artifact"),
  rework: L("재작업 없음", "No rework"),
  instrumentedChannel: L("계측 채널 준수", "Instrumented-channel use"),
  gateRepeat: L("게이트 재발 없음", "No repeat gate hits"),
};

export interface StatComponent {
  /** 조회와 구간 간 대조에 쓰는 식별자. 표시에는 쓰지 않는다. */
  key: ComponentKey;
  label: Localized;
  /** 0~1. 높을수록 좋게 맞춘 값. */
  value: number | null;
  denominator: number;
  /**
   * 구간 간 안정성. 이력 구간들에서 이 값이 얼마나 덜 흔들렸는가(1 - 2*표준편차).
   *
   * 게이트의 split-half 와 **다른 것**이다. split-half 는 한 구간 안에서 세션을 갈라
   * 같은 값을 두 번 계산한 상관이고, 이것은 구간들 사이의 변동이다. 초판 주석이 이것을
   * 홀짝 분할이라고 적어 두 지표가 같은 이름으로 섞여 있었다.
   *
   * 화면이 점수만 보여주고 그 점수를 믿을 근거를 안 보여주면, 읽는 사람이 0.03 짜리와
   * 0.53 짜리를 같은 무게로 읽는다. 이력이 얇으면 낼 수 없어 null 이다.
   */
  crossPeriodStability?: number | null;
  /**
   * 점수에 넣지 않고 보여주기만 하는가.
   *
   * 값이 거의 상수인 구성요소를 평균에 넣으면 "잘한다"가 아니라 "거의 항상 그렇다"를
   * 점수로 바꾼다. 그러면 그 스탯이 실제로는 나머지 구성요소만으로 움직이는데 화면은
   * 여러 개를 재는 것처럼 보인다. 값은 계속 내되 평균에서만 뺀다.
   */
  displayOnly?: boolean;
}

export interface StatValue {
  key: StatKey;
  label: Localized;
  question: Localized;
  /** 0~100 */
  score: number | null;
  components: StatComponent[];
  /** 점수를 만든 구성요소 수. 표시 전용과 판정 불가를 뺀 것. */
  scoredCount: number;
  /** 점수 대상이 될 수 있었던 구성요소 수. 표시 전용만 뺀 것. */
  scorableCount: number;
}

export const STAT_ORDER: StatKey[] = [
  "retrieval",
  "verification",
  "delivery",
  "autonomy",
  "discipline",
  "context",
];

export const STAT_LABELS: Record<StatKey, Localized> = {
  retrieval: L("탐색력", "Retrieval"),
  context: L("컨텍스트 효율", "Context efficiency"),
  verification: L("검증력", "Verification"),
  autonomy: L("자율성", "Autonomy"),
  delivery: L("완수력", "Delivery"),
  discipline: L("규율", "Discipline"),
};

export const STAT_QUESTIONS: Record<StatKey, Localized> = {
  retrieval: L(
    "찾아야 할 때 옳은 방법으로 찾나",
    "Does it search the right way when it needs to find something",
  ),
  context: L(
    "필요한 만큼만 읽고 토큰을 아끼나",
    "Does it read only what it needs and spend tokens sparingly",
  ),
  verification: L("주장 전에 확인하나", "Does it check before it claims"),
  autonomy: L(
    "사람 개입 없이 완주하나",
    "Does it finish without human intervention",
  ),
  delivery: L("산출물까지 도달하나", "Does it reach an artifact"),
  discipline: L(
    "정한 규칙과 도구 경로를 지키나",
    "Does it honor the rules and tool paths it was given",
  ),
};

/**
 * 자율성 상한.
 *
 * assistant 턴 100회당 개입 6건을 바닥(0점)으로 본다. 상한이 필요한 이유는 개입 빈도가
 * 비율이 아니라 발생률이라 1로 정규화할 자연스러운 분모가 없기 때문이다.
 * 구간 수준에서는 상한에 닿는 구간이 없고 세션 수준에서 2% 남짓 닿는다. 이 상한은
 * 이상치 절단이 아니라 순수한 스케일 선택이므로, 바꾸면 절대 점수와 Lv 가 함께 움직인다.
 */
const AUTONOMY_CAP_PER_100_TURNS = 6;

/**
 * 완수력의 산출물 도달에 필요한 최소 세션 수.
 *
 * 구간당 분모가 2~11이라 세션 하나가 커밋 없이 끝나면 스탯이 최대 25p 흔들린다.
 * 같은 스탯의 다른 구성요소(재작업)는 편집 호출 단위라 분모가 34배 크다.
 * 분모가 얇으면 값을 내지 않는다. meanOf가 null을 빼므로 재작업 단독으로 계산된다.
 */
const MIN_DELIVERY_SESSIONS = 8;

/** 이력이 이만큼은 쌓여야 백분위·통상범위·최고를 낸다. */
const MIN_HISTORY_WINDOWS = 4;

/**
 * 발생률을 0~1 점수로 옮긴다.
 *
 * 비율 지표와 달리 토큰은 1로 정규화할 자연스러운 분모가 없다. 관측 분포의 양 끝을
 * 기준점으로 잡아 그 사이를 선형으로 편다. 기준점은 코드에 고정하고 근거를 남긴다.
 */
function rateScore(value: number, best: number, worst: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(Math.max(value, best), worst);
  return (worst - clamped) / (worst - best);
}

/**
 * 토큰 기준점.
 *
 * 이 값은 임계가 아니라 **눈금 선택**이다. 관측 분포를 여유 있게 감싸도록 잡았고
 * (읽기·편집 호출당 출력 1,418~4,139 → 1,000~4,500), 코퍼스 성격이 크게 바뀌면
 * 다시 봐야 한다. 앵커를 바꾸면 절대 점수와 병목 순서가 함께 움직인다는 점을 알고 써야 한다.
 *
 * 재사용률(cache_read 비중)은 쓰지 않는다. 전수 0.967에 스프레드 0.038로 포화라
 * 백분위를 내도 잡음만 남는다. 같은 이유로 초기 설계의 cache_read 축도 폐기됐다.
 * 편집당 토큰도 뺐다. 22배로 가장 잘 퍼지지만 코드를 안 고치는 planning 세션이
 * 통째로 불리해져 작업 종류가 점수를 지배한다.
 */
const OUTPUT_PER_TOOL_CALL_BEST = 1000;
const OUTPUT_PER_TOOL_CALL_WORST = 4500;
const CONTEXT_PER_REQUEST_BEST = 100_000;
const CONTEXT_PER_REQUEST_WORST = 400_000;

function ratio(count: AxisCount): number | null {
  return count.den === 0 ? null : count.num / count.den;
}

function inverse(value: number | null): number | null {
  return value === null ? null : 1 - value;
}

/**
 * 구성요소의 평균. 값이 없는 구성요소는 빼고 낸다.
 *
 * 빼는 것 자체는 옳다. 능력이 없거나 분모가 0 인 것을 0 점으로 세면 없는 일을 못했다고
 * 하는 셈이다. 문제는 뺀 사실이 화면에 안 남는 것이었다. 셋 중 둘이 빠지면 남은 하나가
 * 스탯 전체가 되는데 화면은 여전히 세 개를 재는 것처럼 보인다.
 *
 * 실제로 아무것도 안 고치고 인덱스 검색만 반복한 세션이 탐색력 100 을 받는다. 파일 찾기와
 * 근거 확보는 분모가 0 이라 빠지고 인덱스 하나만 남기 때문이다. 그래서 몇 개로 냈는지를
 * 함께 돌려준다.
 */
function meanOf(components: StatComponent[]): {
  mean: number | null;
  scored: number;
  total: number;
} {
  const eligible = components.filter((c) => c.displayOnly !== true);
  const values = eligible
    .map((c) => c.value)
    .filter((v): v is number => v !== null);
  return {
    mean:
      values.length === 0
        ? null
        : values.reduce((a, b) => a + b, 0) / values.length,
    scored: values.length,
    total: eligible.length,
  };
}

function component(
  key: ComponentKey,
  value: number | null,
  denominator: number,
  displayOnly = false,
): StatComponent {
  return {
    key,
    label: COMPONENT_LABELS[key],
    value,
    denominator,
    ...(displayOnly ? { displayOnly: true } : {}),
  };
}

export function computeStats(
  period: Period,
  available: ReadonlySet<Capability> = availableCapabilities(
    CLAUDE_CODE_PROFILE,
  ),
): StatValue[] {
  const a = period.axes;
  const e = period.extras;

  /**
   * 능력이 없는 하네스에서는 그 축을 0 이 아니라 판정 불가로 낸다.
   *
   * 분모가 0 이 아니어도 마찬가지다. 인덱스 도구가 없어도 grep 이 분모를 채우므로
   * 분모만 보면 "없다"를 못 읽고 "있는데 안 썼다"로 잘못 읽는다.
   */
  const scoreIfMeasurable = (
    axis: Parameters<typeof axisScore>[0],
    count: AxisCount,
  ): number | null =>
    axisMeasurable(axis, available) ? axisScore(axis, count) : null;

  const byKey: Record<StatKey, StatComponent[]> = {
    retrieval: [
      component("fileFind", ratio(e.fileFind), e.fileFind.den),
      component(
        "indexedRetrieval",
        scoreIfMeasurable("indexedRetrieval", a.indexedRetrieval),
        a.indexedRetrieval.den,
      ),
      component("groundedEdit", ratio(e.groundedEdit), e.groundedEdit.den),
    ],
    context: [
      component(
        "readScope",
        scoreIfMeasurable("readScope", a.readScope),
        a.readScope.den,
      ),
      component(
        "readRevisit",
        scoreIfMeasurable("readRevisit", a.readRevisit),
        a.readRevisit.den,
      ),
      component(
        "outputBrevity",
        outputPerReadWriteCall(period),
        a.instrumentedChannel.den + a.readRevisit.den,
      ),
      component(
        "contextWeight",
        contextPerRequest(period),
        period.usage.requests,
      ),
    ],
    verification: [
      component(
        "verificationFreshness",
        scoreIfMeasurable("verificationFreshness", a.verificationFreshness),
        a.verificationFreshness.den,
      ),
      component(
        "verificationRedundancy",
        scoreIfMeasurable("verificationRedundancy", a.verificationRedundancy),
        a.verificationRedundancy.den,
      ),
    ],
    autonomy: [
      component("humanIntervention", autonomyScore(period), e.assistantTurns),
    ],
    delivery: [
      // 산출물 도달은 보여주기만 하고 점수에 넣지 않는다.
      //
      // 실측 94%(162/173) 라 등수를 못 매긴다. PR 결과를 외부 준거로 쓰려다 머지율 89% 를
      // "변별력 없음"으로 기각했는데, 같은 이유가 이 구성요소에 그대로 해당한다.
      //
      // 그리고 커밋의 존재는 하네스 속성이 아니라 그날 한 일의 성격이다. 기획·조사·리뷰
      // 세션은 커밋 없이 끝나는 것이 정상인데 그것이 깎인다. 빈 커밋 하나로 오르기도 한다.
      //
      // 값은 계속 낸다. 코드를 고치고 아무 데도 안 닿은 11건은 볼 값어치가 있다.
      component(
        "deliveryReach",
        period.delivery.den < MIN_DELIVERY_SESSIONS
          ? null
          : ratio(period.delivery),
        period.delivery.den,
        true,
      ),
      component("rework", inverse(ratio(e.rework)), e.rework.den),
    ],
    discipline: [
      component(
        "instrumentedChannel",
        scoreIfMeasurable("instrumentedChannel", a.instrumentedChannel),
        a.instrumentedChannel.den,
      ),
      component("gateRepeat", inverse(ratio(e.gateRepeat)), e.gateRepeat.den),
    ],
  };

  return STAT_ORDER.map((key) => {
    const components = byKey[key];
    const { mean, scored, total } = meanOf(components);
    return {
      key,
      label: STAT_LABELS[key],
      question: STAT_QUESTIONS[key],
      score: mean === null ? null : mean * 100,
      scoredCount: scored,
      scorableCount: total,
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

/**
 * 읽기·편집 호출 한 번을 내기 위해 얼마나 길게 생성했는가. 짧을수록 좋다.
 *
 * 분모가 전체 도구 호출이 아니라 Read·Edit·Write 계열뿐이다(전체의 38% 수준).
 * Bash·검색·MCP 를 넣으려면 앵커를 다시 적합해야 하므로 지금은 이름과 설명을
 * 분모에 맞춰 두고, 화면에도 그대로 적는다.
 */
function outputPerReadWriteCall(period: Period): number | null {
  const calls =
    period.axes.instrumentedChannel.den + period.axes.readRevisit.den;
  if (calls === 0 || period.usage.output === 0) return null;
  return rateScore(
    period.usage.output / calls,
    OUTPUT_PER_TOOL_CALL_BEST,
    OUTPUT_PER_TOOL_CALL_WORST,
  );
}

/** 요청마다 얼마나 무거운 맥락을 들고 다니는가. 가벼울수록 좋다. */
function contextPerRequest(period: Period): number | null {
  if (period.usage.requests === 0) return null;
  return rateScore(
    period.usage.cacheRead / period.usage.requests,
    CONTEXT_PER_REQUEST_BEST,
    CONTEXT_PER_REQUEST_WORST,
  );
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

/**
 * 절대 컷. 도출 근거가 없는 숫자다.
 *
 * 라벨이 0건이라 "몇 점부터 좋은가"를 정할 외부 기준이 없는데도 네 개의 컷이 코드에
 * 박혀 있다. 그리고 이 컷은 실제로 헤드라인을 정한다. 전수 종합 78.56 이 A 컷 78 보다
 * 0.56 높아서 A 인데, 컷을 79 로 옮기면 B 가 된다. 그래서 등급 옆에 가장 가까운 컷과의
 * 거리를 함께 낸다. 읽는 사람이 그 등급이 아슬아슬한지 여유 있는지 보게 하려는 것이고,
 * 이건 임계를 새로 만들지 않고도 할 수 있다.
 */
const ABSOLUTE_CUTS: ReadonlyArray<readonly [number, Rank]> = [
  [90, "S"],
  [78, "A"],
  [62, "B"],
  [45, "C"],
];

function rankFromScore(score: number | null): Rank {
  if (score === null) return "-";
  for (const [cut, rank] of ABSOLUTE_CUTS) if (score >= cut) return rank;
  return "D";
}

/** 등급을 바꾸는 가장 가까운 컷까지의 거리. 없으면 null. */
export function marginToCut(score: number | null): number | null {
  if (score === null) return null;
  let nearest: number | null = null;
  for (const [cut] of ABSOLUTE_CUTS) {
    const distance = Math.abs(score - cut);
    if (nearest === null || distance < nearest) nearest = distance;
  }
  return nearest;
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
  // 현재 창을 자기 이력 분포에서 뺀다. 넣으면 percentileOf 의 엄격 비교 때문에
  // 자기 자신이 분모만 늘려 백분위가 단방향으로 부풀고, best 도 자기 자신이 되어
  // 신기록 구간의 성장 여지가 0으로 사라진다.
  const closed = history.filter((p) => !p.open && p.index !== current.index);
  const currentStats = computeStats(current);
  const historyStats = closed.map((p) => computeStats(p));
  const hasHistory = closed.length >= MIN_HISTORY_WINDOWS;

  // 구성요소마다 이력 구간에서의 값이 얼마나 흔들리는지. 점수 옆에 붙일 신뢰 근거다.
  const crossPeriodStabilityOf = (key: ComponentKey): number | null => {
    if (!hasHistory) return null;
    const series = historyStats
      .flatMap((set) => set.flatMap((s) => s.components))
      .filter((c) => c.key === key && c.value !== null)
      .map((c) => c.value as number);
    if (series.length < MIN_HISTORY_WINDOWS) return null;
    // 구간 간 변동이 작을수록 그 구성요소의 값을 믿을 수 있다. 표준편차를 1에서 빼
    // 0~1 로 맞춘다. 임계를 걸지 않고 값만 낸다.
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const variance =
      series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
    return Math.max(0, 1 - Math.sqrt(variance) * 2);
  };

  const stats: StatEntry[] = currentStats.map((stat, index) => {
    const series = !hasHistory
      ? []
      : historyStats
          .map((s) => s[index]?.score)
          .filter((v): v is number => v !== undefined && v !== null)
          .sort((x, y) => x - y);
    const percentile =
      stat.score === null ? null : percentileOf(series, stat.score);
    return {
      ...stat,
      components: stat.components.map((c) => ({
        ...c,
        crossPeriodStability: crossPeriodStabilityOf(c.key),
      })),
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

  // `guarded` 구성요소만으로 된 스탯은 종합에서 뺀다.
  //
  // 양극단이 모두 나쁜 값을 "높을수록 좋음"들과 평균 내면 그 평균이 무엇을 뜻하는지
  // 말할 수 없다. 그리고 종합이 스탯 평균의 평균이라 구성요소가 하나뿐인 스탯의 그
  // 구성요소가 종합의 16.7%를 갖는다. 지금 자율성이 정확히 그 자리다. 구성요소가
  // 하나이고 그것이 guarded 라서, 가장 해석하기 어려운 신호에 가장 큰 가중이 붙어 있다.
  // 값은 계속 보여주되 종합에서만 뺀다.
  const countsTowardOverall = (s: StatEntry): boolean =>
    s.score !== null &&
    s.components.some((c) => {
      const criterion = COMPONENT_CRITERIA[c.key];
      return c.value !== null && criterion?.objective !== "guarded";
    });
  const scored = stats
    .filter(countsTowardOverall)
    .map((s) => s.score)
    .filter((v): v is number => v !== null);
  const overall =
    scored.length === 0
      ? null
      : scored.reduce((a, b) => a + b, 0) / scored.length;

  const coverage = coverageRatio(current.coverage);

  // 종합도 개별 스탯과 같은 기준을 써야 한다. 종합만 절대 임계면 각주가 거짓이 되고,
  // 종합 범위가 74~84로 눌려 있어 A와 B 두 값밖에 안 나온다.
  const overallHistory = historyStats
    .map((set) => {
      const scored = set
        .map((x) => x.score)
        .filter((v): v is number => v !== null);
      return scored.length === 0
        ? null
        : scored.reduce((a, b) => a + b, 0) / scored.length;
    })
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const overallRank =
    options.rankByAbsoluteScore === true
      ? rankFromScore(overall)
      : !hasHistory || overall === null
        ? "-"
        : rankFromPercentile(percentileOf(overallHistory, overall));

  return {
    periodIndex: current.index,
    startedAt: current.startedAt,
    endedAt: current.endedAt,
    sessionCount: current.sessionIds.length,
    coverage,
    judgeable: coverage === null || coverage >= COVERAGE_FLOOR,
    stats,
    overall,
    overallRank,
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
export interface TrendRow {
  label: Localized;
  /** 구성요소면 소속 능력치 이름, 능력치 자신이면 null. */
  parent: Localized | null;
  /** 0~100 */
  early: number | null;
  late: number | null;
  /** late - early. 둘 중 하나라도 없으면 null. */
  delta: number | null;
  /** 최근 절반의 분모. 얇으면 차이를 믿지 않는다. */
  denominator: number;
}

/**
 * 같은 정의로 초기 절반과 최근 절반을 비교한다.
 *
 * 정의를 고치면 점수가 움직이는데 그건 측정이 바뀐 것이지 행동이 바뀐 게 아니다.
 * 시기를 갈라 같은 정의로 재면 정의가 상수로 고정되므로 남는 차이가 행동 차이다.
 *
 * 구간 간 예측력이 0 이라 이웃 구간 비교는 잡음이지만, 14구간씩 합친 두 덩어리
 * 비교는 다른 질문이다. 그래도 분모가 얇은 구성요소의 차이는 믿지 않는다.
 */
export function compareHalves(periods: Period[]): TrendRow[] {
  const closed = periods.filter((p) => !p.open);
  const half = Math.floor(closed.length / 2);
  if (half < 2) return [];
  const early = mergePeriods(closed.slice(0, half));
  const late = mergePeriods(closed.slice(half));
  if (early === null || late === null) return [];

  const byStatKey = (period: Period): Map<StatKey, StatValue> => {
    const out = new Map<StatKey, StatValue>();
    for (const s of computeStats(period)) out.set(s.key, s);
    return out;
  };
  const A = byStatKey(early);
  const B = byStatKey(late);

  const rows: TrendRow[] = [];
  for (const [statKey, a] of A) {
    const b = B.get(statKey);
    if (b === undefined) continue;
    rows.push({
      label: a.label,
      parent: null,
      early: a.score,
      late: b.score,
      delta: a.score === null || b.score === null ? null : b.score - a.score,
      denominator: b.components.reduce((n, c) => n + c.denominator, 0),
    });
    for (const c of a.components) {
      const d = b.components.find((x) => x.key === c.key);
      if (d === undefined) continue;
      const from = c.value === null ? null : c.value * 100;
      const to = d.value === null ? null : d.value * 100;
      rows.push({
        label: c.label,
        parent: a.label,
        early: from,
        late: to,
        delta: from === null || to === null ? null : to - from,
        denominator: d.denominator,
      });
    }
  }
  return rows;
}

export function mergePeriods(periods: Period[]): Period | null {
  const closed = periods.filter((p) => !p.open);
  const first = closed[0];
  const last = closed.at(-1);
  if (first === undefined || last === undefined) return null;

  const axes = emptyAxes();
  const extras = emptyExtras();
  const events = emptyEvents();
  const usage = emptyUsage();
  const delivery = { num: 0, den: 0 };
  const coverage: CoverageCount = { observable: 0, offChannel: 0, opaque: 0 };
  const sessionIds: string[] = [];

  for (const p of closed) {
    addCounts(axes, p.axes);
    addExtras(extras, p.extras);
    events.interrupt += p.events.interrupt;
    events.queueMidflight += p.events.queueMidflight;
    events.userRejected += p.events.userRejected;
    usage.input += p.usage.input;
    usage.output += p.usage.output;
    usage.cacheRead += p.usage.cacheRead;
    usage.cacheCreation += p.usage.cacheCreation;
    usage.requests += p.usage.requests;
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
    usage,
    delivery,
    coverage,
    closedByBudget: true,
    unfilledAxes: [],
    open: false,
  };
}
