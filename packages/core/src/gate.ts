import { AXIS_ORDER, PERIOD_BUDGET, type AxisKey } from "./definitions.js";
import { axisScore, type AxisCounts, type SessionMetrics } from "./metrics.js";
import {
  segmentIntoPeriods,
  type Period,
  type SessionForPeriod,
} from "./periods.js";

/**
 * M0.5 재현성 게이트 (설계 8절).
 *
 * 검증 2라운드에서 후보 14개 중 무사통과가 0건이었고, 죽은 것들은 전부 "실측 근거가
 * 붙은 그럴듯한 축"이었다. 그래서 확정축이라도 같은 기준을 통과해야 M1로 넘어간다.
 */

export interface GateCheck {
  name: string;
  passed: boolean;
  value: string;
  criterion: string;
}

export interface AxisGate {
  axis: AxisKey;
  checks: GateCheck[];
  passed: boolean;
}

export interface GateResult {
  axes: AxisGate[];
  /** 축 쌍 상관. |r| > 0.6이면 같은 정보를 두 번 그리는 것이다. */
  correlations: Array<{
    a: AxisKey;
    b: AxisKey;
    r: number;
    independent: boolean;
  }>;
  periodCount: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) return NaN;
  return a + (b - a) * (pos - lo);
}

function median(values: number[]): number {
  return quantile(
    [...values].sort((x, y) => x - y),
    0.5,
  );
}

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  let sx = 0,
    sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i] ?? 0;
    sy += ys[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = (xs[i] ?? 0) - mx;
    const b = (ys[i] ?? 0) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

function ranks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  for (let i = 0; i < indexed.length; i += 1) {
    const entry = indexed[i];
    if (entry !== undefined) out[entry.i] = i + 1;
  }
  return out;
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(ranks(xs), ranks(ys));
}

function scoresOf(periods: Period[], axis: AxisKey): number[] {
  return periods
    .map((p) => axisScore(axis, p.axes[axis]))
    .filter((v): v is number => v !== null && Number.isFinite(v));
}

/**
 * 세션 아이디로 안정적인 0/1을 만든다.
 *
 * 구간 안에서 순서대로 번갈아 가르면 안 된다. 세션이 시간순이라 큰 구현 세션과 짧은
 * 확인 세션이 번갈아 오는 구조가 있으면 두 묶음이 체계적으로 달라져, 축의 불안정이
 * 아니라 배치의 규칙성이 상관으로 잡힌다. 실제로 위치 기반으로 갈랐을 때
 * 축2가 −0.782로 나왔다.
 */
function stableBucket(sessionId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2;
}

const MIN_SESSIONS_FOR_SPLIT_HALF = 6;

/** 구간의 세션을 두 묶음으로 갈라 같은 축을 두 번 계산한다. */
function splitHalfScores(
  periods: Period[],
  bySession: Map<string, SessionMetrics>,
  axis: AxisKey,
): { first: number[]; second: number[] } {
  const first: number[] = [];
  const second: number[] = [];
  for (const period of periods) {
    // 반쪽이 세션 한둘이면 비율이 통째로 튄다. 표본이 되는 구간만 쓴다.
    if (period.sessionIds.length < MIN_SESSIONS_FOR_SPLIT_HALF) continue;
    const a: AxisCounts["readScope"] = { num: 0, den: 0 };
    const b: AxisCounts["readScope"] = { num: 0, den: 0 };
    period.sessionIds.forEach((sid) => {
      const metrics = bySession.get(sid);
      if (metrics === undefined) return;
      const target = stableBucket(sid) === 0 ? a : b;
      target.num += metrics.axes[axis].num;
      target.den += metrics.axes[axis].den;
    });
    const sa = axisScore(axis, a);
    const sb = axisScore(axis, b);
    if (sa !== null && sb !== null) {
      first.push(sa);
      second.push(sb);
    }
  }
  return { first, second };
}

export interface GamingScenario {
  axis: AxisKey;
  label: string;
  /** 세션 지표를 조작 시나리오대로 변형한다. */
  apply: (metrics: SessionMetrics) => void;
}

/**
 * 조작 시뮬레이션.
 *
 * "가장 싼 개선책이 대개 조작"이라는 것이 검증 2라운드의 반복 결론이라,
 * 각 축마다 실제로 있을 법한 최저비용 조작을 넣어 중앙값이 얼마나 움직이는지 본다.
 */
export const GAMING_SCENARIOS: GamingScenario[] = [
  {
    axis: "readScope",
    label: "Read를 잘게 쪼개 부분읽기 비율만 올림",
    apply: (m) => {
      m.axes.readScope.num += m.axes.readScope.den;
      m.axes.readScope.den += m.axes.readScope.den;
    },
  },
  {
    axis: "verificationRedundancy",
    label: "검증을 항상 한 번만 돌리도록 강제",
    apply: (m) => {
      m.axes.verificationRedundancy.num = 0;
    },
  },
  {
    axis: "indexedRetrieval",
    label: "Bash 검색을 전부 인덱스 도구로 이관",
    apply: (m) => {
      m.axes.indexedRetrieval.num = 0;
    },
  },
  {
    axis: "instrumentedChannel",
    label: "bash 파일 접근을 전부 계측 도구로 이관",
    apply: (m) => {
      m.axes.instrumentedChannel.num = 0;
    },
  },
];

