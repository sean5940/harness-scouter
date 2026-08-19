import { createRequire } from "node:module";

/**
 * `node:sqlite` 우회 로더.
 *
 * 이 vite 버전은 `node:sqlite`(Node 22.5 빌트인)를 모르는 패키지로 보고 해석에
 * 실패한다. `external`로 빼도 vite-node 로더가 그대로 읽으려 들어서, 테스트에서만
 * 이 파일로 별칭을 걸어 `createRequire`로 런타임에 직접 가져온다.
 */
const nodeRequire = createRequire(import.meta.url);

const sqlite = nodeRequire("node:sqlite") as {
  DatabaseSync: unknown;
};

export const DatabaseSync = sqlite.DatabaseSync;
