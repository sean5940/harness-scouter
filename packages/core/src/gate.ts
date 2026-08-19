import { AXIS_ORDER, PERIOD_BUDGET, type AxisKey } from "./definitions.js";
import { L, t, type Lang, type Localized } from "./i18n.js";
import { decomposeVariance, signalToNoise } from "./variance.js";
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

export type GateCheckKey =
  | "saturation"
  | "density"
  | "split-half"
  | "cross-period"
  | "personal-best"
  | "length-confound"
  | "gaming-shift"
  | "ceiling-unreachable"
  | "denominator-survival"
  | "variance-components";

/**
 * 검사 판정.
 *
 * 통과·미달 둘로만 내면 "재보지 못했다"를 둘 중 하나에 섞어야 한다. 초판은 그것을
 * 통과 쪽에 섞었고(`Number.isNaN(r) || …`), 그래서 상수열이라 상관을 못 낸 축이
 * 길이 교란을 통과했다고 보고했다. 재보지 못한 것은 통과가 아니다.
 *
 * 판정을 읽는 자리가 여럿이라(축 표, 화면 지지 집계, MCP 표) 한 곳에서만 세 번째
 * 값을 알아보면 나머지에서 다시 통과로 접힌다. 소비하는 자리를 전부 이 타입으로 건다.
 */
export type GateVerdict = "pass" | "fail" | "not-computable";

/** 표에 찍는 기호. 화면마다 따로 매핑하면 한쪽만 세 번째 판정을 잃는다. */
export function verdictMark(verdict: GateVerdict): string {
  return verdict === "pass" ? "o" : verdict === "fail" ? "X" : "?";
}

export interface GateCheck {
  /**
   * 표시와 무관한 식별자.
   *
   * 초판은 화면에 쓰는 이름으로 검사를 골라냈다(`PER_PERIOD_ONLY.has(name)`). 이름이
   * 다국어가 되는 순간 그 비교는 한쪽 언어에서만 맞고 다른 언어에서는 조용히 아무것도
   * 못 거른다. 같은 결함을 COMPONENT_CRITERIA 에서 한 번 겪었다.
   */
  key: GateCheckKey;
  name: Localized;
  verdict: GateVerdict;
  /**
   * 수치와 설명이 섞인 값이라 언어를 고른 뒤 조립한다.
   *
   * 수치 포맷은 언어와 무관하므로 `Localized` 로 두면 같은 숫자를 두 번 적게 되고,
   * 한쪽만 고치는 drift 가 생긴다. 설명 부분만 갈리게 하고 숫자는 한 번만 만든다.
   */
  value: string;
  criterion: Localized;
}

/**
 * 축이 어느 화면을 뒷받침할 수 있는가.
 *
 * 초판은 통과 여부를 하나로 냈는데, 화면이 둘이라 그게 맞지 않는다. 헤드라인은
 * 전수 집계(모든 구간을 합쳐 하나의 점수)이고 구간별 보기는 부차적이다. 두 화면이
 * 요구하는 것이 다르다.
 *
 * 전수 집계는 구간 간 재현성이 필요 없다. 분모가 두껍고, 길이에 안 휘둘리고, 조작으로
 * 상한까지 밀리지 않으면 된다. 구간별 보기는 거기에 더해 한 구간 안에서 점수가
 * 재현돼야 한다(split-half). 실측에서 6축 중 5축이 뒤에서만 죽는다.
 *
 * 하나로 합쳐 내면 "0/6" 이 되어 전수 집계 화면까지 근거 없는 것처럼 보인다.
 */
export interface AxisGate {
  axis: AxisKey;
  checks: GateCheck[];
  /** 전수 집계 화면을 뒷받침하는가. */
  supportsAllTime: boolean;
  /** 구간별 화면을 뒷받침하는가. 전수 집계 조건에 구간 내 재현성이 더 필요하다. */
  supportsPerPeriod: boolean;
  /** 두 화면을 모두 뒷받침하는가. */
  passed: boolean;
}

export interface GateResult {
  axes: AxisGate[];
  /** 축 쌍 상관. |r| > 0.6이면 같은 정보를 두 번 그리는 것이다. */
  correlations: Array<{
    a: AxisKey;
    b: AxisKey;
    r: number;
    /**
     * 독립성 판정. pass 가 독립이다.
     *
     * 상수 축은 상관을 낼 수 없어 not-computable 이고, 그것은 독립의 근거가 아니다.
     * 초판은 이 자리도 NaN 을 독립으로 셌다.
     */
    independence: GateVerdict;
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

/**
 * 동점에는 평균 순위를 준다.
 *
 * 정렬 순서대로 1..n 을 매기면 상수열이 완전한 오름차순이 되어, 상관을 낼 수 없는 축이
 * 그럴듯한 상관을 낸다. 실측에서 상수인 두 축의 쌍이 rho=1.000 으로 잡혀 축 독립성 검사를
 * 통째로 빠져나갔다. 중복 신호일 가능성이 가장 큰 것이 바로 상수 축이다.
 *
 * 동점을 동점으로 매기면 상수열은 분산이 0 이라 상관이 계산 불가로 나온다.
 * 동점 처리 자체를 되짚을 수 있게 내보낸다.
 */
export function ranks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < indexed.length) {
    const head = indexed[start];
    if (head === undefined) break;
    let end = start;
    while (end + 1 < indexed.length && indexed[end + 1]?.v === head.v) end += 1;
    // 동점 구간 [start, end] 에 걸린 1-based 순위의 평균.
    const midrank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) {
      const entry = indexed[k];
      if (entry !== undefined) out[entry.i] = midrank;
    }
    start = end + 1;
  }
  return out;
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(ranks(xs), ranks(ys));
}

/** 길이 교란으로 볼 상관 크기. 이보다 작으면 크기 자체가 문제가 아니다. */
export const LENGTH_CONFOUND_RHO = 0.5;

/** 우연으로 설명되지 않는다고 볼 선. */
export const LENGTH_CONFOUND_ALPHA = 0.05;

/**
 * 미달을 말할 수 있는 최소 구간 수.
 *
 * n=4 는 완전 단조여도 양측 최소 p 가 2/24 = 0.083 이라 어떤 값이 나와도 0.05 를
 * 못 넘는다. 기각이 원리적으로 불가능한 크기에서 미달을 찍으면 그것은 측정이 아니다.
 */
export const MIN_PERIODS_FOR_LENGTH_REJECT = 5;

/**
 * 통과를 말할 수 있는 최소 구간 수.
 *
 * 통과는 "교란이 없다" 는 주장이라 기각보다 비싸다. 귀무가설에서 |rho| >= 0.5 가
 * 나오는 확률을 순열 전수로 세면 n=5 에서 0.450, n=12 에서 0.098 이다. 10% 아래로
 * 처음 떨어지는 자리가 12 라 거기를 선으로 잡는다. 그 아래에서 상관이 작게 나온 것은
 * 교란이 없어서가 아니라 이 크기에서는 어차피 그렇게 나오기 때문이다.
 *
 * 전수 열거(2026-08-19):
 *   n     4     5     6     7     8     9    10    12    14    16
 *   P  .417  .450  .297  .267  .216  .178  .143  .098  .070  .051
 */
export const MIN_PERIODS_FOR_LENGTH_PASS = 12;

/** 길이 교란 순열 검정 횟수. 순열이 유한하면 전수로 돈다. */
const LENGTH_PERMUTATIONS = 2000;

