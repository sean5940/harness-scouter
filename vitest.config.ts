import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * `node:sqlite`는 Node 22.5에 들어온 빌트인이라 이 vite 버전의 내장 목록에 없다.
 * 그대로 두면 `sqlite` 패키지를 찾다가 실패해서 db.ts를 import하는 테스트가
 * 수집조차 되지 않는다. `external`은 vite-node 로더가 무시하므로, 빌트인을
 * `createRequire`로 다시 꺼내주는 파일로 별칭을 건다.
 */
export default defineConfig({
  test: {
    alias: {
      "node:sqlite": fileURLToPath(
        new URL("./packages/core/test/support/node-sqlite.ts", import.meta.url),
      ),
    },
  },
});
