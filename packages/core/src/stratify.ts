import { AXIS_ORDER, type AxisKey } from "./definitions.js";
import {
  MIN_SESSIONS_FOR_SPLIT_HALF,
  permutedSplitHalf,
  seededRandom,
  SPLIT_HALF_PASS,
  UNKNOWN_STRATUM,
  type GateVerdict,
  type SplitHalfDistribution,
  type Strata,
} from "./gate.js";
import type { SessionMetrics } from "./metrics.js";
import {
  segmentIntoPeriods,
  type Period,
  type SessionForPeriod,
} from "./periods.js";
import {
  classifyWorkType,
  stratumSizes,
  WORK_TYPE_VARIANTS,
  type WorkloadCounts,
  type WorkType,
  type WorkTypeThresholds,
} from "./worktype.js";

/**
 * 층화 실험 (한계 2번).
 *
 * 게이트는 "구간 안에서 점수가 재현되지 않는다"까지만 말한다. 왜 안 되는지는 안 말한다.
 * 후보가 둘이다. 축이 원래 불안정하거나, 반으로 가를 때 두 묶음의 작업 구성이 달라지거나.
 *
 * 두 후보는 한 번의 대조로 갈린다. **같은 순열 split-half 를 층 안에서만 돌린다.**
 * 층화하면 두 반쪽의 작업 구성이 같아지므로, 상관이 올라가면 원인은 구성이었고
 * 그대로면 축 자체다. 전자면 고정 태스크 셋(프로브)에 쓸 돈의 근거가 생기고,
 * 후자면 프로브를 만들어도 이 축은 안 살아난다.
 *
 * 실험이지 게이트가 아니다. 여기 결과로 게이트 판정을 바꾸지 않는다. 분류기 자체가
 * 아직 검증되지 않은 임의 임계 위에 서 있어서, 그것으로 통과선을 옮기면 통과할 이유를
 * 찾아 기준을 고친 것이 된다.
 */

export interface AxisStratificationEffect {
  axis: AxisKey;
  /** 층화하지 않은 분포. `scouter gate` 가 찍는 것과 같은 값이다. */
  plain: SplitHalfDistribution | null;
  stratified: SplitHalfDistribution | null;
  /** 중앙값의 이동. 둘 중 하나라도 못 내면 null. */
  delta: number | null;
  verdictBefore: GateVerdict;
  verdictAfter: GateVerdict;
}

export interface StratificationVariant {
  thresholds: WorkTypeThresholds;
  /** 이 임계에서 각 층에 세션이 몇 개 들어갔는가. 작업 유형 다섯만 센다. */
  sizes: Record<WorkType, number>;
  /**
   * 세션이 하나라도 들어간 층의 수. 1이면 층화가 아무것도 안 가른 것이다.
   *
   * 유형을 모르는 세션들도 `bisect` 안에서 자기들끼리 한 층을 이루므로 여기 함께
   * 센다. 작업 유형만 세면, 유형이 하나뿐이고 모르는 세션이 잔뜩인 코퍼스에서
   * "층화가 가르는 것이 없다"고 적으면서 실제로는 아는 것과 모르는 것으로 가르게 된다.
   */
  occupiedStrata: number;
  axes: AxisStratificationEffect[];
}

/**
 * 뜻 없는 라벨로 잰 이동. 실제 층화의 이동과 나란히 읽는다.
 *
 * 이 값 하나만 보면 아무 뜻이 없다. 실제 이동이 이것을 넘느냐가 전부다.
 */
export interface AxisPlaceboEffect {
  axis: AxisKey;
  /** 가운데 뽑기의 분포. 실제로 나온 뽑기 하나라 두 수가 같은 세계에서 온 것이다. */
  placebo: SplitHalfDistribution | null;
  /** 가운데 뽑기의 이동. */
  delta: number | null;
  /**
   * 뽑기 전체에서 이동의 최소·최대. 이것이 잡음 바닥의 폭이다.
   *
   * 실제 층화가 바닥을 넘었는지 셀 때는 가운데가 아니라 `max` 와 견준다. 가운데와
   * 견주면 뽑기 하나가 낮게 나온 덕에 넘은 것이 되는 축이 생긴다.
   */
  deltaRange: { min: number; max: number } | null;
}

