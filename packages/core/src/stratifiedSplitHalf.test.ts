import { describe, expect, it } from "vitest";
import { permutedSplitHalf, type Strata } from "./gate.js";
import { emptyAxes, emptyExtras, type SessionMetrics } from "./metrics.js";
import { emptyEvents, emptyUsage, type Period } from "./periods.js";
import { placeboStrata } from "./stratify.js";

/**
 * 층화가 아는 답을 되찾는가.
 *
 * 층화는 상관을 올리는 장치가 아니라 **한 후보를 지우는 장치**다. 구간 점수가 안 재현되는
 * 이유가 축 자체인지 반쪽마다 달라지는 작업 구성인지 가르는 것이 전부다. 그래서 검증도
 * 실제 코퍼스에서 숫자가 올라가는 것으로는 안 된다. 원인이 구성인 세계와 아닌 세계를
 * 따로 만들어, 앞에서만 올라가는지 봐야 한다.
 *
 * 뒤 세계가 특히 중요하다. 층화가 원인과 무관하게 늘 상관을 올린다면 그것은 진단이 아니라
 * 통과시키는 장치다.
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

interface World {
  periods: Period[];
  bySession: Map<string, SessionMetrics>;
  strata: Strata;
}

/**
 * 구간마다 참실력 `skill` 이 있고, 세션은 층에 따라 그 실력에서 `offset` 만큼 밀린다.
 *
 * `offsets` 를 전부 0으로 주면 층이 이름표일 뿐인 세계가 된다. 층이 실제로 무엇을
 * 가르는 세계와 안 가르는 세계를 같은 코드로 만들어야 둘을 나란히 읽을 수 있다.
 */
function buildWorld(
  skills: number[],
  offsets: Record<string, number>,
  denPerSession: number,
  seed: number,
): World {
  const rand = rng(seed);
  const periods: Period[] = [];
  const bySession = new Map<string, SessionMetrics>();
  const strata = new Map<string, string>();
  const labels = Object.keys(offsets);

  skills.forEach((skill, pi) => {
    const sessionIds: string[] = [];
    // 층마다 같은 수를 넣는다. 층 크기가 구간마다 다르면 층화해도 반쪽의 구성이
    // 안 맞아, 무엇을 재는 실험인지 흐려진다.
    labels.forEach((label) => {
      for (let i = 0; i < 6; i += 1) {
        const sid = `p${pi}${label}${i}`;
        const rate = skill + (offsets[label] as number);
        const axes = emptyAxes();
        axes.readScope = {
          num: binomial(rate, denPerSession, rand),
          den: denPerSession,
        };
        // 캐스트를 붙이지 않는다. `SessionMetrics` 에 필수 항목이 늘면 tsc 가 여기서
        // 막아야 한다. 캐스트로 덮으면 픽스처가 조용히 덜 찬 채로 점수만 틀리게 나온다.
        const metrics: SessionMetrics = {
          sessionId: sid,
          axes,
          extras: emptyExtras(),
          coverage: { observable: 0, offChannel: 0, opaque: 0 },
          capability: { total: 0, mapped: 0, unmapped: {} },
          verifierOutcomeUnknown: 0,
          blockedCalls: 0,
        };
        bySession.set(sid, metrics);
        strata.set(sid, label);
        sessionIds.push(sid);
      }
    });
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

  return { periods, bySession, strata };
}

/** 구간 간 실력 차이는 좁게 둔다. 넓으면 구성 잡음이 묻혀 실험이 성립하지 않는다. */
const SKILLS = Array.from({ length: 26 }, (_, i) => 0.45 + (i / 25) * 0.1);

describe("층화 split-half", () => {
  it("작업 구성이 원인인 세계에서는 층화가 상관을 되살린다", () => {
    // 층 사이 실력차(0.70)가 구간 사이 실력차(0.10)보다 훨씬 크다. 통째로 섞어 가르면
    // 반쪽에 어느 층이 몇 개 들어갔느냐가 구간 차이를 덮는다.
    const w = buildWorld(SKILLS, { a: -0.35, b: 0.35 }, 200, 11);
    const plain = permutedSplitHalf(w.periods, w.bySession, "readScope", 1);
    const stratified = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      1,
      w.strata,
    );
    expect(plain?.median).toBeLessThan(0.3);
    expect(stratified?.median).toBeGreaterThan(0.7);
  });

  it("층이 이름표뿐인 세계에서는 층화가 아무것도 안 올린다", () => {
    // 이 검사가 앞 검사보다 중요하다. 층화가 원인과 무관하게 상관을 올린다면
    // 진단이 아니라 통과시키는 장치다.
    const w = buildWorld(SKILLS, { a: 0, b: 0 }, 200, 12);
    const plain = permutedSplitHalf(w.periods, w.bySession, "readScope", 1);
    const stratified = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      1,
      w.strata,
    );
    expect(plain?.median).toBeGreaterThan(0.7);
    expect(
      Math.abs((stratified?.median ?? 0) - (plain?.median ?? 0)),
    ).toBeLessThan(0.15);
  });

  it("검출하한도 함께 내려간다", () => {
    // 두 반쪽 차이의 95백분위가 검출하한이다. 구성 잡음을 걷어내면 같은 구간을 두 번
    // 재도 덜 갈리므로, 표시할 수 있는 최소 변화폭이 같이 내려가야 앞뒤가 맞는다.
    const w = buildWorld(SKILLS, { a: -0.35, b: 0.35 }, 200, 13);
    const plain = permutedSplitHalf(w.periods, w.bySession, "readScope", 1);
    const stratified = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      1,
      w.strata,
    );
    expect(stratified?.detectionFloor).toBeLessThan(plain?.detectionFloor ?? 1);
  });

  it("시드가 같으면 결과가 같다", () => {
    const w = buildWorld(SKILLS, { a: -0.2, b: 0.2 }, 100, 14);
    const first = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      3,
      w.strata,
    );
    const second = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      3,
      w.strata,
    );
    expect(first?.median).toBe(second?.median);
    expect(first?.detectionFloor).toBe(second?.detectionFloor);
  });

  it("층을 모르는 세션이 섞여도 낸다", () => {
    // 층표에 없는 세션은 자기들끼리 한 층이 된다. 떨어뜨리면 그 세션의 분모가 통째로
    // 사라져 구간 점수가 층화 전후로 다른 것을 재게 된다.
    const w = buildWorld(SKILLS, { a: -0.2, b: 0.2 }, 100, 15);
    const partial = new Map(w.strata);
    for (const sid of [...partial.keys()].slice(0, 40)) partial.delete(sid);
    const d = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      1,
      partial,
    );
    expect(d).not.toBeNull();
    expect(Number.isFinite(d?.median ?? NaN)).toBe(true);
  });

  it("홀수 층이 있어도 순열마다 구성이 흔들리지 않는다", () => {
    // 남는 하나를 매번 난수로 던지면 두 반쪽의 구성이 순열마다 달라지고, 그 하나가
    // 두 반쪽에 반대 부호로 실려 상관이 음수까지 내려간다. 실제로 그렇게 짰다가
    // 이 세계에서 -0.284 가 나왔다. 구성은 고정하고 누가 가느냐만 섞어야 한다.
    const w = buildWorld(SKILLS, { a: 0, b: 0 }, 200, 16);
    // 각 구간에서 한 세션만 따로 떼어 1개짜리 층으로 만들고, 그 세션만 점수를 크게 민다.
    const strata = new Map(w.strata);
    for (const period of w.periods) {
      const odd = period.sessionIds[0] as string;
      strata.set(odd, "solo");
      const m = w.bySession.get(odd) as SessionMetrics;
      m.axes.readScope = { num: 0, den: 200 };
    }
    const d = permutedSplitHalf(w.periods, w.bySession, "readScope", 1, strata);
    // 1개짜리 층은 늘 한쪽에 붙어 두 반쪽에 고정 편차를 남긴다. 상관은 편차에
    // 불변이라 그것만으로는 안 무너진다.
    expect(d?.median).toBeGreaterThan(0.5);
  });
});

