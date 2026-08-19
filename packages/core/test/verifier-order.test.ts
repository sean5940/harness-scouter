import { describe, expect, it } from "vitest";

import { classifyBash } from "../src/definitions.js";

/**
 * 한 호출 안에서 검증이 커밋보다 앞섰는지.
 *
 * classifyBash 는 세그먼트를 순서대로 훑고도 결과를 boolean 으로 접어버려서,
 * `git commit && npx tsc` 와 `npx tsc && git commit` 이 구분되지 않았다. metrics.ts 가
 * 같은 order 에서 verifier 를 커밋보다 먼저 처리하므로, 커밋 뒤에 돈 검증도 앞선 것으로
 * 잡혀 신선도가 올랐다. 검증 횟수도 시점도 그대로인데 순서만 바꿔서 오르는 경로다.
 */
describe("검증이 커밋보다 앞섰는지 구분한다", () => {
  it("검증 뒤 커밋은 앞선 것으로 본다", () => {
    const c = classifyBash("npx tsc --noEmit && git commit -m x");
    expect(c.isCommit).toBe(true);
    expect(c.hasVerifierBeforeCommit).toBe(true);
  });

  it("커밋 뒤 검증은 앞선 것이 아니다", () => {
    const c = classifyBash("git commit -m x && npx tsc --noEmit");
    expect(c.isCommit).toBe(true);
    expect(c.verifierKinds).toContain("tsc");
    expect(c.hasVerifierBeforeCommit).toBe(false);
  });

  it("앞뒤로 하나씩이면 앞선 것이 있다", () => {
    const c = classifyBash(
      "npx tsc --noEmit && git commit -m x && npx eslint app/",
    );
    expect(c.hasVerifierBeforeCommit).toBe(true);
    // 공회전 판정은 실행 횟수를 그대로 세야 하므로 뒤엣것도 남는다.
    expect(c.verifierKinds).toHaveLength(2);
  });

  it("커밋이 없으면 앞섰다고 하지 않는다", () => {
    // 커밋이 없는 호출에서는 이 값을 쓰지 않는다. 기본값이 참이면 오독을 부른다.
    const c = classifyBash("npx tsc --noEmit");
    expect(c.isCommit).toBe(false);
    expect(c.hasVerifierBeforeCommit).toBe(false);
  });

  it("세미콜론으로 이어도 순서를 본다", () => {
    expect(
      classifyBash("git commit -m x; npx tsc --noEmit").hasVerifierBeforeCommit,
    ).toBe(false);
    expect(
      classifyBash("npx tsc --noEmit; git commit -m x").hasVerifierBeforeCommit,
    ).toBe(true);
  });
});