export interface StratificationExperiment {
  /** split-half 가 쓸 수 있었던 구간 수. 3 미만이면 아무 축도 못 낸다. */
  usablePeriods: number;
  sessionCount: number;
  /**
   * 작업 유형을 못 매긴 세션 수.
   *
   * 층표에 없는 세션은 버리지 않고 `(unknown)` 층으로 함께 간다. 버리면 층화 전과
   * 층화 후가 서로 다른 모집단을 재게 된다. 다만 그 세션들도 하나의 층을 이루므로,
   * 수가 크면 "작업 유형으로 갈랐다"가 아니라 "유형을 아는 세션과 모르는 세션으로
   * 갈랐다"에 가까워진다. 화면에 적어 읽는 사람이 알게 한다.
   */
  unknownSessions: number;
  /** 첫 항목이 기본 임계다. 나머지는 민감도 확인용이다. */
  variants: StratificationVariant[];
  /**
   * 이동의 잡음 바닥. 기본 임계의 층 크기는 그대로 두고 **누가 어느 층이냐만** 흩는다.
   *
   * `delta` 만 보면 "얼마나 움직여야 움직인 것인가"에 답할 수 없다. 층화는 두 반쪽의
   * 작업 구성을 맞추는 동시에 분할 자체를 제약하는데, 그 제약과 순열 400 회의 흔들림이
   * 라벨과 무관하게 얼마짜리 이동을 만드는지가 어디에도 안 적혀 있다.
   *
   * 위약이 그 값이다. 층 크기 구성을 그대로 두므로 분할이 받는 제약은 실제 층화와 같고,
   * 달라지는 것은 라벨이 뜻을 잃었다는 것뿐이다. **아무 뜻 없는 라벨로 잰 이동**이 곧
   * 잡음 바닥이고, 실제 이동이 그 바닥을 못 넘으면 증거가 아니다.
   *
   * 실측에서 위약 이동은 -0.0012, 폭은 [-0.0089, +0.0085] 로 0 근처에 앉는다. 크기
   * 제약 자체는 상관을 안 올린다는 뜻인데, 그것을 가정하지 않고 재서 보인다는 것이
   * 이 대조의 두 번째 쓸모다. 같은 코퍼스에서 실제 이동이 +0.0119 였다 — 바닥을
   * 겨우 넘는다. 위약이 없으면 그 값을 "올랐다"로 읽게 된다.
   */
  placebo: AxisPlaceboEffect[];
}

function verdictOf(d: SplitHalfDistribution | null): GateVerdict {
  if (d === null) return "not-computable";
  return d.median >= SPLIT_HALF_PASS ? "pass" : "fail";
}

function strataOf(
  workload: ReadonlyMap<string, WorkloadCounts>,
  thresholds: WorkTypeThresholds,
): Strata {
  return new Map(
    [...workload].map(([sessionId, counts]) => [
      sessionId,
      classifyWorkType(counts, thresholds),
    ]),
  );
}

/**
 * 위약 층 시드. 임의값이지만 고정한다. 흔들면 위약이 실행마다 달라진다.
 *
 * 축 시드(1..6)와 겹치지 않게 멀리 잡는다. 겹쳐도 라벨 섞기와 분할 섞기는 서로 다른
 * 난수기라 문제는 없지만, 두 시드가 같은 수로 보이면 읽는 사람이 연결을 의심한다.
 */
const PLACEBO_SEED = 9973;

/**
 * 뽑기 사이 시드 간격.
 *
 * 시드를 1씩 올리면 안 된다. `seededRandom` 은 선형 합동 난수라 이웃 시드가 첫 몇
 * 개의 출력에서 거의 같은 값을 낸다. 9973·9974·9975 로 재보면 첫 난수 세 개가
 * 0.101128 · 0.101516 · 0.101903 으로 격차가 0.000775 다. 그러면 세 뽑기가 앞쪽
 * 구간에서 사실상 같은 섞기를 해, 뽑기를 늘린 값이 없다.
 *
 * 큰 소수만큼 띄우면 같은 자리 격차가 0.588 로 벌어진다.
 */
const PLACEBO_SEED_STRIDE = 104729;

/**
 * 위약 뽑기 횟수.
 *
 * 라벨 배정 한 번은 표본 하나다. 운 좋은 배정 하나로 "위약은 안 올랐다"를 적으면
 * 대조가 대조 구실을 못 한다. 순열 400 회는 배정을 고정한 채 도는 것이라 이 흔들림을
 * 대신 잡아주지 않는다.
 */
