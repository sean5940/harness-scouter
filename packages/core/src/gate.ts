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
  /**
   * 무엇이 그대로인가를 물리량으로 적는다.
   * "행동이 같다"는 서술은 불변량이 아니다. 읽은 바이트, verifier 프로세스 실행 횟수,
   * 접근한 파일 집합, 커밋된 트리, 스캔한 파일 집합처럼 셀 수 있는 것이어야 한다.
   */
  invariant: string;
  /** 그 불변량을 유지한 채 counter 를 움직이는 판정 구멍. 파일·함수 단위로. */
  mechanism: string;
  /** 어느 훅 matcher·스킬 문장으로 도입되는가. */
  realWorldForm: string;
  /** 코퍼스에 이미 흔적이 있는가. 없으면 코드 구멍 실증이지 관측된 행동이 아니다. */
  corpusEvidence: string;
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
    label: "Read offset 2 주입으로 전체읽기를 부분읽기로 계상",
    invariant: "읽은 바이트와 호출 수가 같다",
    mechanism:
      "definitions.ts isEffectivePartialRead 가 시작줄 `from <= 1` 하나로 전체읽기를 판정한다. (500,499,2) 가 true 다",
    realWorldForm: "PreToolUse:Read 훅이 offset 이 없으면 2를 주입",
    corpusEvidence: "흔적 없음 (read_offset 2 가 0건). 코드 구멍 실증",
    apply: (m) => {
      m.axes.readScope.num = m.axes.readScope.den;
    },
  },
  {
    axis: "readScope",
    label: "같은 파일 3분할 chunk 순회로 부분읽기 비율만 올림",
    invariant: "읽은 바이트가 같다",
    mechanism:
      "부분읽기 판정이 호출 단위라 한 파일을 여러 호출로 나누면 전부 분자가 된다",
    realWorldForm: "스킬 절차에 '큰 파일은 3등분해 읽는다'",
    corpusEvidence: "offset 증가 인접 재읽기 체인 414건",
    apply: (m) => {
      const d = m.axes.readScope.den;
      m.axes.readScope.num += 2 * d;
      m.axes.readScope.den += 2 * d;
    },
  },
  {
    axis: "readRevisit",
    label: "재읽기 직전 사소한 편집으로 재방문을 정당한 재확인으로 재라벨",
    invariant: "읽은 파일과 횟수와 범위가 같다",
    mechanism:
      "metrics.ts 의 재확인 면제가 `편집 시점 > 직전 읽기 시점` 하나로 판정한다. 편집이 실질적인지 볼 근거가 DB 에 없다 (diff 크기도 old/new 문자열도 없음)",
    realWorldForm: "스킬 절차에 '재확인 전 대상 파일을 한 번 편집'",
    corpusEvidence:
      "이미 476건이 면제 중 (면제율 33.5%, 그중 비코드 파일 243건)",
    apply: (m) => {
      m.axes.readRevisit.num = 0;
    },
  },
  {
    axis: "verificationFreshness",
    label: "커밋 호출에 결과를 안 보는 verifier 를 동봉해 신선도만 세움",
    invariant: "커밋된 트리와 실제 검증 시점이 같다",
    mechanism:
      "classifyBash 가 세그먼트 순서를 버리고 호출 단위 boolean 만 낸다. metrics.ts 가 같은 순서 위치에서 verifier 를 커밋보다 먼저 처리한다",
    realWorldForm:
      "PreToolUse:Bash 가 git commit 앞에 `npx tsc --version;` 을 접합",
    corpusEvidence:
      "커밋 704건 중 41건이 이미 동봉 형태 (--version 형태는 0건)",
    apply: (m) => {
      m.axes.verificationFreshness.num = m.axes.verificationFreshness.den;
    },
  },
  {
    axis: "verificationRedundancy",
    label: "검증 사이에 사소한 편집·파일쓰기를 끼워 같은 종류 판정을 리셋",
    invariant: "verifier 프로세스 실행 횟수가 같다",
    mechanism:
      "metrics.ts 의 편집·파일쓰기 분기가 blockKinds 를 통째로 비우고, 그 비우기가 verifier 가산보다 앞에 있다",
    realWorldForm: "스킬 검증 스텝 사이에 작업 로그 한 줄 추가",
    corpusEvidence: "리셋이 이미 689건을 지우고 있다 (끄면 분자 960, 지금 271)",
    apply: (m) => {
      m.axes.verificationRedundancy.num = 0;
    },
  },
  {
    axis: "verificationRedundancy",
    label: "같은 kind 반복을 && 로 한 호출에 묶어 재실행 판정을 소거",
    invariant: "verifier 프로세스 실행 횟수가 같다",
    mechanism:
      "verifierKinds 가 Set 이라 한 호출 안의 같은 kind 반복이 1건으로 접힌다. `npx tsc && npx tsc && npx tsc` 가 [tsc] 하나다",
    realWorldForm: "스킬 검증 스텝을 단일 명령으로 못박기",
    corpusEvidence: "verifier 호출 1,469건 중 여러 kind 묶음 139건",
    apply: (m) => {
      const c = m.axes.verificationRedundancy;
      c.den -= c.num;
      c.num = 0;
    },
  },
  {
    axis: "instrumentedChannel",
    label: "cat 대신 awk·python3·node 로 읽어 분자와 분모에서 동시 탈락",
    invariant: "접근한 파일 집합이 같다",
    mechanism:
      "bash.ts 의 소스읽기 판정이 cat·head·tail·bat·sed 다섯 이름만 본다. awk·python3·node·perl 은 아예 안 잡힌다",
    realWorldForm: "같은 읽기를 awk·python3 로 쓰는 별칭 한 줄",
    corpusEvidence:
      "미판정 2,152건 (소스·문서 확장자 1,427건, 계상된 것은 2,394건)",
    apply: (m) => {
      const c = m.axes.instrumentedChannel;
      c.den -= c.num;
      c.num = 0;
    },
  },
  {
    axis: "instrumentedChannel",
    label: "bash 파일 접근을 && 로 4:1 묶어 호출 수만 줄임",
    invariant: "접근한 파일 집합이 같다",
    mechanism: "가산 단위가 세그먼트가 아니라 호출이라 묶으면 분자가 줄어든다",
    realWorldForm: "스킬 절차에 '명령을 이어붙여 호출 수를 줄인다'",
    corpusEvidence: "여러 kind 묶음이 이미 139건",
    apply: (m) => {
      const c = m.axes.instrumentedChannel;
      const k = Math.ceil(c.num / 4);
      c.den -= c.num - k;
      c.num = k;
    },
  },
  {
    axis: "indexedRetrieval",
    label: "git grep·비재귀 글롭 grep 으로 전수 스캔을 분류기에서 제외",
    invariant: "스캔한 파일 집합이 같다",
    mechanism:
      "bash.ts searchKindOfSegment 가 세그먼트 선두 토큰만 보고 rg·ag·ack·grep -r·find -name 만 매칭한다. `git grep` 은 선두가 git 이라 전 필드 false 다",
    realWorldForm: "검색 게이트 훅이 rg 를 git grep 으로 리라이트",
    corpusEvidence: "이미 440건 은닉 (계상된 스캔 1,218건 대비 26.5%)",
    apply: (m) => {
      const c = m.axes.indexedRetrieval;
      c.den -= c.num;
      c.num = 0;
    },
  },
  {
    axis: "indexedRetrieval",
    label: "결과를 안 읽는 index query 를 스캔마다 1회 선행",
    invariant: "스캔한 파일 집합이 같다",
    mechanism:
      '인덱스 검색 판정이 호출 유무만 본다. `qmd query --limit 1 ""` 도 분모 크레딧을 받는다',
    realWorldForm: "스킬 탐색 스텝에 'grep 전에 qmd 를 한 번 부른다'",
    corpusEvidence: "닫아 둔 것은 qmd get·status 뿐이고 query 반복은 열려 있다",
    apply: (m) => {
      m.axes.indexedRetrieval.den += m.axes.indexedRetrieval.num;
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

    const baseline = median(scores);
    const drift = median(
      scores.slice(1).map((s, i) => Math.abs(s - (scores[i] as number))),
    );
    // 축당 시나리오가 여럿이다. 첫 하나만 보면 등록 순서가 결론을 바꾼다
    // (readScope 는 chunk 순회 8.3p 로 통과, offset 주입 18.4p 로 미달이었다).
    const attempts = GAMING_SCENARIOS.filter((g) => g.axis === axis).map(
      (scenario) => {
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
      },
    );
    const worst = attempts.reduce<(typeof attempts)[number] | null>(
      (best, a) => (best === null || a.shift > best.shift ? a : best),
      null,
    );

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
        value: Number.isNaN(rLag1)
          ? "계산 불가"
          : `lag-1 r=${rLag1.toFixed(3)}`,
        criterion: ">= 0.3 (delta 비교의 전제)",
      },
      {
        name: "길이 교란",
        passed: Number.isNaN(rLength) || Math.abs(rLength) < 0.5,
        value: Number.isNaN(rLength) ? "계산 불가" : rLength.toFixed(3),
        criterion: "|rho| < 0.5",
      },
      // 조작 저항은 pass/fail 을 내지 않는다. 임계 10p 가 두 방향으로 깨진다.
      // 조작 없이도 연속 구간 변동 중앙값이 10p 를 넘는 축이 6개 중 5개고,
      // 반대로 읽기 왕복 절제는 여유폭이 7.5p 라 어떤 조작으로도 10p 를 못 넘어
      // 자동 통과한다. 크기로는 조작과 자연 표류를 가를 수 없으므로 값만 보여준다.
      {
        name: "조작 이동(표시)",
        passed: true,
        value:
          worst === null
            ? "시나리오 없음"
            : `${
                (worst.shift * 100 >= 0 ? "+" : "") +
                (worst.shift * 100).toFixed(1)
              }p` +
              ` · 여유폭의 ${((worst.shift / (1 - baseline)) * 100).toFixed(
                0,
              )}%` +
              ` · 표류의 ${(worst.shift / drift).toFixed(1)}배 (${
                worst.scenario.label
              })`,
        criterion: "임계 없음. 판정은 아래 두 검사가 한다",
      },
      // 크기 대신 "활동을 안 바꾸고 축을 상한까지 밀 수 있는가"를 본다.
      // 새 상수를 안 만들고 코퍼스 중앙값에 안 흔들린다.
      {
        name: "상한 도달 불가",
        passed: worst !== null && worst.shift < 1 - baseline - 1e-9,
        value:
          worst === null
            ? "시나리오 없음 (재보지 않음)"
            : worst.shift >= 1 - baseline - 1e-9
              ? `상한까지 밀림 (${(baseline * 100).toFixed(1)} → 100.0)`
              : `${((baseline + worst.shift) * 100).toFixed(1)} 까지만`,
        criterion: "활동 불변 경로로 100점에 도달하지 못할 것",
      },
      // 조작이 점수를 올리면서 관측 자체를 없애는 경우를 잡는다.
      // 임계가 이미 코드에 있는 PERIOD_BUDGET 이라 새 상수가 아니다.
      {
        name: "분모 생존",
        passed:
          worst === null
            ? false
            : worst.denAfter >= PERIOD_BUDGET[axis] &&
              worst.scoredPeriods >= scores.length,
        value:
          worst === null
            ? "시나리오 없음"
            : `den ${worst.denAfter.toFixed(0)} · 유효구간 ${
                worst.scoredPeriods
              }/${scores.length}`,
        criterion: `den >= ${PERIOD_BUDGET[axis]} 이고 구간 수 유지`,
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
