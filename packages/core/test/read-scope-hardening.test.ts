import { describe, expect, it } from "vitest";

import { isEffectivePartialRead } from "../src/definitions.js";

/**
 * 축1 부분읽기 판정의 조작 저항.
 *
 * 시작 줄이 1이 아니라는 것만으로 부분읽기를 인정하면, 훅으로 `offset: 2`를 끼워넣는
 * 것만으로 축이 만점이 된다. 파일의 99%를 읽고도 부분읽기가 되기 때문이다.
 * 재현성 게이트의 "상한 도달 불가"가 이 경로로 66.7에서 100까지 밀린다고 잡아냈다.
 *
 * 판정은 요청 인자가 아니라 실제로 읽은 범위가 파일의 어느 만큼인지로 한다.
 * 임계는 관측에서 왔다. 2026-08-19 코퍼스의 200줄 초과 Read 중 커버리지 1.0이
 * 251건이고, 그 아래 가장 높은 값이 0.72다. 1.0과 0.72 사이가 비어 있어 그 구간
 * 어디를 잘라도 진짜 부분읽기는 하나도 안 잃는다.
 */
describe("부분읽기 판정이 offset 주입에 넘어가지 않는다", () => {
  it("offset만 1 밀어도 거의 전체를 읽었으면 부분읽기가 아니다", () => {
    // 300줄 파일의 2번째 줄부터 끝까지. 커버리지 0.997.
    expect(isEffectivePartialRead(300, 299, 2)).toBe(false);
  });

  it("limit 기본값(2000)을 명시한 전체읽기도 부분읽기가 아니다", () => {
    expect(isEffectivePartialRead(1500, 1500, 1)).toBe(false);
  });

  it("관측된 진짜 부분읽기는 그대로 부분읽기다", () => {
    // 코퍼스에서 실제로 나온 커버리지 상한(0.72)과 중앙 부근.
    expect(isEffectivePartialRead(300, 216, 1)).toBe(true);
    expect(isEffectivePartialRead(300, 150, 100)).toBe(true);
    expect(isEffectivePartialRead(1000, 50, 400)).toBe(true);
  });

  it("총 줄수를 모르면 판정하지 않는다", () => {
    // 모르는 것을 부분읽기로 세면 분자가 근거 없이 늘어난다.
    expect(isEffectivePartialRead(null, 10, 1)).toBe(false);
  });

  it("읽은 줄수가 총 줄수를 넘어도 전체읽기로 본다", () => {
    // 결과 메타가 어긋나는 경우가 있는데, 그때 부분읽기로 세면 조작 경로가 다시 열린다.
    expect(isEffectivePartialRead(200, 250, 1)).toBe(false);
  });
});
