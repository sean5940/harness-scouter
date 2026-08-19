import { describe, expect, it } from "vitest";

import { classifyBash } from "../src/definitions.js";

/**
 * 검증 판정의 no-op 가드.
 *
 * `npx tsc --version`은 tsc를 부르지만 아무것도 검증하지 않는다. 이걸 검증으로 세면
 * 커밋 앞에 한 줄 접합하는 것만으로 "커밋 전 검증 신선도"가 만점이 된다. 재현성
 * 게이트가 이 경로로 축이 28.6에서 100까지 밀린다고 잡아냈다.
 *
 * 반대로 규칙이 넓으면 진짜 검증이 빠진다. 조용히 통과하는 tsc는 출력이 아예 없어서
 * 출력으로는 못 가른다. 그래서 명령 모양으로만 가른다.
 */
describe("아무것도 검증하지 않는 호출은 검증이 아니다", () => {
  it("버전 조회는 검증이 아니다", () => {
    expect(classifyBash("npx tsc --version").verifierKinds).toEqual([]);
    expect(classifyBash("npx eslint --version").verifierKinds).toEqual([]);
    expect(classifyBash("npx vitest -v").verifierKinds).toEqual([]);
  });

  it("도움말 조회는 검증이 아니다", () => {
    expect(classifyBash("npx tsc --help").verifierKinds).toEqual([]);
    expect(classifyBash("npx eslint -h").verifierKinds).toEqual([]);
  });

  it("진짜 검증은 그대로 검증이다", () => {
    expect(classifyBash("npx tsc --noEmit").verifierKinds).toContain("tsc");
    expect(classifyBash("npx eslint app/").verifierKinds).toContain("eslint");
    expect(classifyBash("npm run typecheck").verifierKinds).toContain("tsc");
    expect(classifyBash("npx vitest run").verifierKinds).toContain("test");
  });

  it("인자 없는 호출은 검증으로 남긴다", () => {
    // `npx tsc` 단독은 프로젝트 설정으로 실제 컴파일을 돈다.
    expect(classifyBash("npx tsc").verifierKinds).toContain("tsc");
  });

  it("버전 조회를 커밋에 접합해도 검증이 붙지 않는다", () => {
    // 게이트가 지목한 실제 조작 형태.
    expect(
      classifyBash("npx tsc --version; git commit -m x").verifierKinds,
    ).toEqual([]);
  });
});
