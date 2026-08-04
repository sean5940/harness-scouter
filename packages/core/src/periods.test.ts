import { describe, expect, it } from "vitest";
import { PERIOD_MIN_SESSIONS } from "./definitions.js";
import { emptyAxes, emptyExtras } from "./metrics.js";
import { segmentIntoPeriods, type SessionForPeriod } from "./periods.js";

/**
 * 작은 코퍼스에서도 구간이 닫히는가.
 *
 * 다른 사람이 이 도구를 처음 돌렸을 때 아무 화면도 안 나왔다. 원인은 구간이 닫히는 출구가
 * 둘인데 둘 다 막혀 있어서였다.
 *
 *   예산 충족   6축 전부가 최소 분모를 채워야 하는데, git 저장소가 아니라 커밋이 0 이고
 *               검증 축 분모가 영원히 0 이다
 *   세션 상한   40 인데 그 사람은 15 세션이다
 *
 * 상한 40 은 355 세션 코퍼스에 맞춰 잡은 값이라 탈출구 역할을 못 했다. 값을 다시 튜닝하는
 * 대신 "채워질 가망이 없는 축은 안 기다린다"로 조건을 고쳤다.
 */
function session(
  id: string,
  day: number,
  mutate: (axes: ReturnType<typeof emptyAxes>) => void,
): SessionForPeriod {
  const axes = emptyAxes();
  mutate(axes);
  return {
    startedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`,
    endedAt: `2026-08-${String(day).padStart(2, "0")}T01:00:00Z`,
    metrics: {
      sessionId: id,
      axes,
      extras: emptyExtras(),
      coverage: { observable: 50, offChannel: 0, opaque: 0 },
      capability: { total: 0, mapped: 0, unmapped: {} },
      verifierOutcomeUnknown: 0,
      blockedCalls: 0,
    },
    events: { interrupt: 0, queueMidflight: 0, userRejected: 0 },
    usage: {
      input: 100_000,
      output: 5_000,
      cacheRead: 0,
      cacheCreation: 0,
      requests: 10,
    },
    reachedArtifact: false,
  };
}

/** 커밋이 없는 하네스. 읽기와 검색은 활발하지만 검증 축 분모가 0 이다. */
const nonGit = (id: string, day: number) =>
  session(id, day, (a) => {
    a.readScope = { num: 20, den: 30 };
    a.readRevisit = { num: 3, den: 40 };
    a.instrumentedChannel = { num: 10, den: 25 };
    a.indexedRetrieval = { num: 5, den: 12 };
  });

describe("커밋이 없는 작은 코퍼스", () => {
  it("15 세션이면 구간이 닫힌다", () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      nonGit(`s${i}`, (i % 28) + 1),
    );
    const closed = segmentIntoPeriods(sessions).filter((p) => !p.open);
    expect(closed.length).toBeGreaterThan(0);
  });

  it("채워질 수 없는 축을 미충족으로 세지 않는다", () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      nonGit(`s${i}`, (i % 28) + 1),
    );
    const closed = segmentIntoPeriods(sessions).filter((p) => !p.open);
    for (const p of closed) expect(p.unfilledAxes).toEqual([]);
  });

  it("구간이 세션 하나로 쪼개지지 않는다", () => {
    // 세션 하나가 예산을 다 채워도 최소 크기를 지킨다. 안 그러면 구간이 세션의
    // 다른 이름이 되어 "이 시기에 어땠나"를 못 묻는다.
    const sessions = Array.from({ length: 15 }, (_, i) =>
      nonGit(`s${i}`, (i % 28) + 1),
    );
    const closed = segmentIntoPeriods(sessions).filter((p) => !p.open);
    for (const p of closed) {
      expect(p.sessionIds.length).toBeGreaterThanOrEqual(PERIOD_MIN_SESSIONS);
    }
  });
});

describe("축이 하나도 안 잡히는 코퍼스", () => {
  it("아무 분모도 없으면 최소 세션 수로만 닫는다", () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      session(`s${i}`, (i % 28) + 1, () => {}),
    );
    const closed = segmentIntoPeriods(sessions).filter((p) => !p.open);
    // 기다릴 축이 하나도 없으므로 최소 세션 수만 채우면 닫힌다.
    expect(closed.length).toBeGreaterThan(0);
    for (const p of closed) {
      expect(p.sessionIds.length).toBeGreaterThanOrEqual(PERIOD_MIN_SESSIONS);
    }
  });
});

describe("세션이 아주 적을 때", () => {
  it("최소 세션 수에 못 미치면 열린 구간 하나만 남는다", () => {
    const sessions = Array.from({ length: 2 }, (_, i) =>
      nonGit(`s${i}`, i + 1),
    );
    const periods = segmentIntoPeriods(sessions);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.open).toBe(true);
  });
});
