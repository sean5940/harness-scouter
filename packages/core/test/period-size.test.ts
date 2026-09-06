import { describe, expect, it } from "vitest";

import { PERIOD_BUDGET, PERIOD_SESSION_CAP } from "../src/definitions.js";
import { emptyAxes, emptyExtras } from "../src/metrics.js";
import {
  periodSizeSpread,
  segmentIntoPeriods,
  type SessionForPeriod,
} from "../src/periods.js";

/**
 * 세션 크기 편차가 큰 코퍼스에서 구간이 비교 가능한 크기로 닫히는지 본다.
 *
 * 상한을 세션 **수**로만 잡으면 세션 크기가 코퍼스마다 달라 구간의 실질 크기가 벌어진다.
 * 그래프 노드를 세션 하나로 도는 하네스에서 세션당 도구호출 중앙값이 10 이었고, 40개를
 * 묶어도 구간이 턴 62개였다. 같은 코퍼스의 다른 구간은 9,602 턴이라 편차가 155배였다.
 *
 * 크기가 155배 다른 점들을 같은 무게로 놓고 split-half 를 물으면 재현성이 안 나오는 것이
 * 당연하다. 그런데 화면에는 "0/6 축" 만 있고 왜 그런지는 없었다.
 *
 * 두 세계를 만든다. 세션이 작아 축이 하나도 예산에 안 닿는 코퍼스와, 축이 닿는 코퍼스에
 * 같은 세션 수를 넣는다. 앞은 더 모아야 하고 뒤는 지금까지처럼 상한에서 닫혀야 한다.
 */
function session(
  id: string,
  day: number,
  turns: number,
  mutate: (axes: ReturnType<typeof emptyAxes>) => void,
): SessionForPeriod {
  const axes = emptyAxes();
  mutate(axes);
  const extras = emptyExtras();
  extras.assistantTurns = turns;
  return {
    startedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`,
    endedAt: `2026-08-${String(day).padStart(2, "0")}T01:00:00Z`,
    metrics: {
      sessionId: id,
      axes,
      extras,
      coverage: { observable: 50, offChannel: 0, opaque: 0 },
      capability: { total: 0, mapped: 0, unmapped: {} },
      verifierOutcomeUnknown: 0,
      blockedCalls: 0,
    },
    events: { interrupt: 0, queueMidflight: 0, userRejected: 0 },
    usage: {
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheCreation: 0,
      requests: 1,
    },
    reachedArtifact: false,
  } as unknown as SessionForPeriod;
}

/**
 * 그래프 노드 하나짜리 세션. 도구호출이 두어 건뿐이다.
 *
 * 축에 분모를 아주 드물게만 보탠다. 세션 40개를 묶어도 어느 축도 예산에 못 닿는 것이
 * 이 코퍼스의 모양이다. 한 축이라도 세션마다 분모를 채우면 그 축이 예산을 채워
 * 지금까지의 경로로 닫히고, 이 파일이 물으려는 상황이 안 만들어진다.
 */
const tiny = (n: number) =>
  session(`t${n}`, (n % 28) + 1, 2, (a) => {
    if (n % 5 === 0) a.readScope = { num: 1, den: 1 };
    if (n % 7 === 0) a.readRevisit = { num: 0, den: 1 };
  });

/** 사람이 도는 보통 세션. 세션 하나로도 축 하나는 예산을 넘긴다. */
const normal = (n: number) =>
  session(`n${n}`, (n % 28) + 1, 60, (a) => {
    a.readScope = { num: 20, den: PERIOD_BUDGET.readScope + 5 };
  });

describe("비교할 수 없는 구간은 상한에 걸려도 닫지 않는다", () => {
  it("축이 하나도 예산에 안 닿는 동안은 상한에 걸려도 안 닫는다", () => {
    // 세션을 상한만큼 채워도 축이 하나도 안 차면 닫지 않는다. 예전에는 여기서 잘라
    // 모든 축이 회색인 점을 하나 만들었고, 그 점이 split-half 에 같은 무게로 들어갔다.
    const periods = segmentIntoPeriods(
      Array.from({ length: PERIOD_SESSION_CAP }, (_, i) => tiny(i)),
    );
    expect(periods.filter((p) => !p.open)).toHaveLength(0);
    // 남은 것은 열린 구간 하나다. 점수 화면은 열린 구간을 비교에 안 쓴다.
    expect(periods).toHaveLength(1);
    expect(periods[0]?.open).toBe(true);
  });

  it("축이 닿으면 지금까지처럼 상한에서 닫는다", () => {
    // 반대 방향을 잠근다. 이 변경이 "상한을 없앤다" 가 되면 안 된다.
    const sessions = Array.from({ length: PERIOD_SESSION_CAP * 2 }, (_, i) =>
      normal(i),
    );
    const closed = segmentIntoPeriods(sessions).filter((p) => !p.open);
    expect(closed.length).toBeGreaterThan(0);
    for (const p of closed) {
      expect(p.sessionIds.length).toBeLessThanOrEqual(PERIOD_SESSION_CAP);
    }
  });

  it("작은 세션이 쌓여 축이 차면 그때 닫는다", () => {
    // 영영 안 닫히는 것이 아니라, 비교할 수 있게 될 때까지 미루는 것이다.
    // 작은 세션도 충분히 모이면 readScope 분모가 예산을 넘는다.
    const sessions = Array.from(
      { length: PERIOD_BUDGET.readScope * 4 + PERIOD_SESSION_CAP },
      (_, i) => tiny(i),
    );
    const closed = segmentIntoPeriods(sessions).filter((p) => !p.open);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed[0]?.sessionIds.length).toBeGreaterThan(PERIOD_SESSION_CAP);
  });
});

describe("구간 크기 편차를 값으로 낸다", () => {
  it("닫힌 구간들의 턴 수로 최소·중앙값·최대와 배수를 낸다", () => {
    const sessions = [
      ...Array.from({ length: 4 }, (_, i) => normal(i)),
      ...Array.from({ length: 4 }, (_, i) =>
        session(`b${i}`, 10, 600, (a) => {
          a.readScope = { num: 20, den: PERIOD_BUDGET.readScope + 5 };
        }),
      ),
    ];
    const periods = segmentIntoPeriods(sessions);
    const spread = periodSizeSpread(periods);
    expect(spread).not.toBe(null);
    expect(spread?.min).toBeLessThan(spread?.max as number);
    expect(spread?.ratio).toBeCloseTo(
      (spread?.max as number) / (spread?.min as number),
    );
  });

  it("닫힌 구간이 없으면 값을 내지 않는다", () => {
    // 못 잰 것을 0 으로 내지 않는다. 진행 중 구간은 크기를 물을 대상이 아니다.
    const periods = segmentIntoPeriods(
      Array.from({ length: 3 }, (_, i) => tiny(i)),
    );
    expect(periodSizeSpread(periods)).toBe(null);
  });
});
