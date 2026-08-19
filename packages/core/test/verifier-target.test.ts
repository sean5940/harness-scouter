import { describe, expect, it } from "vitest";

import { classifyBash } from "../src/definitions.js";

/**
 * 검증이 무엇을 겨눴는지.
 *
 * metrics 는 verifier 의 순서만 보고 대상을 안 봤다. 그래서 50개를 고치고 무관한
 * 파일 하나에 검증을 돌려도 신선한 것으로 잡혔다. 재현성 게이트가 이 경로로 축이
 * 28.6 에서 100 까지 밀린다고 잡아냈다.
 *
 * 대상이 비면 프로젝트 전체를 본 것이라 무엇을 고쳤든 덮는다. 대상이 있으면 그 아래만
 * 본 것이다. 이 구분을 못 하면 좁은 검증과 전체 검증이 같은 값을 받는다.
 */
describe("검증 대상 경로를 뽑는다", () => {
  it("프로젝트 전체 검증은 대상이 비어 있다", () => {
    expect(classifyBash("npx tsc --noEmit").verifierTargets).toEqual([]);
    expect(classifyBash("npm run typecheck").verifierTargets).toEqual([]);
    expect(classifyBash("npx vitest run").verifierTargets).toEqual([]);
    expect(classifyBash("npm test").verifierTargets).toEqual([]);
  });

  it("경로를 준 검증은 그 경로를 낸다", () => {
    expect(
      classifyBash("npx eslint app/screens/membership").verifierTargets,
    ).toEqual(["app/screens/membership"]);
    expect(
      classifyBash("npx vitest run packages/core/test/db.test.ts")
        .verifierTargets,
    ).toEqual(["packages/core/test/db.test.ts"]);
  });

  it("스크립트 이름을 경로로 착각하지 않는다", () => {
    // `typecheck`·`test` 는 npm 스크립트지 파일이 아니다. 이걸 대상으로 세면
    // 프로젝트 전체 검증이 좁은 검증으로 뒤집힌다.
    expect(classifyBash("npm run test:unit").verifierTargets).toEqual([]);
    expect(classifyBash("yarn lint").verifierTargets).toEqual([]);
  });

  it("플래그와 플래그 값을 경로로 세지 않는다", () => {
    expect(
      classifyBash("npx tsc --noEmit --project .").verifierTargets,
    ).toEqual([]);
    expect(
      classifyBash("npx vitest run -c vitest.debug.config.ts").verifierTargets,
    ).toEqual([]);
  });

  it("글롭도 대상이다", () => {
    expect(classifyBash("npx eslint 'app/**/*.tsx'").verifierTargets).toEqual([
      "app/**/*.tsx",
    ]);
  });

  it("리다이렉트와 파이프 뒤는 대상이 아니다", () => {
    // `> /tmp/out.txt` 의 out.txt 를 검증 대상으로 세면 전체 검증이 좁은 검증이 된다.
    expect(
      classifyBash("npx tsc --noEmit > /tmp/out.txt").verifierTargets,
    ).toEqual([]);
    expect(
      classifyBash("npm run typecheck 2>&1 | grep -c 'error TS'")
        .verifierTargets,
    ).toEqual([]);
  });

  it("다른 디렉토리로 옮겨 돌린 검증은 그 디렉토리를 대상으로 낸다", () => {
    // 코퍼스에 실재하는 형태다. cd 대상을 버리면 다른 저장소를 검증하고도 전체 검증으로
    // 잡혀, 지금 고친 트리와 무관한 실행이 신선도를 준다.
    expect(
      classifyBash("cd ~/Source/rn-preview && npx vitest run").verifierTargets,
    ).toEqual(["~/Source/rn-preview"]);
  });

  it("검증이 아닌 호출은 대상이 비어 있다", () => {
    expect(classifyBash("git commit -m x").verifierTargets).toEqual([]);
    expect(classifyBash("npx tsc --version").verifierTargets).toEqual([]);
  });
});