export interface LengthConfoundResult {
  verdict: GateVerdict;
  rho: number;
  /** 귀무 분포에서 |rho| 이상이 나올 비율. 판정 불가면 NaN. */
  p: number;
  n: number;
}

/**
 * 구간 점수가 구간 크기를 따라가는지.
 *
 * 초판은 rho 를 임계와 한 번 견주고 끝냈다. 구간이 다섯이면 교란이 하나도 없어도
 * |rho| >= 0.5 가 45% 확률로 나오므로, 그 판정은 교란이 아니라 표본 부족을 읽는다.
 * 실제로 6축 중 4축이 미달이었는데 귀무가설에서 기대되는 수가 2.7 이었다.
 *
 * 크기와 우연을 함께 본다. 크고(rho) 우연으로 설명되지 않을 때(p)만 미달이다.
 * 둘 중 하나만 만족하면 판정하지 않는다. 통과는 더 비싸서 구간 수까지 본다.
 */
export function lengthConfoundVerdict(
  scores: number[],
  sessionCounts: number[],
): LengthConfoundResult {
  const n = Math.min(scores.length, sessionCounts.length);
  const rho = spearman(scores.slice(0, n), sessionCounts.slice(0, n));
  if (Number.isNaN(rho) || n < MIN_PERIODS_FOR_LENGTH_REJECT) {
    return { verdict: "not-computable", rho, p: NaN, n };
  }

  // 크기 순서만 섞는다. 점수는 그대로 두어야 "이 점수열이 이 크기열과 짝이 된 것이
  // 우연인가" 를 묻는 것이 된다.
  const rand = seededRandom(n * 7919 + 13);
  const shuffled = sessionCounts.slice(0, n);
  let atLeastAsExtreme = 0;
  for (let iter = 0; iter < LENGTH_PERMUTATIONS; iter += 1) {
    shuffle(shuffled, rand);
    const r = spearman(scores.slice(0, n), shuffled);
    if (!Number.isNaN(r) && Math.abs(r) >= Math.abs(rho)) atLeastAsExtreme += 1;
  }
  const p = atLeastAsExtreme / LENGTH_PERMUTATIONS;

  if (Math.abs(rho) >= LENGTH_CONFOUND_RHO && p < LENGTH_CONFOUND_ALPHA) {
    return { verdict: "fail", rho, p, n };
  }
  // 크게 나왔지만 우연을 못 배제하면 판정하지 않는다. 통과로 세면 교란을 없다고 말하게 된다.
  if (Math.abs(rho) >= LENGTH_CONFOUND_RHO) {
    return { verdict: "not-computable", rho, p, n };
  }
  if (n < MIN_PERIODS_FOR_LENGTH_PASS) {
    return { verdict: "not-computable", rho, p, n };
  }
  return { verdict: "pass", rho, p, n };
}

/**
 * 점수가 있는 구간만, 그 구간을 달고 남긴다.
 *
 * 점수만 돌려주면 호출부가 구간별 배열을 앞에서 잘라 짝을 맞추게 된다. 점수 없는 구간이
 * 중간에 하나라도 있으면 그 뒤의 짝이 전부 한 칸씩 밀려, 각 점수가 다른 구간의 세션 수와
 * 상관된다. 짝을 만든 자리에서 함께 들고 다니면 나중에 누가 더 걸러도 어긋나지 않는다.
 */
function scoredPeriodsOf(
  periods: Period[],
  axis: AxisKey,
): Array<{ period: Period; score: number }> {
  return periods
    .map((period) => ({ period, score: axisScore(axis, period.axes[axis]) }))
    .filter(
      (r): r is { period: Period; score: number } =>
        r.score !== null && Number.isFinite(r.score),
    );
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

/** 반쪽이 세션 한둘이면 비율이 통째로 튄다. 층화 실험도 같은 하한을 써야 한다. */
export const MIN_SESSIONS_FOR_SPLIT_HALF = 6;

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

/**
 * 시드 고정 난수. 분할이 실행마다 갈리면 판정이 재현되지 않는다.
 *
 * 층화 실험의 위약 층도 이 난수기를 써야 한다. 난수기를 따로 두면 위약이 실행마다
 * 달라져, 실제 층화와 나란히 읽을 수 없다.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * 순열 split-half.
 *
 * 초판은 세션 아이디 해시로 분할을 하나 고정했다. 위치 기반 분할이 배치의 규칙성을
 * 상관으로 잡던 것을 고친 것은 옳았지만, 해법이 "무작위 분할 하나"가 아니라 "무작위
 * 분할 전부의 분포"였어야 했다. 구간에 세션이 14개면 가능한 이분할이 1,716가지라
 * 그중 하나만 보고 미달을 판정하고 있었다.
 *
 * 실제로 읽기 왕복 절제가 -0.257 로 나왔는데 분산 성분은 신뢰도 0.5 를 넘길 분모가
 * 충분하다고 말했다. 둘 중 하나가 틀렸고, 분포를 보면 어느 쪽인지 알 수 있다.
 *
 * 부산물이 더 크다. 두 반쪽 차이의 분포에서 검출하한이 나온다. "직전 구간 대비 변화를
 * 표시하지 않는다"가 "이 축은 N 점 미만이면 표시하지 않는다"로 바뀐다.
 */
export interface SplitHalfDistribution {
  /** 순열 상관의 중앙값. 판정은 이것으로 한다. */
  median: number;
  /** 5·95 백분위. 분할 운의 폭이다. */
  low: number;
  high: number;
  /** 돌린 순열 수. */
  permutations: number;
  /**
   * 두 반쪽 차이 절대값의 95백분위.
   *
   * 같은 구간을 두 번 재도 이만큼은 갈린다는 뜻이라, 이보다 작은 구간 간 차이는
   * 측정 잡음과 구별되지 않는다. 0~1 스케일이다.
   */
  detectionFloor: number;
}

const SPLIT_HALF_PERMUTATIONS = 400;

/**
 * split-half 통과선.
 *
 * 층화 실험이 같은 선으로 전후를 재야 "판정이 바뀌었다"가 성립한다. 두 자리에 숫자를
 * 따로 적으면 한쪽만 고쳐 실험이 게이트와 다른 기준으로 통과를 셀 수 있다.
 */
export const SPLIT_HALF_PASS = 0.5;

/** 제자리 Fisher-Yates. 분할마다 같은 코드를 두 번 적지 않으려고 뗀다. */
function shuffle<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
}

/**
 * 세션을 층으로 가르는 표. 값이 무엇을 뜻하는지는 여기서 안 본다.
 *
 * 작업 유형 타입을 그대로 받으면 게이트가 분류기의 taxonomy 에 묶인다. 게이트가 아는
 * 것은 "같은 문자열이면 같은 층"뿐이어야, 나중에 다른 층화 기준(프로젝트·모델·실행 모드)을
 * 같은 코드로 재볼 수 있다.
 */
export type Strata = ReadonlyMap<string, string>;

/**
 * 층을 모르는 세션이 갈 곳. 층별 분할에서 자기들끼리 한 층이 된다.
 *
 * 떨어뜨리면 안 된다. 그러면 그 세션의 분모가 통째로 빠져, 층화 전과 층화 후가 서로 다른
 * 모집단을 재게 된다. 층 이름과 겹쳐도 그 층에 합쳐질 뿐이라 해가 없다.
 */
export const UNKNOWN_STRATUM = "(unknown)";

