import { describe, expect, it } from "vitest";

import { ranks, runGate, verdictMark } from "../src/gate.js";
import { type AxisKey } from "../src/definitions.js";
import { emptyAxes, emptyExtras, type SessionMetrics } from "../src/metrics.js";
import {
  emptyEvents,
  emptyUsage,
  type SessionForPeriod,
} from "../src/periods.js";

/**
 * 게이트 판정의 회귀 테스트.
 *
 * 여기서 지키는 것은 세 가지다. 재보지 못한 통계를 통과로 세지 않을 것, 동점을 동점으로
 * 매겨 상수열의 상관이 계산 불가로 나올 것, 길이 교란이 같은 구간의 점수와 세션 수를
 * 짝지을 것. 셋 다 "숫자가 그럴듯하다"로는 잡히지 않고 답을 아는 코퍼스를 만들어야 잡힌다.
 */

const HOUR_MS = 3_600_000;

function session(
  index: number,
  counts: Array<[AxisKey, { num: number; den: number }]>,
): SessionForPeriod {
  const axes = emptyAxes();
  for (const [axis, count] of counts) axes[axis] = { ...count };
  const at = new Date(Date.UTC(2026, 0, 1) + index * HOUR_MS).toISOString();
  return {
    metrics: {
      sessionId: `s${String(index).padStart(3, "0")}`,
      axes,
      extras: emptyExtras(),
      coverage: { observable: 0, offChannel: 0, opaque: 0 },
      capability: { total: 0, mapped: 0, unmapped: {} },
      verifierOutcomeUnknown: 0,
      blockedCalls: 0,
    } as SessionMetrics,
    startedAt: at,
    endedAt: at,
    events: emptyEvents(),
    usage: emptyUsage(),
    reachedArtifact: false,
  };
}

/**
 * 구간 하나의 num·den 을 세션 k 개로 나눈다.
 *
 * 앞 세션이 분모를 1 씩만 받고 마지막이 나머지를 받아야 구간이 정확히 k 번째 세션에서
 * 예산을 채운다. 구간 경계를 원하는 자리에 두려면 이 배분이 필요하다.
 */
function spread(
  num: number,
  den: number,
  k: number,
): Array<{ num: number; den: number }> {
  const out: Array<{ num: number; den: number }> = [];
  let left = num;
  for (let i = 0; i < k; i += 1) {
    const d = i < k - 1 ? 1 : den - (k - 1);
    const n = Math.min(left, d);
    left -= n;
    out.push({ num: n, den: d });
  }
  return out;
}

interface PeriodSpec {
  sessions: number;
  /** 축별 구간 합계. 빠진 축은 분모 0 이라 그 구간에서 점수가 없다. */
  totals: Array<[AxisKey, { num: number; den: number }]>;
}

function corpus(specs: PeriodSpec[]): SessionForPeriod[] {
  const sessions: SessionForPeriod[] = [];
  let index = 0;
  for (const spec of specs) {
    const perAxis = spec.totals.map(
      ([axis, total]) =>
        [axis, spread(total.num, total.den, spec.sessions)] as const,
    );
    for (let i = 0; i < spec.sessions; i += 1) {
      sessions.push(
        session(
          index,
          perAxis.map(([axis, parts]) => [
            axis,
            parts[i] ?? { num: 0, den: 0 },
          ]),
        ),
      );
      index += 1;
    }
  }
  return sessions;
}

function gateOf(sessions: SessionForPeriod[]): ReturnType<typeof runGate> {
  return runGate(
    sessions.map((s) => s.metrics),
    sessions,
    "en",
  );
}

function checkOf(
  gate: ReturnType<typeof runGate>,
  axis: AxisKey,
  key: string,
): { verdict: string; value: string } {
  const found = gate.axes
    .find((a) => a.axis === axis)
    ?.checks.find((c) => c.key === key);
  if (found === undefined) throw new Error(`${axis} 에 ${key} 검사가 없다`);
  return found;
}

