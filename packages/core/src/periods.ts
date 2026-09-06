import {
  AXIS_ORDER,
  DELTA_BASELINE_PERIODS,
  PERIOD_BUDGET,
  PERIOD_MIN_SESSIONS,
  PERIOD_SESSION_CAP,
  type AxisKey,
} from "./definitions.js";
import {
  addCapability,
  addCounts,
  addExtras,
  axisScore,
  coverageRatio,
  emptyAxes,
  emptyCapability,
  emptyExtras,
  type AxisCounts,
  type CapabilityCounts,
  type CoverageCount,
  type ExtraCounts,
  type SessionMetrics,
} from "./metrics.js";

/** 토큰 사용량. 토큰 효율 합성이 쓴다. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  requests: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0 };
}

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
  usage: TokenUsage;
  /** 코드를 고친 세션 중 커밋이나 PR까지 간 비율. 완수력이 쓴다. */
  delivery: { num: number; den: number };
  coverage: CoverageCount;
  /**
   * 프로필이 이 구간의 도구 호출을 얼마나 덮었는가.
   *
   * 위의 `coverage` 와 다른 것을 센다. 저것은 계측 채널로 본 호출의 비율이고, 이것은
   * 본 호출 중 능력에 매핑된 비율이다. 매핑표가 낡으면 저것은 그대로인데 이것만
   * 떨어진다. 세션 단위로는 이미 세고 있었는데 구간으로 올라오는 길이 없어서
   * 아무도 읽지 못했다.
   */
  capability: CapabilityCounts;
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
  usage: TokenUsage;
  /** 이 세션이 커밋이나 PR을 남겼는지 */
  reachedArtifact: boolean;
}

/**
 * 이 코퍼스에서 애초에 채워질 수 있는 축.
 *
 * 예산을 기다리려면 언젠가 채워질 가망이 있어야 한다. 코퍼스 전체에서 분모가 0 인 축은
 * 세션을 아무리 더 쌓아도 안 채워지므로, 그것을 기다리면 구간이 영원히 안 닫힌다.
 *
 * 실제로 그렇게 막혔다. git 저장소가 아닌 곳에서 쓰면 커밋이 없어 검증 축 분모가 0 이고,
 * 세션 15개짜리 사용자는 세션 상한 40 에도 못 닿아 닫힌 구간이 하나도 안 생겼다. 그러면
 * 등급·막대·통상범위를 요구하는 모든 화면이 거부한다. 도구가 통째로 안 도는 것이다.
 *
 * 상한 40 은 355 세션 코퍼스에 맞춰 잡은 값이라 작은 코퍼스에는 탈출구가 못 된다.
 * 상한을 낮추는 대신 "못 채우는 축을 안 기다린다"로 고친다. 값을 다시 튜닝하는 것이
 * 아니라 조건 자체를 코퍼스에 맞게 만드는 쪽이다.
 */
function fillableAxes(sessions: SessionForPeriod[]): AxisKey[] {
  return AXIS_ORDER.filter((key) =>
    sessions.some((s) => s.metrics.axes[key].den > 0),
  );
}

function unfilled(axes: AxisCounts, fillable: AxisKey[]): AxisKey[] {
  return fillable.filter((key) => axes[key].den < PERIOD_BUDGET[key]);
}

/**
 * 이 구간으로 비교할 수 있는 축이 하나라도 있는가.
 *
 * 세션 상한은 구간이 영원히 안 닫히는 것을 막으려고 둔 것인데, 상한을 세션 **수**로만
 * 잡으면 세션 크기가 코퍼스마다 달라 구간의 실질 크기가 벌어진다. 그래프 노드를 세션
 * 하나로 도는 하네스에서는 세션당 도구호출 중앙값이 10 이라, 40개를 묶어도 구간이
 * 턴 62개다. 같은 코퍼스의 다른 구간은 9,602 턴이었고 편차가 155배까지 났다.
 *
 * 축이 하나도 예산에 안 닿은 구간은 모든 축이 회색이다. 무엇과도 비교할 수 없는 점을
 * 하나 만들어 놓고 split-half 에 같은 무게로 넣으면 재현성이 안 나오는 게 당연하다.
 * 그런 구간은 상한에 걸려도 닫지 않고 더 모은다.
 *
 * 새 임계를 만들지 않았다. "비교할 수 있다" 의 기준은 `PERIOD_BUDGET` 이 축마다 이미
 * 정해 둔 최소 분모 그대로다. 예산을 다 채우면 닫고(budgetMet), 하나도 못 채웠으면
 * 안 닫는다. 그 사이가 상한이 하던 일이다.
 *
 * 세션이 떨어지면 마지막 flush 가 열린 구간으로 내보내므로 무한히 모이지 않는다.
 */