/**
 * 한 구간의 세션을 두 묶음으로 가른다.
 *
 * 층이 없으면 통째로 섞어 앞뒤로 자른다. 층이 있으면 **층 안에서** 갈라 합친다.
 * 그래야 두 반쪽의 작업 구성이 같아지고, 남는 차이가 축의 불안정으로만 남는다.
 * 통째로 섞으면 한쪽에 리팩터링 세션이 몰리는 분할이 그대로 상관을 깎는다.
 */
function bisect(
  sessionIds: readonly string[],
  rand: () => number,
  strata: Strata | undefined,
): { a: string[]; b: string[] } {
  if (strata === undefined) {
    const ids = [...sessionIds];
    shuffle(ids, rand);
    const half = Math.floor(ids.length / 2);
    return { a: ids.slice(0, half), b: ids.slice(half) };
  }

  const groups = new Map<string, string[]>();
  for (const sid of sessionIds) {
    const key = strata.get(sid) ?? UNKNOWN_STRATUM;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [sid]);
    else group.push(sid);
  }

  const a: string[] = [];
  const b: string[] = [];
  // 층 순서를 정렬로 고정한다. Map 순회 순서는 세션이 들어온 순서라, 같은 구간을
  // 같은 시드로 다시 돌려도 앞선 층이 난수를 몇 번 쓰느냐가 달라질 수 있다.
  for (const key of [...groups.keys()].sort()) {
    const ids = groups.get(key) as string[];
    shuffle(ids, rand);
    // 층별 인원수는 순열마다 고정하고, 누가 어느 쪽에 가느냐만 섞는다.
    //
    // 남는 하나를 매번 난수로 던지는 방식을 먼저 썼는데 그게 틀렸다. 그러면 두 반쪽의
    // 구성이 순열마다 달라져, 층화로 걷어내려던 구성 잡음이 그대로 돌아온다. 게다가
    // 그 하나는 늘 정확히 한쪽에만 들어가므로 두 반쪽에 반대 부호로 실린다. 세션
    // 1개짜리 층을 넣은 검증 세계에서 상관이 -0.284 로 내려갔다.
    //
    // 남는 하나는 지금까지 덜 받은 쪽에 준다. 홀수 층이 여럿이면 나머지가 양쪽으로
    // 갈려 크기가 안 쏠리고, 층이 하나뿐이면 그 층은 늘 같은 쪽에 붙는다. 후자는 한쪽
    // 반쪽에 세션 하나가 더 실린다는 뜻인데, 그 하나가 순열마다 누구인지 바뀌므로
    // 두 반쪽에 더해지는 값이 상수는 아니다. 상관이 편차에 불변이라는 이유로 안전한
    // 것이 아니라, 그 흔들림이 400 순열의 중앙값에 묻힐 만큼 작다는 뜻이다. 1개짜리
    // 층을 넣은 검증 세계에서 중앙값이 0.5 위에 남는 것으로 거기까지만 확인했다.
    const base = Math.floor(ids.length / 2);
    const takesExtra = ids.length % 2 === 1 && a.length <= b.length;
    const toA = base + (takesExtra ? 1 : 0);
    for (let i = 0; i < ids.length; i += 1) {
      (i < toA ? a : b).push(ids[i] as string);
    }
  }
  return { a, b };
}

export function permutedSplitHalf(
  periods: Period[],
  bySession: Map<string, SessionMetrics>,
  axis: AxisKey,
  seed: number,
  strata?: Strata,
): SplitHalfDistribution | null {
  const usable = periods.filter(
    (p) => p.sessionIds.length >= MIN_SESSIONS_FOR_SPLIT_HALF,
  );
  if (usable.length < 3) return null;

  const rand = seededRandom(seed);
  const correlations: number[] = [];
  const gaps: number[] = [];

  for (let iter = 0; iter < SPLIT_HALF_PERMUTATIONS; iter += 1) {
    const first: number[] = [];
    const second: number[] = [];
    for (const period of usable) {
      const split = bisect(period.sessionIds, rand, strata);
      const a: AxisCounts["readScope"] = { num: 0, den: 0 };
      const b: AxisCounts["readScope"] = { num: 0, den: 0 };
      for (const [half, target] of [
        [split.a, a],
        [split.b, b],
      ] as const) {
        for (const sid of half) {
          const metrics = bySession.get(sid);
          if (metrics === undefined) continue;
          target.num += metrics.axes[axis].num;
          target.den += metrics.axes[axis].den;
        }
      }
      const sa = axisScore(axis, a);
      const sb = axisScore(axis, b);
      if (sa !== null && sb !== null) {
        first.push(sa);
        second.push(sb);
        gaps.push(Math.abs(sa - sb));
      }
    }
    const r = pearson(first, second);
    if (!Number.isNaN(r)) correlations.push(r);
  }

  if (correlations.length === 0) return null;
  const sorted = [...correlations].sort((x, y) => x - y);
  const sortedGaps = [...gaps].sort((x, y) => x - y);
  return {
    median: quantile(sorted, 0.5),
    low: quantile(sorted, 0.05),
    high: quantile(sorted, 0.95),
    permutations: correlations.length,
    detectionFloor: quantile(sortedGaps, 0.95),
  };
}

export interface GamingScenario {
  axis: AxisKey;
  label: Localized;
  /**
   * 무엇이 그대로인가를 물리량으로 적는다.
   * "행동이 같다"는 서술은 불변량이 아니다. 읽은 바이트, verifier 프로세스 실행 횟수,
   * 접근한 파일 집합, 커밋된 트리, 스캔한 파일 집합처럼 셀 수 있는 것이어야 한다.
   */
  invariant: Localized;
  /** 그 불변량을 유지한 채 counter 를 움직이는 판정 구멍. 파일·함수 단위로. */
  mechanism: Localized;
  /** 어느 훅 matcher·스킬 문장으로 도입되는가. */
  realWorldForm: Localized;
  /** 코퍼스에 이미 흔적이 있는가. 없으면 코드 구멍 실증이지 관측된 행동이 아니다. */
  corpusEvidence: Localized;
  /**
   * 분류기 수정으로 이 경로가 막혔는가.
   *
   * 막힌 시나리오도 지우지 않고 재발 감시용으로 남긴다. 다만 판정에는 열린 경로만
   * 쓴다. 막은 것을 계속 미달 근거로 삼으면 고쳐도 게이트가 안 움직여 수정할 이유가
   * 사라진다.
   */
  closed?: boolean;
  /** 대상 축의 counter 만 변형한다. */
  apply: (metrics: SessionMetrics) => void;
}

/**
 * 조작 시뮬레이션.
 *
 * 초판은 역수축의 분자를 0으로 만드는 변형을 조작이라고 불렀다. 그건 조작이 아니라
 * 목표 달성이다. `instrumentedChannel.num = 0` 은 "bash 로 파일을 안 건드린다"는 뜻이고
 * 그게 바라는 행동이다. 그래서 재던 값은 "완전히 잘하면 점수가 얼마나 오르나"였고
 * 조작 저항과 무관했다.
 *
 * 조작과 준수는 산술로 구별되지 않는다. 실측에서 세 축의 조작 경로와 준수 경로가 같은
 * 값을 냈다(channel 19.0p, indexed 45.1p, redundancy 16.4p). 그래서 판정 근거를 산술이
 * 아니라 **메커니즘**에 둔다. 각 시나리오는 어느 함수의 어느 조건이 뚫리는지를 적고,
 * 리뷰어가 그 함수를 열어 확인할 수 있어야 한다.
 *
 * 여섯 경로를 동시에 적용하면 행동 변화 없이 6축 중앙값이 전부 100.0 이 된다.
 */
