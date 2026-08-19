import { describe, expect, it } from "vitest";

import {
  lengthConfoundVerdict,
  MIN_PERIODS_FOR_LENGTH_PASS,
  MIN_PERIODS_FOR_LENGTH_REJECT,
} from "../src/gate.js";

/**
 * 길이 교란 판정의 아는 답이 있는 세계.
 *
 * 초판은 rho 하나를 임계와 견주었다. 구간이 5개뿐이면 그 검정은 아무것도 못 가른다.
 * 귀무가설(교란 없음)에서 |rho| >= 0.5 가 나올 확률을 순열 전수로 세어 보면
 * n=5 에서 0.450 이다. 6축이면 교란이 하나도 없어도 2.7 개가 미달로 찍힌다.
 * 실제로 4개가 찍혀 있었고, 그것은 신호가 아니라 표본 부족이었다.
 *
 * 귀무 분포(전수 열거, 2026-08-19):
 *   n     4     5     6     7     8     9    10    12    14    16
 *   P  .417  .450  .297  .267  .216  .178  .143  .098  .070  .051
 *
 * 그래서 원인이 있는 세계와 없는 세계를 따로 만들고, 앞에서만 미달이 나오는지 본다.
 * 실측 숫자가 좋아지는 것은 검증이 아니다.
 */

/** 세션 수가 늘면 점수도 따라 오르는 세계. 진짜 교란이다. */
function confoundedWorld(n: number): { scores: number[]; sizes: number[] } {
  const sizes: number[] = [];
  const scores: number[] = [];
  for (let i = 0; i < n; i += 1) {
    sizes.push(10 + i * 3);
    scores.push(20 + i * 4);
  }
  return { scores, sizes };
}

/**
 * 세션 수와 점수가 무관한 세계.
 *
 * 점수를 톱니로 두어 크기 순서와 어긋나게 한다. 난수를 쓰면 세계마다 rho 가 흔들려
 * "앞에서만 반응한다"를 못 보인다.
 */
function cleanWorld(n: number): { scores: number[]; sizes: number[] } {
  const sizes: number[] = [];
  const scores: number[] = [];
  for (let i = 0; i < n; i += 1) {
    sizes.push(10 + i * 3);
    scores.push(i % 2 === 0 ? 40 + (i % 5) : 60 - (i % 5));
  }
  return { scores, sizes };
}

describe("길이 교란은 표본이 받쳐줄 때만 판정한다", () => {
  it("교란이 있고 구간이 충분하면 미달이다", () => {
    const w = confoundedWorld(MIN_PERIODS_FOR_LENGTH_PASS + 2);
    const got = lengthConfoundVerdict(w.scores, w.sizes);
    expect(got.verdict).toBe("fail");
    expect(Math.abs(got.rho)).toBeGreaterThanOrEqual(0.5);
    expect(got.p).toBeLessThan(0.05);
  });

  it("교란이 없고 구간이 충분하면 통과다", () => {
    const w = cleanWorld(MIN_PERIODS_FOR_LENGTH_PASS + 2);
    const got = lengthConfoundVerdict(w.scores, w.sizes);
    expect(got.verdict).toBe("pass");
    expect(Math.abs(got.rho)).toBeLessThan(0.5);
  });

  it("같은 교란이라도 구간이 모자라면 판정하지 않는다", () => {
    // 지금 코퍼스의 상태다. rho 는 크게 나오는데 우연으로도 그만큼 나온다.
    const got = lengthConfoundVerdict(
      [30, 55, 40, 70, 60],
      [10, 13, 16, 19, 22],
    );
    expect(got.verdict).toBe("not-computable");
  });

  it("구간이 모자라면 상관이 작아도 통과로 세지 않는다", () => {
    // 통과로 세면 "교란 없음" 을 근거 없이 주장하게 된다. 재보지 못한 것은 통과가 아니다.
    const got = lengthConfoundVerdict(
      [50, 50.1, 49.9, 50.2, 49.8],
      [10, 13, 16, 19, 22],
    );
    expect(got.verdict).toBe("not-computable");
  });

  it("어떤 값이 나와도 기각할 수 없는 크기면 판정하지 않는다", () => {
    // n=4 는 완전 단조여도 양측 최소 p 가 2/24 = 0.083 이라 0.05 를 못 넘는다.
    const n = MIN_PERIODS_FOR_LENGTH_REJECT - 1;
    const w = confoundedWorld(n);
    expect(lengthConfoundVerdict(w.scores, w.sizes).verdict).toBe(
      "not-computable",
    );
  });

  it("완전 단조는 구간이 적어도 미달로 잡는다", () => {
    // 5구간 전부가 순서대로 오르는 것은 우연으로 설명되지 않는다(p = 2/120).
    const w = confoundedWorld(MIN_PERIODS_FOR_LENGTH_REJECT);
    const got = lengthConfoundVerdict(w.scores, w.sizes);
    expect(got.verdict).toBe("fail");
  });

  it("상수열은 판정하지 않는다", () => {
    // rho 가 NaN 이다. 그것은 독립의 근거가 아니다.
    const got = lengthConfoundVerdict(
      [50, 50, 50, 50, 50],
      [10, 13, 16, 19, 22],
    );
    expect(got.verdict).toBe("not-computable");
  });

  it("같은 입력에 같은 판정을 낸다", () => {
    const w = confoundedWorld(MIN_PERIODS_FOR_LENGTH_PASS + 2);
    const a = lengthConfoundVerdict(w.scores, w.sizes);
    const b = lengthConfoundVerdict(w.scores, w.sizes);
    expect(a).toEqual(b);
  });
});