/**
 * 점수 없는 구간이 **중간에** 있는 코퍼스.
 *
 * 구간 다섯 개의 세션 수가 4·40·5·6·7 이고, verificationFreshness 는 두 번째 구간에서만
 * 분모가 0 이라 점수가 없다. 그 구간은 예산을 못 채워 세션 상한 40 에서 닫힌다.
 *
 * 점수는 0.1·0.2·0.3·0.4 로 오르고 그 구간들의 세션 수는 4·5·6·7 로 오르므로 제대로 짝을
 * 지으면 rho 는 정확히 1 이다. 전 구간 세션 수 배열을 앞에서 자르면 4·40·5·6 과 짝지어져
 * 0.4 가 나온다. 판정까지 갈린다(0.4 는 통과, 1.0 은 미달).
 */
function middleNullCorpus(): SessionForPeriod[] {
  const a: AxisKey = "readScope";
  const b: AxisKey = "verificationFreshness";
  return corpus([
    {
      sessions: 4,
      totals: [
        [a, { num: 6, den: 10 }],
        [b, { num: 1, den: 10 }],
      ],
    },
    // 여기서 b 가 빠진다. a 만으로는 예산이 안 차서 세션 상한까지 간다.
    { sessions: 40, totals: [[a, { num: 0, den: 40 }]] },
    {
      sessions: 5,
      totals: [
        [a, { num: 7, den: 10 }],
        [b, { num: 2, den: 10 }],
      ],
    },
    {
      sessions: 6,
      totals: [
        [a, { num: 8, den: 10 }],
        [b, { num: 3, den: 10 }],
      ],
    },
    {
      sessions: 7,
      totals: [
        [a, { num: 9, den: 10 }],
        [b, { num: 4, den: 10 }],
      ],
    },
  ]);
}

/**
 * 한 축이 모든 구간에서 같은 점수인 코퍼스.
 *
 * readScope 는 0.5 로 상수고, verificationFreshness 는 0.3·0.1·0.4·0.2 로 시간 순서와
 * 무관하게 움직인다. 동점을 순서대로 1..n 으로 매기면 상수축이 완전한 오름차순이 되어
 * 두 축의 rho 가 0 으로 나오고, 그러면 상수축이 축 독립성 검사를 통과해 버린다.
 */
function constantAxisCorpus(): SessionForPeriod[] {
  const a: AxisKey = "readScope";
  const b: AxisKey = "verificationFreshness";
  const scores = [3, 1, 4, 2];
  return corpus(
    [4, 5, 6, 7].map((sessions, i) => ({
      sessions,
      totals: [
        [a, { num: 5, den: 10 }],
        [b, { num: scores[i] as number, den: 10 }],
      ] as PeriodSpec["totals"],
    })),
  );
}

describe("순위 (동점 처리)", () => {
  it("상수열은 전부 같은 순위를 받는다", () => {
    // 1·2·3 으로 매기면 상수열이 완전한 오름차순이 되어 상관이 나올 수 없는데도 나온다.
    expect(ranks([0.4, 0.4, 0.4])).toEqual([2, 2, 2]);
  });

  it("동점 무리에는 평균 순위를 준다", () => {
    expect(ranks([1, 1, 2, 2])).toEqual([1.5, 1.5, 3.5, 3.5]);
    expect(ranks([5, 1, 5, 3])).toEqual([3.5, 1, 3.5, 2]);
  });

  it("동점이 없으면 순위가 그대로다", () => {
    // 대조군. 동점 처리를 넣느라 멀쩡하던 순위가 바뀌면 상관값이 통째로 달라진다.
    expect(ranks([0.3, 0.1, 0.2])).toEqual([3, 1, 2]);
    expect(ranks([4, 40, 5, 6])).toEqual([1, 4, 2, 3]);
  });
});