function clone(metrics: SessionMetrics): SessionMetrics {
  return {
    ...metrics,
    axes: Object.fromEntries(
      AXIS_ORDER.map((k) => [k, { ...metrics.axes[k] }]),
    ) as AxisCounts,
    coverage: { ...metrics.coverage },
  };
}

export function runGate(
  sessions: SessionMetrics[],
  forPeriods: SessionForPeriod[],
): GateResult {
  const periods = segmentIntoPeriods(forPeriods).filter((p) => !p.open);
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]));

  const sessionSizes = periods.map((p) => p.sessionIds.length);

  const axes: AxisGate[] = AXIS_ORDER.map((axis) => {
    const scores = scoresOf(periods, axis);
    const sorted = [...scores].sort((a, b) => a - b);
    const spread = quantile(sorted, 0.95) - quantile(sorted, 0.05);

    const dens = periods.map((p) => p.axes[axis].den);
    const denMedian = median(dens);

    const half = splitHalfScores(periods, bySession, axis);
    const rHalf = pearson(half.first, half.second);
    // Spearman-Brown: 반쪽 상관을 전체 길이 신뢰도로 올린다.
    const reliability = Number.isNaN(rHalf) ? NaN : (2 * rHalf) / (1 + rHalf);

    const rLength = spearman(scores, sessionSizes.slice(0, scores.length));

    // 구간 간 안정성. delta 표시가 성립하려면 이웃 구간이 서로를 예측해야 한다.
    // 0에 가까우면 구간별 변화가 신호가 아니라 잡음이다.
    const lagCurrent = scores.slice(0, -1);
    const lagNext = scores.slice(1);
    const rLag1 = pearson(lagCurrent, lagNext);

    const scenario = GAMING_SCENARIOS.find((g) => g.axis === axis);
    let gamingShift = 0;
    if (scenario !== undefined) {
      const gamed = forPeriods.map((s) => {
        const copy = clone(s.metrics);
        scenario.apply(copy);
        return { ...s, metrics: copy };
      });
      const gamedPeriods = segmentIntoPeriods(gamed).filter((p) => !p.open);
      const before = median(scores);
      const after = median(scoresOf(gamedPeriods, axis));
      gamingShift = Math.abs(after - before);
    }

    const checks: GateCheck[] = [
      {
        name: "포화",
        passed: spread > 0.069,
        value: `p05~p95 ${spread.toFixed(3)}`,
        criterion: "> 0.069 (cache_read를 죽인 값)",
      },
      {
        name: "분모 밀도",
        passed: denMedian >= PERIOD_BUDGET[axis],
        value: `median ${denMedian.toFixed(0)}`,
        criterion: `>= 예산 ${PERIOD_BUDGET[axis]}`,
      },
      {
        name: "split-half",
        passed: reliability >= 0.5,
        value: Number.isNaN(reliability)
          ? "계산 불가"
          : `${reliability.toFixed(3)} (구간 ${half.first.length}개)`,
        criterion: ">= 0.5",
      },
      {
        name: "구간 안정성",
        passed: !Number.isNaN(rLag1) && rLag1 >= 0.3,
        value: Number.isNaN(rLag1) ? "계산 불가" : `lag-1 r=${rLag1.toFixed(3)}`,
        criterion: ">= 0.3 (delta 비교의 전제)",
      },
      {
        name: "길이 교란",
        passed: Number.isNaN(rLength) || Math.abs(rLength) < 0.5,
        value: Number.isNaN(rLength) ? "계산 불가" : rLength.toFixed(3),
        criterion: "|rho| < 0.5",
      },
      {
        name: "조작 저항",
        passed: scenario === undefined || gamingShift <= 0.1,
        value:
          scenario === undefined
            ? "시나리오 없음"
            : `${(gamingShift * 100).toFixed(1)}p (${scenario.label})`,
        criterion: "중앙값 변화 <= 10p",
      },
    ];

    return { axis, checks, passed: checks.every((c) => c.passed) };
  });

  const correlations: GateResult["correlations"] = [];
  for (let i = 0; i < AXIS_ORDER.length; i += 1) {
    for (let j = i + 1; j < AXIS_ORDER.length; j += 1) {
      const a = AXIS_ORDER[i] as AxisKey;
      const b = AXIS_ORDER[j] as AxisKey;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const p of periods) {
        const sa = axisScore(a, p.axes[a]);
        const sb = axisScore(b, p.axes[b]);
        if (sa !== null && sb !== null) {
          xs.push(sa);
          ys.push(sb);
        }
      }
      const r = spearman(xs, ys);
      correlations.push({
        a,
        b,
        r,
        independent: Number.isNaN(r) || Math.abs(r) <= 0.6,
      });
    }
  }

  return { axes, correlations, periodCount: periods.length };
}
