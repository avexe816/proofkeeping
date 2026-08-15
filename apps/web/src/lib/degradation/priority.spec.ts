/**
 * 縮退運転の検証（P7-11 / PK-SPEC-P7 §5.2）。
 *
 * 完了条件:
 *   - 優先度 1（タスク参照・開始・完了）が障害時も維持される
 *   - D1 書き込み失敗時もオフラインキューが吸収する
 *
 * ── これは「実装した機能のテスト」ではない ──────────────
 * P7 固有の絶対ルールは「**新規機能を追加しない**」。§5.2 が求めるのは
 * 「壊れたときに優先度 1 が残ること」で、それを担う仕組み
 * （オフラインキュー・my-day のキャッシュ）は P1 で置いてある。
 *
 * ここがやるのは **性質を固定すること。** 後から
 * 「画面から直接 `fetch` する」「5 回失敗したらキューから消す」といった
 * 変更が入ったとき、**優先度 1 が静かに壊れる**のを止める。
 * だから経路をソースごと走査する検査を含めてある。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_ATTEMPTS,
  verdictOf,
  verdictOfNetworkFailure,
  type QueuedRequest,
} from "../offline/policy.js";

import {
  DEGRADATION_PRIORITIES,
  DEGRADATION_TABLE,
  PRIORITY_ONE_READ_PATH,
  PRIORITY_ONE_TASK_ACTIONS,
  handlingOf,
  isPriorityOneWrite,
  mayDegrade,
} from "./priority.js";

/** リポジトリのファイルを読む（このファイルからの相対）。 */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** ブロックコメント・行コメントを落とす。**注記を検査対象にしない。** */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("§5.2 の表", () => {
  it("7 段。優先度は 1〜7 が 1 つずつ", () => {
    expect(DEGRADATION_TABLE).toHaveLength(7);
    expect(DEGRADATION_TABLE.map((row) => row.priority)).toEqual([...DEGRADATION_PRIORITIES]);
  });

  it("**`MAINTAIN` は優先度 1 だけ**（何があっても維持するのは 1 段だけ）", () => {
    const maintained = DEGRADATION_TABLE.filter((row) => row.handling === "MAINTAIN");
    expect(maintained.map((row) => row.priority)).toEqual([1]);
  });

  it("優先度 1 以外は諦めてよい", () => {
    for (const priority of DEGRADATION_PRIORITIES) {
      expect(mayDegrade(priority), String(priority)).toBe(priority !== 1);
    }
  });

  it("扱いが仕様どおり", () => {
    expect(handlingOf(1)).toBe("MAINTAIN");
    expect(handlingOf(2)).toBe("OFFLINE_QUEUE");
    expect(handlingOf(3)).toBe("FALLBACK");
    expect(handlingOf(4)).toBe("SLOW_DOWN");
    expect(handlingOf(5)).toBe("DEFER");
    expect(handlingOf(6)).toBe("DEFER");
    expect(handlingOf(7)).toBe("MANUAL");
  });

  it("すべての行が担い手を書いている（**表だけ置いて実体が無い状態を作らない**）", () => {
    for (const row of DEGRADATION_TABLE) {
      expect(row.mechanism.length, row.feature).toBeGreaterThan(0);
    }
  });
});

describe("isPriorityOneWrite", () => {
  it.each([...PRIORITY_ONE_TASK_ACTIONS])("`/api/v1/tasks/{id}/%s` は優先度 1", (action) => {
    expect(isPriorityOneWrite(`/api/v1/tasks/a1b2c3__task_01JBXQ/${action}`)).toBe(true);
  });

  it("クエリ文字列が付いていても外れない", () => {
    expect(isPriorityOneWrite("/api/v1/tasks/a1b2c3__task_01JBXQ/start?retry=1")).toBe(true);
  });

  it("**検査の開始は優先度 1 ではない**（§5.2 では優先度 3）", () => {
    expect(isPriorityOneWrite("/api/v1/tasks/a1b2c3__task_01JBXQ/inspection/start")).toBe(false);
  });

  it("写真・チェックリスト・観察は優先度 1 ではない", () => {
    for (const path of ["photos", "checklist", "observation", "linen"]) {
      expect(isPriorityOneWrite(`/api/v1/tasks/a1b2c3__task_01JBXQ/${path}`), path).toBe(false);
    }
  });

  it("別のリソースに同じ動作名があっても混ざらない", () => {
    expect(isPriorityOneWrite("/api/v1/reconciliation/x/start")).toBe(false);
  });
});

