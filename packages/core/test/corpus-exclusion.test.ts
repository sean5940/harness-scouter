import { describe, expect, it } from "vitest";

import { isSyntheticWorkspace } from "../src/definitions.js";

/**
 * 코퍼스 제외 규칙.
 *
 * 하네스를 재려고 돌린 ablation·eval 실행이 에이전트 임시 워크스페이스에서 일어난다.
 * 그것까지 세면 하네스 품질 대신 "하네스를 재는 실행"의 품질이 섞인다. 반대로 규칙이
 * 넓으면 진짜 작업까지 빠지므로, 경계를 여기에 고정한다.
 */
describe("임시 워크스페이스만 코퍼스에서 뺀다", () => {
  it("에이전트 스크래치패드를 뺀다", () => {
    expect(
      isSyntheticWorkspace(
        "/private/tmp/claude-502/-Users-x-Source-app/abcd/scratchpad",
      ),
    ).toBe(true);
    expect(
      isSyntheticWorkspace(
        "/tmp/claude-1000/-Users-x-Source-app/ef/scratchpad",
      ),
    ).toBe(true);
  });

  it("진짜 작업 경로는 남긴다", () => {
    expect(
      isSyntheticWorkspace("/Users/sean.jung/Source/soomgo-mobile-app"),
    ).toBe(false);
    expect(isSyntheticWorkspace("/Users/sean.jung/Source/wt-MG-3660")).toBe(
      false,
    );
    // 워크트리는 임시 디렉토리처럼 생겼어도 진짜 작업이다.
    expect(isSyntheticWorkspace("/Users/sean.jung/tmp/my-project")).toBe(false);
  });

  it("cwd를 모르면 빼지 않는다", () => {
    // 판정 근거가 없을 때 빼면 파싱 결손이 조용한 제외로 바뀐다.
    expect(isSyntheticWorkspace(null)).toBe(false);
  });

  it("claude 뒤에 숫자가 없는 임시 경로는 대상이 아니다", () => {
    // 사용자가 직접 만든 /tmp/claude-notes 같은 디렉토리까지 빨아들이지 않는다.
    expect(isSyntheticWorkspace("/tmp/claude-notes/draft")).toBe(false);
  });
});
