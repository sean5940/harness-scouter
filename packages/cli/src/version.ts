/**
 * 배포 버전.
 *
 * 단일 실행파일 안에서는 package.json 을 읽을 수 없어 상수로 둔다. 사본이 둘이 되므로
 * package.json 과 어긋나지 않는지 version.test.ts 가 지킨다.
 *
 * index.ts 가 아니라 이 파일에 두는 이유는 테스트가 CLI 진입점을 import 하면 node:sqlite
 * 까지 딸려와 vitest 가 모듈을 못 풀기 때문이다. 상수 하나를 확인하려고 DB 계층 전체를
 * 끌어올 이유가 없다.
 */
export const VERSION = "0.1.0";