const PLACEBO_DRAWS = 3;

/**
 * 뽑기마다 쓸 시드.
 *
 * 상수 둘을 그대로 두지 않고 함수로 빼는 이유는 간격이 다시 1로 좁아지는 것을 테스트가
 * 잡게 하려는 것이다. 좁아져도 코드는 돌아가고 값도 그럴듯하게 나오므로, 눈으로는
 * 못 잡는다.
 */
export function placeboSeeds(count: number = PLACEBO_DRAWS): number[] {
  return Array.from(
    { length: count },
    (_, i) => PLACEBO_SEED + i * PLACEBO_SEED_STRIDE,
  );
}

/**
 * 층 크기는 그대로 두고 누가 어느 층이냐만 흩는다.
 *
 * 구간 안에서 라벨 벡터를 섞는다. 구간마다 층 크기 구성이 그대로 남으므로 `bisect` 가
 * 받는 분할 제약이 실제 층화와 같고, 달라지는 것은 라벨이 뜻을 잃었다는 것뿐이다.
 * 전역으로 섞으면 구간별 층 크기가 달라져 제약까지 같이 바뀌어, 무엇을 대조하는지
 * 흐려진다.
 */
export function placeboStrata(
  periods: Period[],
  real: Strata,
  seed: number,
): Strata {
  const rand = seededRandom(seed);
  const out = new Map<string, string>();
  for (const period of periods) {
    const labels = period.sessionIds.map(
      (sid) => real.get(sid) ?? UNKNOWN_STRATUM,
    );
    for (let i = labels.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = labels[i] as string;
      labels[i] = labels[j] as string;
      labels[j] = tmp;
    }
    period.sessionIds.forEach((sid, i) => out.set(sid, labels[i] as string));
  }
  return out;
}

/**
 * 뽑기 여럿 중 가운데 것을 고른다.
 *
 * 평균을 내지 않는 이유는 `SplitHalfDistribution` 이 중앙값과 검출하한을 함께 들고
 * 있어서다. 두 값을 따로 평균하면 어느 뽑기에도 없던 조합이 나온다. 실제로 나온
 * 분포 하나를 고르면 표에 적히는 두 수가 같은 세계에서 온 것이 된다.
 */
