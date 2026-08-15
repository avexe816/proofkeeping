/**
 * `pnpm loadtest` の実体。負荷試験（PK-SPEC-P7 §4.2 / P7-12）。
 *
 * task:  docs/tasks/P7-12.md
 * ルール: .claude/rules/testing.md
 *
 * ── 使い方 ──────────────────────────────────────────────
 *   pnpm loadtest --base https://pk-staging.example --scenario A --dry-run
 *     何を叩くかだけ出す。**触らない。**
 *
 *   pnpm loadtest --base https://pk-staging.example --scenario A --cookie "pk_session=..."
 *     シナリオ A を実行する。
 *
 *   pnpm loadtest --base ... --cookie ... --scenario all
 *     4 シナリオを順に実行し、1 つでも落ちたら終了コード 1。
 *
 * ── 本番へ向けない ──────────────────────────────────────
 * **`--base` が production を指していたら実行しない。** B・C・D は
 * 書き込みを含む（タスク完了・照合の起動・請求書の発行）。
 * 顧客のデータに 3,000 件の完了を書き込む事故を、引数の打ち間違いで
 * 起こさせない。
 *
 * ── 既定は `--dry-run` ──────────────────────────────────
 * `shards:move` と同じ向き。引数を付け忘れた実行が触らない側へ落ちる。
 *
 * ── 判定そのものはここに書かない ────────────────────────
 * 目標値と合否は `scripts/loadTest/scenarios.ts`（純粋・テスト済み）。
 * ここは叩いて時間を測るだけ。
 *
 * ── これだけでは §4.2 MUST を満たさない ─────────────────
 * **1 台の node から 3,000 並列を出しても、測っているのは自分の
 * イベントループになる。** 目標値の判定に使うなら、分散した負荷生成
 * （複数リージョン・複数プロセス）から回すこと。
 * モバイル初回表示（4G）は**実機で測る**（testing.md §6）。
 */

import {
  SCENARIOS,
  SCENARIO_IDS,
  allScenariosPass,
  evaluateScenario,
  summarize,
  type Scenario,
  type ScenarioId,
  type ScenarioVerdict,
} from "./loadTest/scenarios.ts";

/**
 * 本番と読めるホスト名の印。**含まれていたら実行しない。**
 *
 * 完全一致にしないのは、本番のホスト名がこのリポジトリに書かれていない
 * ため（`wrangler.toml` の `env.production` は Worker 名だけを持つ）。
 * **広めに弾く。** 検証環境の名前がたまたま引っ掛かるほうが、
 * 顧客のデータに 3,000 件の完了を書き込むより安い。
 */
const PRODUCTION_HOST_MARKERS = ["pk-prod", "production", "proofkeeping.jp", "prod."] as const;

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

interface Options {
  base: string;
  cookie: string | undefined;
  scenarios: ScenarioId[];
  dryRun: boolean;
  businessDate: string;
}

function parseArgs(argv: string[]): Options {
  const base = argValue(argv, "--base");
  if (base === undefined || base.length === 0) throw new Error("--base <url> is required");

  // **本番へ向けない**（冒頭の注記）。書き込みを含むシナリオがある。
  //
  // **ホスト名で見る。** URL 全体に対して部分一致を掛けると、
  // パスやクエリに `staging` が入っただけで通ってしまう／
  // 逆に `https://pk-prod...` の `/` が邪魔で弾けない、といった
  // 取り違えが起きる（実際に一度そうなった）。
  let hostname: string;
  try {
    hostname = new URL(base).hostname.toLowerCase();
  } catch {
    throw new Error(`--base is not a URL: ${base}`);
  }
  if (PRODUCTION_HOST_MARKERS.some((marker) => hostname.includes(marker))) {
    throw new Error(`refusing to run against production: ${hostname}`);
  }

  const raw = argValue(argv, "--scenario") ?? "all";
  const scenarios =
    raw === "all"
      ? [...SCENARIO_IDS]
      : raw
          .split(",")
          .map((value) => value.trim().toUpperCase())
          .filter((value): value is ScenarioId =>
            (SCENARIO_IDS as readonly string[]).includes(value),
          );
  if (scenarios.length === 0) throw new Error(`unknown --scenario: ${raw}`);

  return {
    base: base.replace(/\/$/, ""),
    cookie: argValue(argv, "--cookie"),
    scenarios,
    // **`--run` を明示しない限り触らない。**
    dryRun: !argv.includes("--run"),
    businessDate: argValue(argv, "--business-date") ?? new Date().toISOString().slice(0, 10),
  };
}