export const GAMING_SCENARIOS: GamingScenario[] = [
  {
    axis: "readScope",
    label: L(
      "Read offset 2 주입으로 전체읽기를 부분읽기로 계상",
      "Inject Read offset 2 so full reads count as partial reads",
    ),
    invariant: L(
      "읽은 바이트와 호출 수가 같다",
      "Bytes read and call count stay the same",
    ),
    mechanism: L(
      "isEffectivePartialRead 가 시작줄 하나로 전체읽기를 판정했다. (500,499,2) 가 true 였다",
      "isEffectivePartialRead decided a full read on the start line alone. (500,499,2) used to be true",
    ),
    realWorldForm: L(
      "PreToolUse:Read 훅이 offset 이 없으면 2를 주입",
      "A PreToolUse:Read hook injects 2 when offset is absent",
    ),
    corpusEvidence: L(
      "흔적 없음 (read_offset 2 가 0건). 코드 구멍 실증. 2026-08-19에 시작줄을 안 보고 커버리지로만 판정하도록 바꿔 닫음. 재발 감시용으로 남긴다",
      "No trace (read_offset 2 in 0 cases). Demonstrated from the code hole. Closed on 2026-08-19 by deciding on coverage alone instead of the start line. Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      m.axes.readScope.num = m.axes.readScope.den;
    },
  },
  {
    axis: "readScope",
    label: L(
      "같은 파일 3분할 chunk 순회로 부분읽기 비율만 올림",
      "Walk the same file in 3 chunks to raise only the partial-read ratio",
    ),
    invariant: L("읽은 바이트가 같다", "Bytes read stay the same"),
    mechanism: L(
      "부분읽기 판정이 호출 단위라 한 파일을 여러 호출로 나누면 전부 분자가 된다",
      "The partial-read decision is per call, so splitting one file into several calls puts all of them in the numerator",
    ),
    realWorldForm: L(
      "스킬 절차에 '큰 파일은 3등분해 읽는다'",
      "A skill step that says 'read large files in three parts'",
    ),
    corpusEvidence: L(
      "offset 증가 인접 재읽기 체인 414건",
      "414 adjacent re-read chains with increasing offset",
    ),
    apply: (m) => {
      const d = m.axes.readScope.den;
      m.axes.readScope.num += 2 * d;
      m.axes.readScope.den += 2 * d;
    },
  },
  {
    axis: "readRevisit",
    label: L(
      "재읽기 직전 사소한 편집으로 재방문을 정당한 재확인으로 재라벨",
      "A trivial edit right before a re-read relabels the revisit as a legitimate recheck",
    ),
    invariant: L(
      "읽은 파일과 횟수와 범위가 같다",
      "The files read, the call count, and the ranges stay the same",
    ),
    mechanism: L(
      "metrics.ts 의 재확인 면제가 `편집 시점 > 직전 읽기 시점` 하나로 판정한다. 편집이 실질적인지 볼 근거가 DB 에 없다 (diff 크기도 old/new 문자열도 없음)",
      "The recheck exemption in metrics.ts decides on `edit time > previous read time` alone. The DB holds nothing that shows whether the edit was substantive (neither diff size nor old/new strings)",
    ),
    realWorldForm: L(
      "스킬 절차에 '재확인 전 대상 파일을 한 번 편집'",
      "A skill step that says 'edit the target file once before rechecking'",
    ),
    corpusEvidence: L(
      "이미 476건이 면제 중 (면제율 33.5%, 그중 비코드 파일 243건)",
      "476 cases are already exempt (exemption rate 33.5%, of which 243 are non-code files)",
    ),
    apply: (m) => {
      m.axes.readRevisit.num = 0;
    },
  },
  {
    axis: "verificationFreshness",
    label: L(
      "커밋 호출에 결과를 안 보는 verifier 를 동봉해 신선도만 세움",
      "Bundle a verifier whose output is never read into the commit call to raise freshness alone",
    ),
    invariant: L(
      "커밋된 트리와 실제 검증 시점이 같다",
      "The committed tree and the actual verification time stay the same",
    ),
    mechanism: L(
      "classifyBash 가 세그먼트 순서를 버리고 호출 단위 boolean 만 낸다. metrics.ts 가 같은 순서 위치에서 verifier 를 커밋보다 먼저 처리한다",
      "classifyBash drops segment order and emits only per-call booleans. metrics.ts handles the verifier before the commit at the same order position",
    ),
    realWorldForm: L(
      "PreToolUse:Bash 가 git commit 앞에 `npx tsc --version;` 을 접합",
      "PreToolUse:Bash splices `npx tsc --version;` in front of git commit",
    ),
    corpusEvidence: L(
      "커밋 704건 중 41건이 이미 동봉 형태 (--version 형태는 0건). 2026-08-19에 verifierKindsOf 가 --version·--help 를 검증에서 빼도록 바꿔 닫음. 재발 감시용으로 남긴다",
      "41 of 704 commits are already in bundled form (0 in the --version form). Closed on 2026-08-19 by making verifierKindsOf drop --version and --help. Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      m.axes.verificationFreshness.num = m.axes.verificationFreshness.den;
    },
  },
  {
    axis: "verificationFreshness",
    label: L(
      "고친 파일과 무관한 대상에 verifier 를 돌려 신선도를 세움",
      "Run the verifier on something unrelated to the edited files",
    ),
    invariant: L(
      "커밋된 코드가 검증된 적 없다는 사실이 그대로다",
      "The committed code still has never been verified",
    ),
    mechanism: L(
      "metrics.ts 는 verifier 의 순서만 보고 대상을 안 본다. 어느 파일을 고쳤는지와 무엇을 검증했는지를 대조하는 코드가 없다",
      "metrics.ts only looks at the verifier order, never its target. Nothing compares which files were edited against what was verified",
    ),
    realWorldForm: L(
      "app/ 50개 파일을 고치고 `npx vitest run test/trivial.test.ts` 하나를 돌린 뒤 커밋",
      "Edit 50 files under app/, run `npx vitest run test/trivial.test.ts`, then commit",
    ),
    corpusEvidence: L(
      "코드 구멍 실증. 2026-08-19에 classifyBash 가 verifierTargets 를 내고 metrics 가 고친 경로와 대조하도록 바꿔 닫음. 실측에서 커밋 94건 중 3건이 credit 을 잃었다(40 → 37). 재발 감시용으로 남긴다",
      "Demonstrated from the code hole. Closed on 2026-08-19 by having classifyBash emit verifierTargets and metrics match them against the edited paths. 3 of 94 commits lost credit (40 → 37). Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      m.axes.verificationFreshness.num = m.axes.verificationFreshness.den;
    },
  },
  {
    axis: "verificationFreshness",
    label: L(
      "고친 것 중 하나만 덮는 검증으로 전부를 덮은 것처럼 세움",
      "Cover just one of the edited paths and have it count for all of them",
    ),
    invariant: L(
      "검증을 한 번 돌리고 커밋한다. 범위만 좁힌다",
      "One verifier run, then the commit. Only its scope narrows",
    ),
    mechanism: L(
      "대상 대조가 고친 경로 중 하나라도 맞으면 덮은 것으로 센다. 좁게 잡으면 정상 검증이 파싱 실패로 신선도를 잃어서 관대한 쪽에 뒀는데, 그 관대함이 그대로 경로가 된다",
      "The target match counts as covered when any one edited path matches. The lenient side was chosen so a genuine check does not lose freshness to a parsing miss, and that leniency is the path",
    ),
    realWorldForm: L(
      "app/ 과 lib/ 을 고치고 `npx eslint app/` 만 돌린 뒤 커밋",
      "Edit both app/ and lib/, run only `npx eslint app/`, then commit",
    ),
    corpusEvidence: L(
      "코드 구멍 실증. 전부를 요구하는 쪽을 실측해 보고 되돌린 기록이 있다. 신선도가 35 에서 20 으로 떨어지는데 split-half 가 0.635 에서 0.516 으로 같이 떨어졌다. 판별을 더한 것이 아니라 잡음을 더한 변경이라 관대한 쪽을 남겼고, 그 선택이 이 경로다",
      "Demonstrated from the code hole. The strict variant was measured and reverted: freshness fell 35 to 20 while split-half fell 0.635 to 0.516, so it added noise rather than discrimination. The lenient side was kept deliberately, and that choice is this path",
    ),
    apply: (m) => {
      m.axes.verificationFreshness.num = m.axes.verificationFreshness.den;
    },
  },
  {
    axis: "verificationFreshness",
    label: L(
      "실패한 verifier 를 무시하고 커밋해도 신선도가 오름",
      "Commit despite a failing verifier and still claim freshness",
    ),
    invariant: L(
      "돌린 명령도 순서도 대상도 같다. 결과를 안 볼 뿐이다",
      "The commands, their order, and their targets are all the same. Only the result is ignored",
    ),
    mechanism: L(
      "metrics.ts 는 verifier 가 돌았는지만 본다. verifierOutcome 이 이미 성패를 내는데 신선도 판정이 그 값을 안 쓴다",
      "metrics.ts only checks that a verifier ran. verifierOutcome already decides pass or fail, but the freshness check never reads it",
    ),
    realWorldForm: L(
      "tsc 가 에러 50건을 내도 그대로 커밋",
      "tsc reports 50 errors and the commit happens anyway",
    ),
    corpusEvidence: L(
      "코드 구멍 실증. 2026-08-19에 verifierOutcome 이 fail 을 낸 검증은 신선도의 근거로 안 쓰도록 바꿔 닫음. 판정 불가는 통과 쪽에 두어 조용히 통과하는 tsc 가 안 걸린다. 재발 감시용으로 남긴다",
      "Demonstrated from the code hole. Closed on 2026-08-19 by refusing freshness credit when verifierOutcome says fail. Undecidable stays on the passing side so a silently passing tsc is unaffected. Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      m.axes.verificationFreshness.num = m.axes.verificationFreshness.den;
    },
  },
  {
    axis: "verificationFreshness",
    label: L(
      "커밋 뒤에 verifier 를 같은 호출로 이어붙여 신선도를 세움",
      "Chain a verifier after the commit in the same call to claim freshness",
    ),
    invariant: L(
      "검증을 도는 시점과 횟수가 같다. 순서만 바뀐다",
      "When and how often verification runs stays the same. Only the order changes",
    ),
    mechanism: L(
      "classifyBash 가 한 호출을 세그먼트로 안 쪼개고 boolean 만 낸다. metrics.ts 가 같은 order 에서 verifier(398행)를 커밋(411행)보다 먼저 처리해 커밋 뒤에 돈 검증도 앞선 것으로 잡힌다",
      "classifyBash emits booleans without splitting a call into segments. metrics.ts handles the verifier (line 398) before the commit (line 411) at the same order, so a check that ran after the commit still counts as preceding it",
    ),
    realWorldForm: L(
      "`git commit -m x && npx tsc --noEmit` 한 줄로 커밋하고 검증",
      "Commit and verify in one line: `git commit -m x && npx tsc --noEmit`",
    ),
    corpusEvidence: L(
      "커밋 704건 중 41건이 검증 동봉 형태. 2026-08-19에 classifyBash 가 hasVerifierBeforeCommit 을 내고 metrics.ts 가 그걸 보도록 바꿔 닫음. 재발 감시용으로 남긴다",
      "41 of 704 commits bundle a check. Closed on 2026-08-19 by having classifyBash emit hasVerifierBeforeCommit and metrics.ts honor it. Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      m.axes.verificationFreshness.num = m.axes.verificationFreshness.den;
    },
  },
  {
    axis: "verificationRedundancy",
    label: L(
      "검증 사이에 사소한 편집·파일쓰기를 끼워 같은 종류 판정을 리셋",
      "Slip a trivial edit or file write between checks to reset the same-kind decision",
    ),
    invariant: L(
      "verifier 프로세스 실행 횟수가 같다",
      "The number of verifier process runs stays the same",
    ),
    mechanism: L(
      "metrics.ts 의 편집·파일쓰기 분기가 blockKinds 를 통째로 비우고, 그 비우기가 verifier 가산보다 앞에 있다",
      "The edit and file-write branch in metrics.ts clears blockKinds wholesale, and that clearing comes before the verifier is counted",
    ),
    realWorldForm: L(
      "스킬 검증 스텝 사이에 작업 로그 한 줄 추가",
      "Add one work-log line between skill verification steps",
    ),
    corpusEvidence: L(
      "리셋이 이미 689건을 지우고 있다 (끄면 분자 960, 지금 271)",
      "The reset already erases 689 cases (numerator 960 with it off, 271 now)",
    ),
    apply: (m) => {
      m.axes.verificationRedundancy.num = 0;
    },
  },
  {
    axis: "verificationRedundancy",
    label: L(
      "같은 kind 반복을 && 로 한 호출에 묶어 재실행 판정을 소거",
      "Chain repeats of the same kind into one call with && to erase the re-run decision",
    ),
    invariant: L(
      "verifier 프로세스 실행 횟수가 같다",
      "The number of verifier process runs stays the same",
    ),
    mechanism: L(
      "verifierKinds 가 Set 이라 한 호출 안의 같은 kind 반복이 1건으로 접혔다. 지금은 실행 횟수를 센다",
      "verifierKinds was a Set, so repeats of the same kind inside one call folded into 1 case. It now counts runs",
    ),
    realWorldForm: L(
      "스킬 검증 스텝을 단일 명령으로 못박기",
      "Pin the skill verification steps to a single command",
    ),
    corpusEvidence: L(
      "접혀 있던 107건이 수정 후 분모에 들어왔다 (1,585 → 1,692). 2026-08-03 분류기 수정으로 닫음. 재발 감시용으로 남긴다",
      "107 folded cases entered the denominator after the fix (1,585 → 1,692). Closed by the 2026-08-03 classifier fix. Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      const c = m.axes.verificationRedundancy;
      c.den -= c.num;
      c.num = 0;
    },
  },
  {
    axis: "instrumentedChannel",
    label: L(
      "cat 대신 awk·python3·node 로 읽어 분자와 분모에서 동시 탈락",
      "Read with awk, python3, or node instead of cat to drop out of both numerator and denominator",
    ),
    invariant: L(
      "접근한 파일 집합이 같다",
      "The set of files accessed stays the same",
    ),
    mechanism: L(
      "소스읽기 판정이 cat·head·tail·bat·sed 다섯 이름만 봤다. 지금은 awk 와 인터프리터 인라인 코드(-c·-e·-p)도 잡는다. 스크립트 실행은 읽기가 아니라 제외한다",
      "The source-read decision looked at five names only: cat, head, tail, bat, sed. It now also catches awk and interpreter inline code (-c, -e, -p). Running a script is not a read and stays out",
    ),
    realWorldForm: L(
      "같은 읽기를 awk·python3 로 쓰는 별칭 한 줄",
      "A one-line alias that writes the same read with awk or python3",
    ),
    corpusEvidence: L(
      "미판정이던 670건이 수정 후 분모에 들어왔다 (8,122 → 8,792). 2026-08-03 분류기 수정으로 닫음. 재발 감시용으로 남긴다",
      "670 undecided cases entered the denominator after the fix (8,122 → 8,792). Closed by the 2026-08-03 classifier fix. Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      const c = m.axes.instrumentedChannel;
      c.den -= c.num;
      c.num = 0;
    },
  },
  {
    axis: "instrumentedChannel",
    label: L(
      "bash 파일 접근을 && 로 4:1 묶어 호출 수만 줄임",
      "Chain bash file accesses 4:1 with && to cut only the call count",
    ),
    invariant: L(
      "접근한 파일 집합이 같다",
      "The set of files accessed stays the same",
    ),
    mechanism: L(
      "가산 단위가 세그먼트가 아니라 호출이라 묶으면 분자가 줄어든다",
      "The counting unit is the call, not the segment, so chaining shrinks the numerator",
    ),
    realWorldForm: L(
      "스킬 절차에 '명령을 이어붙여 호출 수를 줄인다'",
      "A skill step that says 'chain commands to cut the call count'",
    ),
    corpusEvidence: L(
      "여러 kind 묶음이 이미 139건",
      "139 multi-kind chains already",
    ),
    apply: (m) => {
      const c = m.axes.instrumentedChannel;
      const k = Math.ceil(c.num / 4);
      c.den -= c.num - k;
      c.num = k;
    },
  },
  {
    axis: "indexedRetrieval",
    label: L(
      "git grep·비재귀 글롭 grep 으로 전수 스캔을 분류기에서 제외",
      "Hide full scans from the classifier with git grep or non-recursive glob grep",
    ),
    invariant: L(
      "스캔한 파일 집합이 같다",
      "The set of files scanned stays the same",
    ),
    mechanism: L(
      "searchKindOfSegment 가 세그먼트 선두 토큰만 봐서 `git grep` 이 전 필드 false 였다. 지금은 git grep 과 비재귀 글롭 grep 을 함께 잡는다",
      "searchKindOfSegment looked at the leading token of a segment only, so `git grep` was false in every field. It now catches git grep and non-recursive glob grep together",
    ),
    realWorldForm: L(
      "검색 게이트 훅이 rg 를 git grep 으로 리라이트",
      "A search gate hook rewrites rg into git grep",
    ),
    corpusEvidence: L(
      "은닉돼 있던 688건이 수정 후 분모에 들어왔다 (3,438 → 4,126). 2026-08-03 분류기 수정으로 닫음. 재발 감시용으로 남긴다",
      "688 hidden cases entered the denominator after the fix (3,438 → 4,126). Closed by the 2026-08-03 classifier fix. Kept to watch for recurrence",
    ),
    closed: true,
    apply: (m) => {
      const c = m.axes.indexedRetrieval;
      c.den -= c.num;
      c.num = 0;
    },
  },
  {
    axis: "indexedRetrieval",
    label: L(
      "결과를 안 읽는 index query 를 스캔마다 1회 선행",
      "Run one index query whose results are never read before each scan",
    ),
    invariant: L(
      "스캔한 파일 집합이 같다",
      "The set of files scanned stays the same",
    ),
    mechanism: L(
      '인덱스 검색 판정이 호출 유무만 본다. `qmd query --limit 1 ""` 도 분모 크레딧을 받는다',
      'The index-search decision looks only at whether a call happened. `qmd query --limit 1 ""` gets denominator credit too',
    ),
    realWorldForm: L(
      "스킬 탐색 스텝에 'grep 전에 qmd 를 한 번 부른다'",
      "A skill exploration step that says 'call qmd once before grep'",
    ),
    corpusEvidence: L(
      "닫아 둔 것은 qmd get·status 뿐이고 query 반복은 열려 있다",
      "Only qmd get and status are closed; repeating query is still open",
    ),
    apply: (m) => {
      m.axes.indexedRetrieval.den += m.axes.indexedRetrieval.num;
    },
  },
];

