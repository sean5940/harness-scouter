import { AXIS_ORDER, type AxisKey } from "./definitions.js";
import {
  MIN_SESSIONS_FOR_SPLIT_HALF,
  permutedSplitHalf,
  SPLIT_HALF_PASS,
  type GateVerdict,
  type SplitHalfDistribution,
  type Strata,
} from "./gate.js";
import type { SessionMetrics } from "./metrics.js";
import { segmentIntoPeriods, type SessionForPeriod } from "./periods.js";
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
  /** 이 임계에서 각 층에 세션이 몇 개 들어갔는가. */
  sizes: Record<WorkType, number>;
  /** 세션이 하나라도 들어간 층의 수. 1이면 층화가 아무것도 안 가른 것이다. */
  occupiedStrata: number;
  axes: AxisStratificationEffect[];
}

export interface StratificationExperiment {
  /** split-half 가 쓸 수 있었던 구간 수. 3 미만이면 아무 축도 못 낸다. */
  usablePeriods: number;
  sessionCount: number;
  /** 첫 항목이 기본 임계다. 나머지는 민감도 확인용이다. */
  variants: StratificationVariant[];
}

function verdictOf(d: SplitHalfDistribution | null): GateVerdict {
  if (d === null) return "not-computable";
  return d.median >= SPLIT_HALF_PASS ? "pass" : "fail";
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

  const built = variants.map((thresholds) => {
    const strata: Strata = new Map(
      [...workload].map(([sessionId, counts]) => [
        sessionId,
        classifyWorkType(counts, thresholds),
      ]),
    );
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
      occupiedStrata: Object.values(sizes).filter((n) => n > 0).length,
      axes,
    };
  });

  return {
    usablePeriods,
    sessionCount: sessions.length,
    variants: built,
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