/** 経路の `{...}` を埋める。**埋まらない鍵が残っていたら実行しない。** */
function resolvePath(path: string, options: Options): string {
  const resolved = path.replaceAll("{businessDate}", options.businessDate);
  if (/\{[a-zA-Z]+\}/.test(resolved)) {
    throw new Error(`path still has placeholders: ${resolved}（--dry-run で確認すること）`);
  }
  return resolved;
}

/** 1 回叩いて所要時間を返す。**落ちたら `null`。** */
async function measure(url: string, cookie: string | undefined): Promise<number | null> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(cookie === undefined ? {} : { Cookie: cookie }),
      },
    });
    // **2xx 以外はエラーとして数える。** 401 が速く返るのを
    // 「速い」と報告しないため。
    if (!response.ok) return null;
    await response.arrayBuffer();
    return performance.now() - startedAt;
  } catch {
    return null;
  }
}

async function runScenario(scenario: Scenario, options: Options) {
  const urls = scenario.paths.map((path) => `${options.base}${resolvePath(path, options)}`);

  const samples: number[] = [];
  let errors = 0;

  // 並列度ぶんの仮想利用者を同時に走らせる。
  await Promise.all(
    Array.from({ length: scenario.concurrency }, async (_unused, index) => {
      for (let round = 0; round < scenario.iterations; round += 1) {
        const url = urls[(index + round) % urls.length];
        if (url === undefined) continue;
        const elapsed = await measure(url, options.cookie);
        if (elapsed === null) errors += 1;
        else samples.push(elapsed);
      }
    }),
  );

  return summarize(scenario.id, samples, errors);
}

function describeVerdict(verdict: ScenarioVerdict): string {
  if (verdict.kind === "PASS") return `PASS（目標 ${String(verdict.targetMs)}ms 未満）`;
  switch (verdict.reason) {
    case "OVER_TARGET":
      return `FAIL 目標 ${String(verdict.targetMs)}ms を超えた`;
    case "ERRORS":
      return "FAIL 応答が返らなかった要求がある";
    default:
      return "FAIL 1 件も測れていない";
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log(`base:     ${options.base}`);
  console.log(`scenarios: ${options.scenarios.join(", ")}`);
  console.log(options.dryRun ? "mode:     dry-run（何も叩かない）" : "mode:     run");
  console.log("");

  const verdicts = new Map<ScenarioId, ScenarioVerdict>();

  for (const id of options.scenarios) {
    const scenario = SCENARIOS.find((entry) => entry.id === id);
    if (scenario === undefined) continue;

    console.log(`── シナリオ ${scenario.id}: ${scenario.title} ──`);
    console.log(`  ${scenario.pressure}`);
    console.log(
      `  並列 ${String(scenario.concurrency)} × ${String(scenario.iterations)} 回 / 目標 ${scenario.metric}`,
    );
    for (const path of scenario.paths) console.log(`  → ${path}`);
    if (scenario.manualNote !== undefined) console.log(`  **人が確かめること**: ${scenario.manualNote}`);

    if (options.dryRun) {
      console.log("  （--dry-run。実行していない）");
      console.log("");
      continue;
    }

    const result = await runScenario(scenario, options);
    const verdict = evaluateScenario(scenario, result);
    verdicts.set(scenario.id, verdict);

    console.log(
      `  samples=${String(result.samples)} errors=${String(result.errors)} ` +
        `p50=${result.p50Ms.toFixed(0)}ms p95=${result.p95Ms.toFixed(0)}ms p99=${result.p99Ms.toFixed(0)}ms`,
    );
    console.log(`  ${describeVerdict(verdict)}`);
    console.log("");
  }

  if (options.dryRun) return;

  // §4.2 MUST「4 シナリオすべてで目標値を満たす」。
  const complete = options.scenarios.length === SCENARIO_IDS.length;
  if (complete && allScenariosPass(verdicts)) {
    console.log("§4.2 MUST: 4 シナリオすべて合格");
    return;
  }
  console.log("§4.2 MUST: **未達**（GA 判定に進めない）");
  process.exitCode = 1;
}

await main();