/**
 * 위약 층이 대조 구실을 하는가.
 *
 * 층화는 두 반쪽의 작업 구성만 맞추는 것이 아니라 분할 자체를 제약한다. 그 제약만으로
 * 상관이 오른다면 라벨이 아무 뜻이 없어도 오르고, 그러면 "올라감"은 작업 구성의
 * 증거가 아니다. 위약은 층 크기 구성을 그대로 두고 라벨의 뜻만 지운다. 구성이 원인인
 * 세계에서 실제 층화는 오르고 위약은 안 올라야 대조가 성립한다.
 */
describe("위약 층", () => {
  it("구간별 층 크기 구성을 그대로 둔다", () => {
    // 크기가 달라지면 분할 제약까지 같이 바뀌어, 위약이 실제 층화와 다른 것을 잰다.
    const w = buildWorld(SKILLS, { a: -0.2, b: 0.2 }, 100, 21);
    const fake = placeboStrata(w.periods, w.strata, 9973);
    for (const period of w.periods) {
      const count = (s: Strata): string =>
        period.sessionIds
          .map((sid) => s.get(sid) ?? "?")
          .sort()
          .join(",");
      expect(count(fake)).toBe(count(w.strata));
    }
  });

  it("라벨은 실제로 흩어진다", () => {
    // 크기만 맞고 배정이 그대로면 위약이 실제 층화와 같은 것이 되어 대조가 무의미하다.
    const w = buildWorld(SKILLS, { a: -0.2, b: 0.2 }, 100, 22);
    const fake = placeboStrata(w.periods, w.strata, 9973);
    const moved = [...w.strata.keys()].filter(
      (sid) => fake.get(sid) !== w.strata.get(sid),
    );
    expect(moved.length).toBeGreaterThan(0);
  });

  it("시드가 같으면 같다", () => {
    const w = buildWorld(SKILLS, { a: -0.2, b: 0.2 }, 100, 23);
    const first = placeboStrata(w.periods, w.strata, 9973);
    const second = placeboStrata(w.periods, w.strata, 9973);
    for (const sid of first.keys()) {
      expect(second.get(sid)).toBe(first.get(sid));
    }
  });

  it("구성이 원인인 세계에서 실제 층화만 오르고 위약은 안 오른다", () => {
    // 이 검사가 위약을 붙인 이유 전부다. 위약도 같이 오르면 그 이동은 라벨이 아니라
    // 분할 기하학이 만든 것이고, 층화 결과를 작업 구성의 증거로 읽을 수 없다.
    const w = buildWorld(SKILLS, { a: -0.35, b: 0.35 }, 200, 24);
    const plain = permutedSplitHalf(w.periods, w.bySession, "readScope", 1);
    const real = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      1,
      w.strata,
    );
    const fake = permutedSplitHalf(
      w.periods,
      w.bySession,
      "readScope",
      1,
      placeboStrata(w.periods, w.strata, 9973),
    );
    expect(plain?.median).toBeLessThan(0.3);
    expect(real?.median).toBeGreaterThan(0.7);
    // 위약은 층화 전과 같은 자리에 머문다.
    expect(Math.abs((fake?.median ?? 0) - (plain?.median ?? 0))).toBeLessThan(
      0.15,
    );
  });
});
