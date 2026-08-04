import { describe, expect, it } from "vitest";
import {
  decomposeVariance,
  denominatorForReliability,
  reliabilityAt,
  signalToNoise,
  type RatioObservation,
} from "./variance.js";

/**
 * 분산 분해는 합성 데이터로만 검증할 수 있다.
 *
 * 실제 코퍼스에 돌려 나온 숫자가 그럴듯해 보이는 것은 검증이 아니다. 참값을 아는 데이터를
 * 만들어 그것을 되찾는지 봐야 한다. 여기서 만드는 두 세계는 다음과 같다.
 *
 *   순수 잡음  모든 관측이 같은 참비율에서 나왔다. 참분산이 0 이어야 한다.
 *   진짜 차이  관측마다 참비율이 다르다. 그 차이를 되찾아야 한다.
 */

/** 시드 고정 난수. 테스트가 실행마다 갈리면 안 된다. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 참비율 p 인 이항 표본. */
function binomial(p: number, n: number, rand: () => number): number {
  let k = 0;
  for (let i = 0; i < n; i += 1) if (rand() < p) k += 1;
  return k;
}

describe("순수 잡음 세계", () => {
  // 모든 관측이 같은 참비율에서 나왔다. 흔들림은 전부 표본 크기 탓이다.
  const rand = rng(42);
  const observations: RatioObservation[] = Array.from({ length: 200 }, () => {
    const den = 20 + Math.floor(rand() * 60);
    return { num: binomial(0.6, den, rand), den };
  });
  const v = decomposeVariance(observations);

  it("참비율을 되찾는다", () => {
    expect(v?.mean).toBeCloseTo(0.6, 1);
  });

  it("참분산이 0 근처다", () => {
    // 정확히 0 은 아니다. 유한 표본이라 추정 오차가 남는다.
    expect(Math.abs(v?.trueVariance ?? 1)).toBeLessThan(0.005);
  });

  it("신호 대 잡음이 낮다", () => {
    expect(signalToNoise(v!)).toBeLessThan(0.5);
  });

  it("분모를 키워도 소용없다는 것이 나온다", () => {
    // 참분산이 0 이하면 어떤 분모로도 신뢰도가 안 오른다.
    if ((v?.trueVariance ?? 0) <= 0) {
      expect(v?.halfReliabilityDenominator).toBeNull();
      expect(reliabilityAt(v!, 1000)).toBeNull();
    }
  });
});

describe("진짜 차이가 있는 세계", () => {
  // 관측마다 참비율이 다르다. 그 차이를 되찾아야 한다.
  const rand = rng(7);
  const trueSd = 0.15;
  const observations: RatioObservation[] = Array.from({ length: 200 }, () => {
    // 0.6 을 중심으로 참비율이 흩어진다.
    const p = Math.min(
      0.95,
      Math.max(0.05, 0.6 + (rand() - 0.5) * trueSd * 3.46),
    );
    const den = 20 + Math.floor(rand() * 60);
    return { num: binomial(p, den, rand), den };
  });
  const v = decomposeVariance(observations);

  it("참분산이 양수로 나온다", () => {
    expect(v?.trueVariance).toBeGreaterThan(0);
  });

  it("참 표준편차를 대략 되찾는다", () => {
    // 적률법은 정밀 추정이 아니다. 자릿수가 맞으면 된다.
    expect(Math.sqrt(v?.trueVariance ?? 0)).toBeGreaterThan(trueSd * 0.5);
    expect(Math.sqrt(v?.trueVariance ?? 0)).toBeLessThan(trueSd * 1.8);
  });

  it("신호 대 잡음이 순수 잡음 세계보다 크다", () => {
    expect(signalToNoise(v!)).toBeGreaterThan(1);
  });

  it("목표 신뢰도에 필요한 분모를 낸다", () => {
    const n80 = denominatorForReliability(v!, 0.8);
    const n50 = denominatorForReliability(v!, 0.5);
    expect(n80).toBeGreaterThan(n50!);
    // 0.5 에 필요한 분모가 곧 k 다.
    expect(n50).toBe(Math.ceil(v!.halfReliabilityDenominator!));
  });

  it("분모가 클수록 신뢰도가 오른다", () => {
    const a = reliabilityAt(v!, 10)!;
    const b = reliabilityAt(v!, 100)!;
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
  });
});

describe("경계", () => {
  it("관측이 적으면 내지 않는다", () => {
    expect(decomposeVariance([{ num: 1, den: 2 }])).toBeNull();
    expect(decomposeVariance([])).toBeNull();
  });

  it("분모 0 인 관측은 뺀다", () => {
    const v = decomposeVariance([
      { num: 0, den: 0 },
      { num: 5, den: 10 },
      { num: 6, den: 10 },
      { num: 4, den: 10 },
    ]);
    expect(v?.observations).toBe(3);
  });

  it("전부 같은 값이면 관측 분산이 0 이다", () => {
    const v = decomposeVariance([
      { num: 5, den: 10 },
      { num: 5, den: 10 },
      { num: 5, den: 10 },
    ]);
    expect(v?.observedVariance).toBe(0);
    // 관측이 이항잡음보다 덜 흔들렸다. 참분산이 음수로 나오는 것이 정상이다.
    expect(v?.trueVariance).toBeLessThan(0);
    expect(v?.halfReliabilityDenominator).toBeNull();
  });
});