function medianDraw(
  draws: Array<SplitHalfDistribution | null>,
): SplitHalfDistribution | null {
  const real = draws.filter((d): d is SplitHalfDistribution => d !== null);
  if (real.length === 0) return null;
  const sorted = [...real].sort((a, b) => a.median - b.median);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/**
 * 층화 전후를 같은 시드로 잰다.
 *
 * 시드를 게이트와 맞춘다(`AXIS_ORDER.indexOf(axis) + 1`). 다른 시드를 쓰면 층화 전
 * 값이 `scouter gate` 가 찍은 값과 미세하게 달라지고, 그러면 이 표를 게이트와
 * 나란히 못 읽는다. 두 화면이 같은 수를 다르게 적는 것이 이 저장소에서 반복해 나온
 * 결함이다.
 */
export function runStratificationExperiment(
  sessions: SessionMetrics[],
  forPeriods: SessionForPeriod[],
  workload: ReadonlyMap<string, WorkloadCounts>,
  variants: readonly WorkTypeThresholds[] = WORK_TYPE_VARIANTS,
): StratificationExperiment {
  const periods = segmentIntoPeriods(forPeriods).filter((p) => !p.open);
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]));

  // 층화하지 않은 쪽은 임계와 무관하므로 변형마다 다시 돌리지 않는다. 400 순열 ×
  // 6축 × 변형 5개를 헛돌리는 것이기도 하지만, 더 중요한 것은 같은 대조군이 표마다
  // 다른 값으로 적히면 안 된다는 것이다.
  const plainByAxis = new Map<AxisKey, SplitHalfDistribution | null>(
    AXIS_ORDER.map((axis) => [
      axis,
      permutedSplitHalf(periods, bySession, axis, AXIS_ORDER.indexOf(axis) + 1),
    ]),
  );

  const usablePeriods = periods.filter(
    (p) => p.sessionIds.length >= MIN_SESSIONS_FOR_SPLIT_HALF,
  ).length;

  // 임계와 무관하다. 집계가 없는 세션은 어느 임계에서도 유형을 못 매긴다.
  const unknownSessions = sessions.filter(
    (s) => !workload.has(s.sessionId),
  ).length;

  const built = variants.map((thresholds) => {
    const strata = strataOf(workload, thresholds);
    const types = sessions
      .map((s) => strata.get(s.sessionId))
      .filter((t): t is WorkType => t !== undefined);
    const sizes = stratumSizes(types);

    const axes = AXIS_ORDER.map((axis) => {
      const plain = plainByAxis.get(axis) ?? null;
      const stratified = permutedSplitHalf(
        periods,
        bySession,
        axis,
        AXIS_ORDER.indexOf(axis) + 1,
        strata,
      );
      return {
        axis,
        plain,
        stratified,
        delta:
          plain === null || stratified === null
            ? null
            : stratified.median - plain.median,
        verdictBefore: verdictOf(plain),
        verdictAfter: verdictOf(stratified),
      };
    });

    return {
      thresholds,
      sizes,
      occupiedStrata:
        Object.values(sizes).filter((n) => n > 0).length +
        (unknownSessions > 0 ? 1 : 0),
      axes,
    };
  });

  // 위약은 기본 임계에서만 돌린다. 변형마다 돌리면 순열 횟수가 두 배가 되는데,
  // 위약이 답하는 질문("층 이름표가 뜻을 잃어도 오르는가")은 임계에 걸려 있지 않다.
  // 임계 의존성은 sensitivityOf 가 따로 본다.
  const baseThresholds = variants[0];
  const placebo =
    baseThresholds === undefined
      ? []
      : (() => {
          const real = strataOf(workload, baseThresholds);
          const drawn = placeboSeeds().map((seed) =>
            placeboStrata(periods, real, seed),
          );
          return AXIS_ORDER.map((axis) => {
            const plain = plainByAxis.get(axis) ?? null;
            const runs = drawn.map((strata) =>
              permutedSplitHalf(
                periods,
                bySession,
                axis,
                AXIS_ORDER.indexOf(axis) + 1,
                strata,
              ),
            );
            const chosen = medianDraw(runs);
            const deltas =
              plain === null
                ? []
                : runs
                    .filter((d): d is SplitHalfDistribution => d !== null)
                    .map((d) => d.median - plain.median);
            return {
              axis,
              placebo: chosen,
              delta:
                plain === null || chosen === null
                  ? null
                  : chosen.median - plain.median,
              deltaRange:
                deltas.length === 0
                  ? null
                  : { min: Math.min(...deltas), max: Math.max(...deltas) },
            };
          });
        })();

  return {
    usablePeriods,
    sessionCount: sessions.length,
    unknownSessions,
    variants: built,
    placebo,
  };
}

/**
 * 결론이 임계에 걸려 있는가.
 *
 * 변형마다 delta 의 부호가 갈리면 층화가 무엇을 했는지 말할 수 없다. 변형 전부에서
 * 같은 방향이어야 "층화가 올렸다·안 올렸다"를 적을 수 있다. `EPISODE_GAP` 에서 쓴
 * 것과 같은 기준이다.
 */
export interface AxisSensitivity {
  axis: AxisKey;
  /** 변형 전체에서의 delta 범위. */
  min: number | null;
  max: number | null;
  /** 변형 전부가 같은 부호인가. 하나라도 못 내면 false. */
  signStable: boolean;
  /** 층화로 판정이 뒤집힌 변형 수. */
  flipped: number;
}

export function sensitivityOf(
  experiment: StratificationExperiment,
): AxisSensitivity[] {
  return AXIS_ORDER.map((axis) => {
    const rows = experiment.variants
      .map((v) => v.axes.find((a) => a.axis === axis))
      .filter((a): a is AxisStratificationEffect => a !== undefined);
    const deltas = rows
      .map((r) => r.delta)
      .filter((d): d is number => d !== null);
    const flipped = rows.filter(
      (r) => r.verdictBefore !== r.verdictAfter,
    ).length;
    if (deltas.length !== rows.length || deltas.length === 0) {
      return { axis, min: null, max: null, signStable: false, flipped };
    }
    const min = Math.min(...deltas);
    const max = Math.max(...deltas);
    return {
      axis,
      min,
      max,
      // 0 을 사이에 두면 부호가 갈린 것이다. 정확히 0 인 delta 는 어느 쪽도 아니라
      // 안정으로 세지 않는다.
      signStable: (min > 0 && max > 0) || (min < 0 && max < 0),
      flipped,
    };
  });
}