describe("계산 불가 판정", () => {
  it("계산 불가는 표에서 통과와 다른 기호로 찍힌다", () => {
    // 화면마다 기호를 따로 매핑하면 한쪽에서만 세 번째 판정이 사라진다.
    expect(verdictMark("pass")).toBe("o");
    expect(verdictMark("fail")).toBe("X");
    expect(verdictMark("not-computable")).toBe("?");
  });

  it("잴 수 없는 길이 교란은 통과가 아니라 계산 불가다", () => {
    // 분모가 모든 구간에서 0 인 축은 점수가 하나도 없어 rho 가 NaN 이다.
    const gate = gateOf(middleNullCorpus());
    const check = checkOf(gate, "indexedRetrieval", "length-confound");
    expect(check.verdict).toBe("not-computable");
    expect(check.value).toBe("not computable");
  });

  it("계산 불가는 어떤 통과 집계에도 안 들어간다", () => {
    const gate = gateOf(middleNullCorpus());
    const axis = gate.axes.find((a) => a.axis === "indexedRetrieval");
    // 임계 없는 표시 전용 검사 셋만 통과다. 길이 교란은 여기 없어야 한다.
    expect(
      axis?.checks.filter((c) => c.verdict === "pass").map((c) => c.key),
    ).toEqual(["variance-components", "cross-period", "gaming-shift"]);
    expect(axis?.supportsAllTime).toBe(false);
    expect(axis?.supportsPerPeriod).toBe(false);
  });

  it("상수축의 길이 교란은 계산 불가다", () => {
    // 동점을 순서대로 매기던 때는 여기서 rho=1.000 이 나왔다. 상수축의 상관은 없다.
    const gate = gateOf(constantAxisCorpus());
    const check = checkOf(gate, "readScope", "length-confound");
    expect(check.verdict).toBe("not-computable");
    expect(check.value).toBe("not computable");
  });

  it("상수축이 낀 축 쌍은 독립으로 세지 않는다", () => {
    // 초판은 이 쌍의 rho 를 0.000 으로 내고 독립이라고 적었다. 중복 신호일 가능성이
    // 가장 큰 것이 상수축인데 검사를 통째로 빠져나갔다.
    const gate = gateOf(constantAxisCorpus());
    const pair = gate.correlations.find(
      (c) => c.a === "readScope" && c.b === "verificationFreshness",
    );
    expect(Number.isNaN(pair?.r)).toBe(true);
    expect(pair?.independence).toBe("not-computable");
  });
});

describe("길이 교란의 짝짓기", () => {
  it("점수 없는 구간이 중간에 있어도 같은 구간의 세션 수와 짝짓는다", () => {
    // 제대로 짝지으면 0.1·0.2·0.3·0.4 와 4·5·6·7 이라 rho 는 1 이다.
    // 앞에서 자르면 4·40·5·6 과 짝지어져 0.400 이 나오고 판정까지 통과로 뒤집힌다.
    const gate = gateOf(middleNullCorpus());
    const check = checkOf(gate, "verificationFreshness", "length-confound");
    expect(check.value).toBe("1.000");
    expect(check.verdict).toBe("fail");
  });

  it("빠진 구간이 없는 축은 값도 판정도 그대로다", () => {
    // 대조군. readScope 는 다섯 구간 전부에 점수가 있어 짝짓기가 원래 맞았다.
    const gate = gateOf(middleNullCorpus());
    const check = checkOf(gate, "readScope", "length-confound");
    expect(check.value).toBe("0.000");
    expect(check.verdict).toBe("pass");
  });

  it("동점도 빠진 구간도 없으면 상관이 그대로 계산된다", () => {
    // 대조군. 세 결함 중 어느 것도 걸리지 않는 축은 예전 값을 그대로 낸다.
    const gate = gateOf(constantAxisCorpus());
    const check = checkOf(gate, "verificationFreshness", "length-confound");
    expect(check.value).toBe("0.000");
    expect(check.verdict).toBe("pass");
  });
});
