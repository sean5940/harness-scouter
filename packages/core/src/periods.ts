import {
  AXIS_ORDER,
  DELTA_BASELINE_PERIODS,
  PERIOD_BUDGET,
  PERIOD_SESSION_CAP,
  type AxisKey,
} from "./definitions.js";
import {
  addCounts,
  addExtras,
  axisScore,
  coverageRatio,
  emptyAxes,
  emptyExtras,
  type AxisCounts,
  type CoverageCount,
  type ExtraCounts,
  type SessionMetrics,
} from "./metrics.js";

/** 세션 단위 개입 이벤트 건수. 자율성 합성이 쓴다. */
export interface SessionEvents {
  interrupt: number;
  queueMidflight: number;
  userRejected: number;
}

export function emptyEvents(): SessionEvents {
  return { interrupt: 0, queueMidflight: 0, userRejected: 0 };
}

export interface Period {
  index: number;
  sessionIds: string[];
  startedAt: string;
  endedAt: string;
  axes: AxisCounts;
  extras: ExtraCounts;
  events: SessionEvents;
  /** 코드를 고친 세션 중 커밋이나 PR까지 간 비율. 완수력이 쓴다. */
  delivery: { num: number; den: number };
  coverage: CoverageCount;
  /** 예산을 채워 닫혔는지. false면 세션 상한에 걸려 강제로 닫힌 구간이다. */
  closedByBudget: boolean;
  /** 예산 미달인 축. 이 축은 회색으로 그린다. */
  unfilledAxes: AxisKey[];
  /** 아직 닫히지 않은 진행 중 구간. 비교 대상으로 쓰지 않는다. */
  open: boolean;
}

export interface SessionForPeriod {
  metrics: SessionMetrics;
  startedAt: string;
  endedAt: string | null;
  events: SessionEvents;
  /** 이 세션이 커밋이나 PR을 남겼는지 */
  reachedArtifact: boolean;
}

function unfilled(axes: AxisCounts): AxisKey[] {
  return AXIS_ORDER.filter((key) => axes[key].den < PERIOD_BUDGET[key]);
}

/**
 * 세션을 시간순으로 쌓다가 6축 전부가 최소 분모를 채우는 지점에서 끊는다 (설계 3.4).
 *
 * 시간으로 묶지 않는 이유는 코퍼스가 5주치뿐이라 주 단위로는 6구간밖에 안 나오기
 * 때문이다. 축마다 다른 범위를 보게 하는 방식도 쓰지 않는다. 육각형 한 장에
 * 시점이 섞이면 판독이 안 된다.
 */
export function segmentIntoPeriods(sessions: SessionForPeriod[]): Period[] {
  const ordered = [...sessions].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const periods: Period[] = [];

  let axes = emptyAxes();
  let extras = emptyExtras();
  let events = emptyEvents();
  let delivery = { num: 0, den: 0 };
  let coverage: CoverageCount = { observable: 0, offChannel: 0, opaque: 0 };
  let members: SessionForPeriod[] = [];

  const flush = (closedByBudget: boolean, open: boolean): void => {
    const first = members[0];
    const last = members[members.length - 1];
    if (first === undefined || last === undefined) return;
    periods.push({
      index: periods.length,
      sessionIds: members.map((m) => m.metrics.sessionId),
      startedAt: first.startedAt,
      endedAt: last.endedAt ?? last.startedAt,
      axes,
      extras,
      events,
      delivery,
      coverage,
      closedByBudget,
      unfilledAxes: unfilled(axes),
      open,
    });
    axes = emptyAxes();
    extras = emptyExtras();
    events = emptyEvents();
    delivery = { num: 0, den: 0 };
    coverage = { observable: 0, offChannel: 0, opaque: 0 };
    members = [];
  };

  for (const session of ordered) {
    addCounts(axes, session.metrics.axes);
    addExtras(extras, session.metrics.extras);
    events.interrupt += session.events.interrupt;
    events.queueMidflight += session.events.queueMidflight;
    events.userRejected += session.events.userRejected;
    if (session.metrics.extras.codeEdits > 0) {
      delivery.den += 1;
      if (session.reachedArtifact) delivery.num += 1;
    }
    coverage.observable += session.metrics.coverage.observable;
    coverage.offChannel += session.metrics.coverage.offChannel;
    coverage.opaque += session.metrics.coverage.opaque;
    members.push(session);

    const budgetMet = unfilled(axes).length === 0;
    if (budgetMet) flush(true, false);
    else if (members.length >= PERIOD_SESSION_CAP) flush(false, false);
  }

  if (members.length > 0) flush(false, true);

  return periods;
}

export interface AxisDelta {
  key: AxisKey;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  denominator: number;
  unfilled: boolean;
}

export interface PeriodReport {
  period: Period;
  coverage: number | null;
  axes: AxisDelta[];
}

function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

/**
 * 직전 구간들의 중앙값을 기준선으로 잡고 변화를 낸다 (설계 3.4).
 *
 * 백분위를 쓰지 않는 이유는 구간이 24개뿐이고 층화하면 층당 한 자릿수가 되기 때문이다.
 * 직전 1구간만 보면 구간 크기 편차(2~28세션) 때문에 튀므로 중앙값을 쓴다.
 */
export function reportPeriod(
  periods: Period[],
  index: number,
): PeriodReport | null {
  const period = periods[index];
  if (period === undefined) return null;

  const baselineStart = Math.max(0, index - DELTA_BASELINE_PERIODS);
  const baselinePeriods = periods
    .slice(baselineStart, index)
    .filter((p) => !p.open);

  const axes: AxisDelta[] = AXIS_ORDER.map((key) => {
    const current = axisScore(key, period.axes[key]);
    const baselineValues = baselinePeriods
      .map((p) => axisScore(key, p.axes[key]))
      .filter((v): v is number => v !== null);
    const baseline = median(baselineValues);
    return {
      key,
      current,
      baseline,
      delta: current !== null && baseline !== null ? current - baseline : null,
      denominator: period.axes[key].den,
      unfilled: period.unfilledAxes.includes(key),
    };
  });

  return { period, coverage: coverageRatio(period.coverage), axes };
}
