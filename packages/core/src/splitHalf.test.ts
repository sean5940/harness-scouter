import { describe, expect, it } from "vitest";
import { permutedSplitHalf } from "./gate.js";
import { emptyAxes, emptyExtras, type SessionMetrics } from "./metrics.js";
import { emptyEvents, emptyUsage, type Period } from "./periods.js";

/**
 * 순열 split-half 가 아는 답을 내는가.
 *
 * 실제 코퍼스에 돌려 나온 숫자가 그럴듯한 것은 검증이 아니다. 답을 아는 두 세계를 만들어
 * 그것을 되찾는지 봐야 한다. 이 검증이 필요했던 이유는 순열로 바꾸면서 인덱스 우선 탐색이
 * 통과에서 미달로 넘어갔기 때문이다. 판정을 뒤집는 변경은 구현부터 의심해야 한다.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function binomial(p: number, n: number, rand: () => number): number {
  let k = 0;
  for (let i = 0; i < n; i += 1) if (rand() < p) k += 1;
  return k;
}

/** 구간별 참비율을 주면 그 세계의 세션·구간을 만든다. */
function buildWorld(
  periodRates: number[],
  denPerSession: number,
  seed: number,
): { periods: Period[]; bySession: Map<string, SessionMetrics> } {
  const rand = rng(seed);
  const periods: Period[] = [];
  const bySession = new Map<string, SessionMetrics>();

  periodRates.forEach((rate, pi) => {
    const sessionIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const sid = `p${pi}s${i}`;
      const axes = emptyAxes();
      axes.readScope = {
        num: binomial(rate, denPerSession, rand),
        den: denPerSession,
      };
      bySession.set(sid, {
        sessionId: sid,
        axes,
        extras: emptyExtras(),
        coverage: { observable: 0, offChannel: 0, opaque: 0 },
        capability: { total: 0, mapped: 0, unmapped: {} },
        verifierOutcomeUnknown: 0,
        blockedCalls: 0,
      } as SessionMetrics);
      sessionIds.push(sid);
    }
    periods.push({
      index: pi,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-02T00:00:00Z",
      sessionIds,
      open: false,
      axes: emptyAxes(),
      extras: emptyExtras(),
      events: emptyEvents(),
      usage: emptyUsage(),
      delivery: { num: 0, den: 0 },
      coverage: { observable: 0, offChannel: 0, opaque: 0 },
    } as Period);
  });

  return { periods, bySession };
}

describe("순열 split-half", () => {
  it("구간끼리 크게 다르면 상관이 높다", () => {
    const rates = Array.from({ length: 26 }, (_, i) => 0.2 + (i / 25) * 0.6);
    const { periods, bySession } = buildWorld(rates, 50, 1);
    const d = permutedSplitHalf(periods, bySession, "readScope", 1);
    expect(d?.median).toBeGreaterThan(0.9);
  });

  it("구간이 전부 같으면 상관이 낮다", () => {
    const rates = Array.from({ length: 26 }, () => 0.5);
    const { periods, bySession } = buildWorld(rates, 50, 2);
    const d = permutedSplitHalf(periods, bySession, "readScope", 2);
    expect(d?.median).toBeLessThan(0.5);
  });

  it("분포의 폭을 함께 낸다", () => {
    const rates = Array.from({ length: 26 }, (_, i) => 0.3 + (i % 5) * 0.1);
    const { periods, bySession } = buildWorld(rates, 40, 3);
    const d = permutedSplitHalf(periods, bySession, "readScope", 3);
    expect(d).not.toBeNull();
    expect(d?.low).toBeLessThanOrEqual(d?.median ?? 0);
    expect(d?.median).toBeLessThanOrEqual(d?.high ?? 0);
    expect(d?.permutations).toBeGreaterThan(300);
  });

  it("검출하한을 낸다", () => {
    // 같은 구간을 두 번 재도 이만큼 갈린다는 값. 분모가 작을수록 커야 한다.
    const rates = Array.from({ length: 26 }, () => 0.5);
    const thin = permutedSplitHalf(
      ...(() => {
        const w = buildWorld(rates, 10, 4);
        return [w.periods, w.bySession] as const;
      })(),
      "readScope",
      4,
    );
    const thick = permutedSplitHalf(
      ...(() => {
        const w = buildWorld(rates, 200, 5);
        return [w.periods, w.bySession] as const;
      })(),
      "readScope",
      5,
    );
    expect(thin?.detectionFloor).toBeGreaterThan(thick?.detectionFloor ?? 1);
  });

  it("시드가 같으면 결과가 같다", () => {
    // 판정이 실행마다 갈리면 게이트가 아니다.
    const rates = Array.from({ length: 26 }, (_, i) => 0.3 + (i % 4) * 0.15);
    const { periods, bySession } = buildWorld(rates, 40, 6);
    const a = permutedSplitHalf(periods, bySession, "readScope", 9);
    const b = permutedSplitHalf(periods, bySession, "readScope", 9);
    expect(a?.median).toBe(b?.median);
    expect(a?.detectionFloor).toBe(b?.detectionFloor);
  });

  it("구간이 적으면 내지 않는다", () => {
    const { periods, bySession } = buildWorld([0.5, 0.5], 30, 7);
    expect(permutedSplitHalf(periods, bySession, "readScope", 7)).toBeNull();
  });
});