const NOT_COMPUTABLE = L("계산 불가", "not computable");
const NO_SCENARIO = L("시나리오 없음", "no scenario");

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
  lang: Lang,
): GateResult {
  const periods = segmentIntoPeriods(forPeriods).filter((p) => !p.open);
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]));

  const axes: AxisGate[] = AXIS_ORDER.map((axis) => {
    const scored = scoredPeriodsOf(periods, axis);
    const scores = scored.map((r) => r.score);
    const sorted = [...scores].sort((a, b) => a - b);
    const spread = quantile(sorted, 0.95) - quantile(sorted, 0.05);

    const dens = periods.map((p) => p.axes[axis].den);
    const denMedian = median(dens);

    // 세션 단위 관측으로 분산을 가른다. 구간 29개가 아니라 세션 전수를 쓰므로 자유도가
    // 열 배 이상이고, 29점 상관의 표준오차(약 0.19)에 휘둘리지 않는다.
    const variance = decomposeVariance(
      sessions.map((m) => ({
        num: m.axes[axis].num,
        den: m.axes[axis].den,
      })),
    );

    const half = splitHalfScores(periods, bySession, axis);
    // 해시 분할 하나가 아니라 순열 분포를 본다. 시드는 축 순서로 고정해 재현되게 한다.
    const permuted = permutedSplitHalf(
      periods,
      bySession,
      axis,
      AXIS_ORDER.indexOf(axis) + 1,
    );
    const rHalf = pearson(half.first, half.second);
    // Spearman-Brown: 반쪽 상관을 전체 길이 신뢰도로 올린다.
    const reliability = Number.isNaN(rHalf) ? NaN : (2 * rHalf) / (1 + rHalf);

    // 세션 수는 그 점수를 낸 구간에서 뽑는다. 전 구간 배열을 앞에서 자르면 점수 없는
    // 구간 뒤로 짝이 밀린다.
    const lengthConfound = lengthConfoundVerdict(
      scores,
      scored.map((r) => r.period.sessionIds.length),
    );

    // 구간 간 안정성. delta 표시가 성립하려면 이웃 구간이 서로를 예측해야 한다.
    // 0에 가까우면 구간별 변화가 신호가 아니라 잡음이다.
    const lagCurrent = scores.slice(0, -1);
    const lagNext = scores.slice(1);
    const rLag1 = pearson(lagCurrent, lagNext);

    const baseline = median(scores);
    const drift = median(
      scores.slice(1).map((s, i) => Math.abs(s - (scores[i] as number))),
    );
    // 축당 시나리오가 여럿이다. 첫 하나만 보면 등록 순서가 결론을 바꾼다
    // (readScope 는 chunk 순회 8.3p 로 통과, offset 주입 18.4p 로 미달이었다).
    const attempts = GAMING_SCENARIOS.filter(
      (g) => g.axis === axis && g.closed !== true,
    ).map((scenario) => {
      // 구간 경계는 기준 분할을 그대로 쓴다. 조작된 세션으로 다시 분할하면
      // 분모 변형이 경계를 흔들어 대상 축 값까지 바뀐다. num·den 을 함께 2배로
      // 하는 조작은 세션 점수가 하나도 안 바뀌는데 재분할하면 +8.5p 가 나왔다.
      const gamedAxis: AxisCounts[AxisKey] = { num: 0, den: 0 };
      const perPeriod = periods.map((p) => {
        const acc = { num: 0, den: 0 };
        for (const sessionId of p.sessionIds) {
          const source = bySession.get(sessionId);
          if (source === undefined) continue;
          const copy = clone(source);
          scenario.apply(copy);
          acc.num += copy.axes[axis].num;
          acc.den += copy.axes[axis].den;
        }
        return acc;
      });
      const after = median(
        perPeriod
          .map((c) => axisScore(axis, c))
          .filter((s): s is number => s !== null),
      );
      const denAfter = median(perPeriod.map((c) => c.den));
      void gamedAxis;
      return {
        scenario,
        // 부호를 유지한다. 절대값을 쓰면 자해(분모 부풀리기 -39.1p)가
        // 최악의 조작으로 보고된다.
        shift: after - baseline,
        denAfter,
        scoredPeriods: perPeriod.filter((c) => axisScore(axis, c) !== null)
          .length,
      };
    });
    const worst = attempts.reduce<(typeof attempts)[number] | null>(
      (best, a) => (best === null || a.shift > best.shift ? a : best),
      null,
    );

    // 개인최고가 도달 가능한 목표인가.
    //
    // 화면은 delta 를 안 쓴다. 개인최고와 이력 백분위를 쓴다. 그래서 검사해야 할 전제도
    // "이웃 구간이 서로를 예측하는가"가 아니라 "최고값이 다시 갈 수 있는 자리인가"다.
    // 최고가 얇은 구간의 요행이거나 분포에서 튄 값이면 목표로 제시할 수 없다.
    // 새 상수를 만들지 않는다. 분모 임계는 이미 있는 PERIOD_BUDGET 이고, 이상치 판정은
    // 표준 사분위 울타리다.
    const bestPeriod = periods
      .map((p) => ({
        score: axisScore(axis, p.axes[axis]),
        den: p.axes[axis].den,
      }))
      .filter((r): r is { score: number; den: number } => r.score !== null)
      .reduce<{ score: number; den: number } | null>(
        (top, r) => (top === null || r.score > top.score ? r : top),
        null,
      );
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    const outlierFence = quantile(sorted, 0.75) + 1.5 * iqr;
    const bestIsReachable =
      bestPeriod !== null &&
      bestPeriod.den >= PERIOD_BUDGET[axis] &&
      bestPeriod.score <= outlierFence;

    const worstLabel = worst === null ? "" : t(worst.scenario.label, lang);

    const checks: GateCheck[] = [
      {
        key: "saturation",
        name: L("포화", "Saturation"),
        verdict: spread > 0.069 ? "pass" : "fail",
        value: `p05~p95 ${spread.toFixed(3)}`,
        criterion: L(
          "> 0.069 (cache_read를 죽인 값)",
          "> 0.069 (the value that killed cache_read)",
        ),
      },
      {
        key: "density",
        name: L("분모 밀도", "Denominator density"),
        verdict: denMedian >= PERIOD_BUDGET[axis] ? "pass" : "fail",
        value: `median ${denMedian.toFixed(0)}`,
        criterion: L(
          `>= 예산 ${PERIOD_BUDGET[axis]}`,
          `>= budget ${PERIOD_BUDGET[axis]}`,
        ),
      },
      // 분산 성분. 이 검사는 통과·미달을 내지 않고 처방을 낸다.
      //
      // split-half 가 "미달"만 말하고 무엇을 해야 하는지는 말하지 않았다. 축이 전부
      // num/den 이라 관측 분산을 참분산과 이항잡음으로 가를 수 있고, 그러면 신뢰도가
      // 0.5 가 되는 분모 k 가 나온다. k 를 구간 예산과 대조하면 그 예산이 애초에 도달
      // 가능한 값인지 알 수 있다.
      {
        key: "variance-components",
        name: L("분산 성분(처방)", "Variance components (prescription)"),
        verdict: "pass",
        value:
          variance === null
            ? t(L("관측 부족", "not enough observations"), lang)
            : variance.halfReliabilityDenominator === null
              ? t(
                  L(
                    "참분산이 잡음보다 작아 분모를 키워도 안 오른다",
                    "true variance is below noise; a bigger denominator will not help",
                  ),
                  lang,
                )
              : `${t(L("신호/잡음", "signal/noise"), lang)} ${signalToNoise(variance).toFixed(2)} · ` +
                `${t(L("신뢰도 0.5 에 필요한 분모", "denominator for reliability 0.5"), lang)} ${variance.halfReliabilityDenominator.toFixed(0)} ` +
                `(${t(L("예산", "budget"), lang)} ${PERIOD_BUDGET[axis]})`,
        criterion: L(
          "임계 없음. 미달을 처방으로 바꾸는 검사다",
          "No threshold. This turns a failure into a prescription",
        ),
      },
      {
        key: "split-half",
        name: L("split-half", "split-half"),
        // 판정은 순열 중앙값으로 한다. 분포의 상단을 보고 임계를 느슨하게 하고 싶어지는데,
        // 그러면 게이트가 아니라 통과시킬 이유를 찾는 장치가 된다.
        verdict:
          permuted !== null && permuted.median >= SPLIT_HALF_PASS
            ? "pass"
            : "fail",
        value:
          permuted === null
            ? t(NOT_COMPUTABLE, lang)
            : `${permuted.median.toFixed(3)} [${permuted.low.toFixed(2)}, ${permuted.high.toFixed(2)}] ` +
              t(
                L(
                  `· 순열 ${permuted.permutations}회 · 구간 ${half.first.length}개`,
                  `· ${permuted.permutations} permutations · ${half.first.length} periods`,
                ),
                lang,
              ),
        criterion: L(">= 0.5", ">= 0.5"),
      },
      // 구간 간 예측력은 판정에서 뺀다.
      //
      // lag-1 이 0 근처인 것은 표본 잡음이 아니다. 구간을 2·3·4배로 묶어 재보면
      // 오히려 더 내려간다(읽기 범위 규율 -0.046 → -0.793). 어떤 집계 단위에서도
      // 이웃 구간이 서로를 예측하지 않는다는 뜻이라, 고쳐서 통과시킬 수 있는 항목이
      // 아니다. 그래서 delta 표시를 없앴고, 화면은 개인최고와 백분위만 쓴다.
      // 쓰지 않는 전제를 계속 pass/fail 로 두면 게이트가 엉뚱한 것을 막는다.
      {
        key: "cross-period",
        name: L("구간 간 예측력(표시)", "Cross-period predictivity (display)"),
        verdict: "pass",
        value: Number.isNaN(rLag1)
          ? t(NOT_COMPUTABLE, lang)
          : `lag-1 r=${rLag1.toFixed(3)} ` +
            t(
              L(
                "· 구간 delta 비교는 지원하지 않음",
                "· period-to-period delta is not supported",
              ),
              lang,
            ),
        criterion: L(
          "임계 없음. 화면이 delta 를 쓰지 않는다",
          "No threshold. The view does not use delta",
        ),
      },
      {
        key: "personal-best",
        name: L("개인최고 도달성", "Personal-best reachability"),
        verdict: bestIsReachable ? "pass" : "fail",
        value:
          bestPeriod === null
            ? t(L("점수 있는 구간 없음", "no scored period"), lang)
            : t(
                L(
                  `최고 ${(bestPeriod.score * 100).toFixed(1)} · 그 구간 분모 ${bestPeriod.den}`,
                  `best ${(bestPeriod.score * 100).toFixed(1)} · denominator of that period ${bestPeriod.den}`,
                ),
                lang,
              ) +
              (bestPeriod.score > outlierFence
                ? t(
                    L(" · 분포에서 튄 값", " · outlier in the distribution"),
                    lang,
                  )
                : ""),
        criterion: L(
          `최고 구간 분모 >= ${PERIOD_BUDGET[axis]} 이고 사분위 울타리 안`,
          `best period denominator >= ${PERIOD_BUDGET[axis]} and inside the quartile fence`,
        ),
      },
      {
        key: "length-confound",
        name: L("길이 교란", "Length confound"),
        // 상관을 못 낸 것과 임계 안에 든 것을 한 값으로 내면 안 된다. 상수열이거나
        // 모든 구간에서 분모가 0 이면 rho 가 NaN 이고, 그건 통과가 아니라 미측정이다.
        // 크기만 보고 판정하지도 않는다. 구간이 다섯이면 교란이 없어도 |rho| >= 0.5 가
        // 45% 확률로 나와서, 그 미달은 교란이 아니라 표본 부족을 읽는다.
        verdict: lengthConfound.verdict,
        value: Number.isNaN(lengthConfound.rho)
          ? t(NOT_COMPUTABLE, lang)
          : `${lengthConfound.rho.toFixed(3)} · p=${
              Number.isNaN(lengthConfound.p)
                ? t(NOT_COMPUTABLE, lang)
                : lengthConfound.p.toFixed(3)
            } · ${t(L("구간", "periods"), lang)} ${lengthConfound.n}`,
        criterion: L(
          `|rho| >= ${LENGTH_CONFOUND_RHO} 이고 p < ${LENGTH_CONFOUND_ALPHA} 이면 미달, 통과는 구간 ${MIN_PERIODS_FOR_LENGTH_PASS} 이상`,
          `fail when |rho| >= ${LENGTH_CONFOUND_RHO} and p < ${LENGTH_CONFOUND_ALPHA}; passing needs ${MIN_PERIODS_FOR_LENGTH_PASS}+ periods`,
        ),
      },
      // 조작 저항은 pass/fail 을 내지 않는다. 임계 10p 가 두 방향으로 깨진다.
      // 조작 없이도 연속 구간 변동 중앙값이 10p 를 넘는 축이 6개 중 5개고,
      // 반대로 읽기 왕복 절제는 여유폭이 7.5p 라 어떤 조작으로도 10p 를 못 넘어
      // 자동 통과한다. 크기로는 조작과 자연 표류를 가를 수 없으므로 값만 보여준다.
      {
        key: "gaming-shift",
        name: L("조작 이동(표시)", "Gaming shift (display)"),
        verdict: "pass",
        value:
          worst === null
            ? t(NO_SCENARIO, lang)
            : `${
                (worst.shift * 100 >= 0 ? "+" : "") +
                (worst.shift * 100).toFixed(1)
              }p` +
              t(
                L(
                  ` · 여유폭의 ${((worst.shift / (1 - baseline)) * 100).toFixed(0)}%`,
                  ` · ${((worst.shift / (1 - baseline)) * 100).toFixed(0)}% of headroom`,
                ),
                lang,
              ) +
              t(
                L(
                  ` · 표류의 ${(worst.shift / drift).toFixed(1)}배 (${worstLabel})`,
                  ` · ${(worst.shift / drift).toFixed(1)}x drift (${worstLabel})`,
                ),
                lang,
              ),
        criterion: L(
          "임계 없음. 판정은 아래 두 검사가 한다",
          "No threshold. The two checks below decide",
        ),
      },
      // 크기 대신 "활동을 안 바꾸고 축을 상한까지 밀 수 있는가"를 본다.
      // 새 상수를 안 만들고 코퍼스 중앙값에 안 흔들린다.
      {
        key: "ceiling-unreachable",
        name: L("상한 도달 불가", "Ceiling unreachable"),
        verdict:
          worst !== null && worst.shift < 1 - baseline - 1e-9 ? "pass" : "fail",
        value:
          worst === null
            ? t(
                L("시나리오 없음 (재보지 않음)", "no scenario (not measured)"),
                lang,
              )
            : worst.shift >= 1 - baseline - 1e-9
              ? t(
                  L(
                    `상한까지 밀림 (${(baseline * 100).toFixed(1)} → 100.0)`,
                    `pushed to the ceiling (${(baseline * 100).toFixed(1)} → 100.0)`,
                  ),
                  lang,
                )
              : t(
                  L(
                    `${((baseline + worst.shift) * 100).toFixed(1)} 까지만`,
                    `only up to ${((baseline + worst.shift) * 100).toFixed(1)}`,
                  ),
                  lang,
                ),
        criterion: L(
          "활동 불변 경로로 100점에 도달하지 못할 것",
          "Must not reach 100 through an activity-invariant path",
        ),
      },
      // 조작이 점수를 올리면서 관측 자체를 없애는 경우를 잡는다.
      // 임계가 이미 코드에 있는 PERIOD_BUDGET 이라 새 상수가 아니다.
      {
        key: "denominator-survival",
        name: L("분모 생존", "Denominator survival"),
        verdict:
          worst !== null &&
          worst.denAfter >= PERIOD_BUDGET[axis] &&
          worst.scoredPeriods >= scores.length
            ? "pass"
            : "fail",
        value:
          worst === null
            ? t(NO_SCENARIO, lang)
            : `den ${worst.denAfter.toFixed(0)} ` +
              t(
                L(
                  `· 유효구간 ${worst.scoredPeriods}/${scores.length}`,
                  `· scored periods ${worst.scoredPeriods}/${scores.length}`,
                ),
                lang,
              ),
        criterion: L(
          `den >= ${PERIOD_BUDGET[axis]} 이고 구간 수 유지`,
          `den >= ${PERIOD_BUDGET[axis]} and period count preserved`,
        ),
      },
    ];

    // 구간 내 재현성(split-half)은 구간별 화면에만 필요하다. 전수 집계는 모든 구간을
    // 합쳐 하나의 점수를 내므로 구간 사이가 흔들려도 무관하다.
    //
    const PER_PERIOD_ONLY = new Set<GateCheckKey>([
      "split-half",
      // 분산 성분은 판정이 아니라 처방이라 화면 지원 여부를 가르지 않는다.
      "variance-components",
    ]);
    // 화면을 뒷받침하려면 통과여야 한다. 계산 불가는 미달과 달리 "재보지 못했다"는
    // 뜻이지만, 재보지 못한 것도 지지 근거는 못 된다. 무엇이 없어서 못 받쳤는지는
    // 검사 표의 판정이 보여준다.
    const supportsAllTime = checks
      .filter((c) => !PER_PERIOD_ONLY.has(c.key))
      .every((c) => c.verdict === "pass");
    const supportsPerPeriod = checks.every((c) => c.verdict === "pass");

    return {
      axis,
      checks,
      supportsAllTime,
      supportsPerPeriod,
      passed: supportsPerPeriod,
    };
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
        // 여기도 NaN 을 독립으로 세고 있었다. 상수 축이면 상관이 안 나오는데, 그것을
        // 독립으로 접으면 중복 신호일 가능성이 가장 큰 축이 검사를 통째로 빠져나간다.
        independence: Number.isNaN(r)
          ? "not-computable"
          : Math.abs(r) <= 0.6
            ? "pass"
            : "fail",
      });
    }
  }

  return { axes, correlations, periodCount: periods.length };
}
