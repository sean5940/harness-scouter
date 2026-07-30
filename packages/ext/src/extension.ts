import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

const run = promisify(execFile);

/** CLI가 내는 JSON. 확장은 이 모양만 알면 되고 지표 계산은 모른다. */
interface AxisDelta {
  key: string;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  denominator: number;
  unfilled: boolean;
}

interface PeriodReport {
  period: {
    index: number;
    sessionIds: string[];
    startedAt: string;
    endedAt: string;
    open: boolean;
    closedByBudget: boolean;
    unfilledAxes: string[];
  };
  coverage: number | null;
  axes: AxisDelta[];
}

interface DiagnosisItem {
  subject: string;
  count: number;
  sessions: string[];
}

interface Diagnosis {
  axis: string;
  headline: string;
  items: DiagnosisItem[];
}

interface ScouterJson {
  axisLabels: Record<string, string>;
  periodCount: number;
  latestClosed: PeriodReport | null;
  latest: PeriodReport | null;
  diagnoses?: Diagnosis[];
  leakCount?: number;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("harnessScouter");
}

/**
 * CLI dist 경로를 찾는다.
 *
 * 설정이 비어 있으면 이 확장이 모노레포 안에 있다고 보고 형제 패키지를 가리킨다.
 * 확장만 따로 설치한 경우에는 설정을 채워야 한다.
 */
function resolveCliPath(context: vscode.ExtensionContext): string | null {
  const configured = config().get<string>("cliPath", "").trim();
  if (configured !== "") return configured;
  const sibling = join(context.extensionPath, "..", "cli", "dist", "index.js");
  return existsSync(sibling) ? sibling : null;
}

function dbArgs(): string[] {
  const configured = config().get<string>("dbPath", "").trim();
  return configured === "" ? [] : ["--db", configured];
}

/**
 * CLI를 자식 프로세스로 돌린다.
 *
 * Extension Host에서 직접 파싱하면 900MB를 읽는 동안 VSCode 전체가 멈춘다.
 * 지표 계산이 확장 코드로 넘어오지 않게 하는 경계이기도 하다.
 */
async function callCli(
  context: vscode.ExtensionContext,
  args: string[],
): Promise<string> {
  const cli = resolveCliPath(context);
  if (cli === null) {
    throw new Error(
      "CLI를 찾지 못했습니다. harnessScouter.cliPath 설정을 채우세요.",
    );
  }
  const node = config().get<string>("nodePath", "node");
  const { stdout } = await run(
    node,
    ["--no-warnings", cli, ...args, ...dbArgs()],
    {
      maxBuffer: 32 * 1024 * 1024,
      cwd: homedir(),
    },
  );
  return stdout;
}

/**
 * 상태바는 누수 건수만 보여준다.
 *
 * 축 점수와 delta를 띄우지 않는 이유는 M0.5 게이트에서 축의 구간 간 안정성이 없다는
 * 것이 확인됐기 때문이다(설계 8.1). 잡음을 화살표로 그리면 없는 개선을 읽게 된다.
 */
function formatStatus(json: ScouterJson): string {
  const report = json.latestClosed;
  if (report === null) return "$(telescope) Scouter: 스캔 필요";
  const leaks = json.leakCount ?? 0;
  const cov = report.coverage;
  const covText = cov === null ? "" : ` · 커버리지 ${(cov * 100).toFixed(0)}%`;
  return `$(telescope) 누수 ${leaks}건${covText}`;
}

function statusTooltip(json: ScouterJson): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const report = json.latestClosed;
  if (report === null) {
    md.appendMarkdown("아직 닫힌 구간이 없습니다. 스캔을 먼저 돌리세요.");
    return md;
  }
  md.appendMarkdown(
    `**구간 #${report.period.index}** · 세션 ${report.period.sessionIds.length}개\n\n`,
  );
  for (const d of json.diagnoses ?? []) {
    const total = d.items.reduce((sum, i) => sum + i.count, 0);
    if (total === 0) continue;
    const label = json.axisLabels[d.axis] ?? d.axis;
    md.appendMarkdown(`- ${label}: ${total}건 (${d.headline})\n`);
  }
  md.appendMarkdown("\n클릭하면 근거 파일과 세션을 봅니다.");
  return md;
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.command = "harnessScouter.showPanel";
  status.text = "$(telescope) Scouter";
  status.show();
  context.subscriptions.push(status);

  let panel: vscode.WebviewPanel | undefined;

  const refreshStatus = async (): Promise<void> => {
    try {
      const json = JSON.parse(await callCli(context, ["json"])) as ScouterJson;
      status.text = formatStatus(json);
      status.tooltip = statusTooltip(json);
    } catch (error) {
      status.text = "$(telescope) Scouter: 오류";
      status.tooltip = error instanceof Error ? error.message : String(error);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("harnessScouter.scan", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Harness Scouter 스캔 중",
        },
        async () => {
          try {
            const out = await callCli(context, ["scan"]);
            vscode.window.showInformationMessage(
              out.trim().split("\n")[0] ?? "완료",
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `스캔 실패: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      );
      await refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("harnessScouter.showPanel", async () => {
      if (panel === undefined) {
        panel = vscode.window.createWebviewPanel(
          "harnessScouter",
          "Harness Scouter",
          vscode.ViewColumn.Beside,
          { enableScripts: false, retainContextWhenHidden: true },
        );
        panel.onDidDispose(() => {
          panel = undefined;
        });
      }
      try {
        // CLI가 외부 리소스 없는 단일 파일 HTML을 내므로 Webview CSP를 그대로 통과한다.
        panel.webview.html = await callCli(context, [
          "html",
          "--out",
          "/dev/stdout",
        ]);
      } catch (error) {
        panel.webview.html = `<body style="font-family:sans-serif;padding:20px">리포트를 만들지 못했습니다.<br><code>${
          error instanceof Error ? error.message : String(error)
        }</code></body>`;
      }
      panel.reveal(vscode.ViewColumn.Beside);
    }),
  );

  void refreshStatus();
  if (config().get<boolean>("scanOnStartup", false)) {
    void vscode.commands.executeCommand("harnessScouter.scan");
  }
}

export function deactivate(): void {
  // 상태바와 패널은 subscriptions로 정리된다.
}