/**
 * 完了条件 1「優先度 1（タスク参照・開始・完了）が障害時も維持される」。
 *
 * 障害時に維持できるのは、**通信の成否と画面の動きが切り離されている**
 * ときだけ。切り離しているのは送信キューなので、優先度 1 の書き込みが
 * キューを通ることをソースで固定する。
 */
describe("完了条件 1: 優先度 1 が障害時も維持される", () => {
  const TASK_SCREEN = code(source("../../routes/m/task.tsx"));
  const TODAY_SCREEN = code(source("../../routes/m/today.tsx"));

  it("**開始は送信キューを通る**（M-02 の一覧から）", () => {
    expect(TODAY_SCREEN).toContain("enqueueJson({ url: `/api/v1/tasks/${task.taskId}/start`");
  });

  it("**開始・完了・再開は送信キューを通る**（M-04 の詳細から）", () => {
    expect(TASK_SCREEN).toContain("enqueueJson({ url: `/api/v1/tasks/${data.taskId}/${action}`");
  });

  it("**画面が優先度 1 の書き込みを直接 `fetch` しない**", () => {
    // ここが破られると、オフラインでボタンが効かなくなる。
    for (const [name, screen] of [
      ["m/task.tsx", TASK_SCREEN],
      ["m/today.tsx", TODAY_SCREEN],
    ] as const) {
      for (const action of PRIORITY_ONE_TASK_ACTIONS) {
        // `fetch(` と同じ行・近傍に優先度 1 の動作名が出ないこと。
        const direct = new RegExp(`fetch\\([^)]*${action}\``);
        expect(direct.test(screen), `${name}:${action}`).toBe(false);
      }
    }
  });

  it("**押した瞬間に画面が動く**（楽観的更新）", () => {
    // 送信の成否を待つ実装だと、障害時にボタンが無反応になる。
    expect(TASK_SCREEN).toContain("setStatus(nextStatus)");
    expect(TODAY_SCREEN).toContain("setOptimistic(");
  });

  it("**参照は取得に失敗したらキャッシュへ落ちる**", () => {
    expect(TODAY_SCREEN).toContain("readCachedMyDay(");
    const cache = code(source("../offline/myDayCache.ts"));
    // 取得できなければ `null` を返す（例外を投げない）。投げると画面が落ちる。
    expect(cache).toContain("export async function fetchMyDay");
    expect(cache).toContain("export async function readCachedMyDay");
  });

  it("参照経路が §5.2 の想定どおり（`my-day` 1 本）", () => {
    expect(PRIORITY_ONE_READ_PATH).toBe("/api/v1/tasks/my-day");
    expect(code(source("../offline/myDayCache.ts"))).toContain(PRIORITY_ONE_READ_PATH);
  });
});

/**
 * 完了条件 2「D1 書き込み失敗時もオフラインキューが吸収する」。
 *
 * D1 の書き込みが落ちたとき、API は 5xx を返す（例外はハンドラの外へ出て
 * Workers が 500 にする）。**キューがそれを捨てないこと**が吸収の中身。
 */