function comparable(axes: AxisCounts, fillable: AxisKey[]): boolean {
  return fillable.some((key) => axes[key].den >= PERIOD_BUDGET[key]);
}

/**
 * 세션을 시간순으로 쌓다가 6축 전부가 최소 분모를 채우는 지점에서 끊는다 (설계 3.4).
 *
 * 시간으로 묶지 않는 이유는 코퍼스가 5주치뿐이라 주 단위로는 6구간밖에 안 나오기
 * 때문이다. 축마다 다른 범위를 보게 하는 방식도 쓰지 않는다. 육각형 한 장에
 * 시점이 섞이면 판독이 안 된다.
 */
export function segmentIntoPeriods(sessions: SessionForPeriod[]): Period[] {
  const fillable = fillableAxes(sessions);
  const ordered = [...sessions].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const periods: Period[] = [];

  let axes = emptyAxes();
  let extras = emptyExtras();
  let events = emptyEvents();
  let usage = emptyUsage();
  let delivery = { num: 0, den: 0 };
  let coverage: CoverageCount = { observable: 0, offChannel: 0, opaque: 0 };
  let capability: CapabilityCounts = emptyCapability();
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
      usage,
      delivery,
      coverage,
      capability,
      closedByBudget,
      unfilledAxes: unfilled(axes, fillable),
      open,
    });
    axes = emptyAxes();
    extras = emptyExtras();
    events = emptyEvents();
    usage = emptyUsage();
    delivery = { num: 0, den: 0 };
    coverage = { observable: 0, offChannel: 0, opaque: 0 };
    capability = emptyCapability();
    members = [];
  };

  for (const session of ordered) {
    addCounts(axes, session.metrics.axes);
    addExtras(extras, session.metrics.extras);
    events.interrupt += session.events.interrupt;
    events.queueMidflight += session.events.queueMidflight;
    events.userRejected += session.events.userRejected;
    usage.input += session.usage.input;
    usage.output += session.usage.output;
    usage.cacheRead += session.usage.cacheRead;
    usage.cacheCreation += session.usage.cacheCreation;
    usage.requests += session.usage.requests;
    if (session.metrics.extras.codeEdits > 0) {
      delivery.den += 1;
      if (session.reachedArtifact) delivery.num += 1;
    }
    coverage.observable += session.metrics.coverage.observable;
    coverage.offChannel += session.metrics.coverage.offChannel;
    coverage.opaque += session.metrics.coverage.opaque;
    capability = addCapability(capability, session.metrics.capability);
    members.push(session);

    // 예산을 채웠어도 세션이 너무 적으면 더 모은다. 세션 하나가 예산을 다 채우는
    // 코퍼스에서 구간이 세션 1개씩으로 쪼개지는 것을 막는다.
    const budgetMet =
      unfilled(axes, fillable).length === 0 &&
      members.length >= PERIOD_MIN_SESSIONS;
    if (budgetMet) flush(true, false);
    else if (members.length >= PERIOD_SESSION_CAP && comparable(axes, fillable))
      flush(false, false);
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
export interface PeriodSizeSpread {
  min: number;
  median: number;
  max: number;
  /** 최대/최소. 구간을 같은 무게로 비교할 수 있는지를 이 값 하나로 본다. */
  ratio: number | null;
}

/**
 * 닫힌 구간들의 크기가 얼마나 벌어져 있는가. 크기는 턴 수로 센다.
 *
 * 이것을 안 보여주면 재현성 게이트의 실패가 하네스 탓으로 읽힌다. 크기가 155배 다른
 * 점들을 같은 무게로 놓고 split-half 를 물으면 재현성이 안 나오는 것이 당연한데,
 * 화면에는 "0/6 축" 만 있고 왜 그런지는 없다.
 *
 * 임계를 걸지 않고 값만 낸다. 얼마부터가 큰지는 코퍼스마다 다르고, 근거 없는 임계를
 * 하나 더 만드느니 숫자를 그대로 보여주는 편이 낫다.
 */
export function periodSizeSpread(periods: Period[]): PeriodSizeSpread | null {
  const sizes = periods
    .filter((p) => !p.open)
    .map((p) => p.extras.assistantTurns)
    .filter((n) => n > 0);
  if (sizes.length === 0) return null;
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  return {
    min,
    // 턴은 셈이라 소수점이 안 나온다. 짝수 개일 때 중앙값이 .5 로 나오는 것만 접는다.
    median: Math.round(median(sizes) ?? min),
    max,
    ratio: min === 0 ? null : max / min,
  };
}

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