describe("完了条件 2: D1 書き込み失敗をオフラインキューが吸収する", () => {
  it.each([500, 502, 503, 504])("%d は再送する（諦めない）", (status) => {
    expect(verdictOf(status, 0)).toEqual({ kind: "RETRY" });
    expect(verdictOf(status, MAX_ATTEMPTS - 1)).toEqual({ kind: "RETRY" });
  });

  it("**5 回を超えても `DONE` にしない**（キューから消えない）", () => {
    // `DONE` だけがキューから消す扱い（`queue.ts` の `dropItem()`）。
    // 5xx が `DONE` になると、送れていない完了操作が黙って消える。
    expect(verdictOf(503, MAX_ATTEMPTS)).toEqual({ kind: "GIVE_UP" });
    expect(verdictOf(503, MAX_ATTEMPTS + 10)).toEqual({ kind: "GIVE_UP" });
  });

  it("通信そのものが落ちても同じ（オフライン）", () => {
    expect(verdictOfNetworkFailure(0)).toEqual({ kind: "RETRY" });
    expect(verdictOfNetworkFailure(MAX_ATTEMPTS)).toEqual({ kind: "GIVE_UP" });
  });

  it("**`GIVE_UP` はキューから消す指示ではない**（`queue.ts` の扱いを固定する）", () => {
    const queue = code(source("../offline/queue.ts"));
    // 消すのは `DONE` の分岐だけ。
    expect(queue).toContain('if (verdict.kind === "DONE") {');
    expect(queue).toContain("await dropItem(item);");
    // `GIVE_UP` は赤バッジを立てて**書き戻す**。
    expect(queue).toContain('requiresManualRetry: verdict.kind === "GIVE_UP"');
    expect(queue).not.toContain('verdict.kind === "GIVE_UP"' + ") {\n    await dropItem");
  });

  it("**409 は成功として畳む**（D1 が書けていた場合の二重送信）", () => {
    // 状態機械の拒否も 409。どちらも「もう一度送っても同じ」。
    expect(verdictOf(409, 0)).toEqual({ kind: "DONE" });
  });

  it("赤バッジになっても手動で再送できる（回数が戻る）", () => {
    const item: QueuedRequest = {
      id: "q1",
      url: "/api/v1/tasks/a1b2c3__task_01JBXQ/complete",
      method: "POST",
      body: {},
      createdAt: 0,
      attempts: MAX_ATTEMPTS,
      requiresManualRetry: true,
    };
    expect(isPriorityOneWrite(item.url)).toBe(true);
    // `resetManualRetry()` の存在は policy.spec.ts が押さえている。
    // ここでは「捨てられていない」ことだけを見る。
    expect(item.attempts).toBe(MAX_ATTEMPTS);
  });
});

/**
 * 端末側がもう 1 段壊れた場合。
 *
 * IndexedDB はプライベートブラウズで開けず、Safari のタブでは 7 日で
 * 消える（ui-writing.md §5）。**そこまで壊れても優先度 1 を止めない。**
 */
describe("IndexedDB が使えなくても優先度 1 は動く", () => {
  const QUEUE = code(source("../offline/queue.ts"));

  it("キューはメモリへ退避する（読み書きの両方）", () => {
    expect(QUEUE).toContain("if (!isIdbAvailable()) return [...memoryQueue.values()];");
    expect(QUEUE).toContain("memoryQueue.set(item.id, item);");
  });

  it("**IndexedDB の失敗を投げない**（投げると押した操作が消える）", () => {
    // `writeItem` / `readQueue` / `dropItem` がいずれも catch を持つこと。
    const guarded = QUEUE.match(/catch\s*\{/g) ?? [];
    expect(guarded.length).toBeGreaterThanOrEqual(3);
  });

  it("復帰の合図を 1 つに頼らない（§8.2 の flush トリガー）", () => {
    // Background Sync API は iOS に無い。自前の合図が要る。
    expect(QUEUE).toContain('window.addEventListener("online"');
    expect(QUEUE).toContain('document.addEventListener("visibilitychange"');
    expect(QUEUE).not.toContain("SyncManager");
    expect(QUEUE).not.toContain("periodicSync");
  });
});

/**
 * §5.2 MUST を壊しうる変更を止める。
 *
 * §5.3 MUST は「`schemaVersion` 不一致なら書き込み系 API を 503」と定める。
 * それ自体は §5.2 と両立する（503 はキューが吸収する）が、
 * **優先度 1 のルートを 404 や 4xx で塞ぐと吸収できない**
 * （`verdictOf()` が 4xx を `GIVE_UP` にする）。
 */
describe("優先度 1 を塞ぐ middleware が無い", () => {
  it("middleware が状態を理由に一律で拒む実装を持たない", () => {
    const middleware = code(source("../../middleware/index.ts"));
    // 「全リクエストを状態で落とす」分岐が入っていないこと。
    expect(middleware).not.toContain("MAINTENANCE");
    expect(middleware).not.toContain("SCHEMA_VERSION_MISMATCH");
  });

  it("`/api/health` の 503 は health の 1 経路だけ", () => {
    const health = code(source("../../routes/api/health.ts"));
    expect(health).toContain("503");
    // 他のルートを巻き込まないこと（Hono の app 全体に掛けていない）。
    expect(health).not.toContain("app.use");
  });
});
