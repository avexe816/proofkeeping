/**
 * `my-day` のオフラインキャッシュ（PK-SPEC-P1 §19.7）。**ブラウザでのみ動く。**
 *
 * task:  docs/tasks/P1-21.md
 * ルール: .claude/rules/ui-writing.md §5
 *
 * ── 1 日単位。施設単位にしない（§19.7 MUST）─────────────
 * 鍵は業務日 1 つ。施設ごとに分けると「A は今朝、B は昨日」という状態が
 * でき、画面上部に出す取得時刻が何を指すのか説明できなくなる。
 *
 * ── 取得時刻はサーバーの値を使う ────────────────────────
 * `MyDayResponse.fetchedAt` をそのまま保存する。端末の時計を信用しない
 * （共用端末は時刻がずれていることがある）。
 *
 * ── 失敗しても画面を止めない ────────────────────────────
 * IndexedDB はプライベートブラウズで開けないことがある。読み書きの失敗は
 * すべて「キャッシュが無い」に倒す。**例外を投げない。**
 */

import type { MyDayResponse } from "@pk/contracts";

import { CACHE_STORE, idbGet, idbPut, isIdbAvailable } from "./idb.js";

/**
 * 鍵。**業務日ごとに 1 件。**
 *
 * 日付を鍵に含めるのは、日付をまたいだときに前日の一覧が「今日の一覧」
 * として出るのを防ぐため。前日ぶんは読まれないまま残るが、
 * 次に同じ日付が来ることは無いので実質 2〜3 件で頭打ちになる。
 */
function cacheKey(businessDate: string): string {
  return `my-day:${businessDate}`;
}

/** IndexedDB が使えない環境の退避先。**タブを閉じたら消える。** */
const memory = new Map<string, MyDayResponse>();

/** 保存する。**失敗しても投げない。** */
export async function cacheMyDay(day: MyDayResponse): Promise<void> {
  const key = cacheKey(day.businessDate);
  memory.set(key, day);
  if (!isIdbAvailable()) return;
  try {
    await idbPut(CACHE_STORE, key, day);
  } catch {
    // 保存できないことは業務を止める理由にならない（メモリには載っている）。
  }
}

/**
 * 読む。**無ければ `null`。**
 *
 * 保存した形をそのまま返す。**ここで形の検証をしない**のは意図で、
 * 検証を入れると「スキーマを変えた翌日、オフラインの端末で一覧が空になる」
 * という壊れ方をする。古い形は画面側が受け取った時点で欠けた項目が
 * `undefined` になるだけで、致命的にはならない。
 */
export async function readCachedMyDay(businessDate: string): Promise<MyDayResponse | null> {
  const key = cacheKey(businessDate);
  if (isIdbAvailable()) {
    try {
      const stored = await idbGet<MyDayResponse>(CACHE_STORE, key);
      if (stored !== undefined) return stored;
    } catch {
      // 読めなければメモリへ落とす。
    }
  }
  return memory.get(key) ?? null;
}

/**
 * サーバーから取り直してキャッシュする。
 *
 * @returns 取れたら応答。取れなければ `null`（呼び出し側がキャッシュへ落ちる）。
 */
export async function fetchMyDay(businessDate: string): Promise<MyDayResponse | null> {
  try {
    const response = await fetch(
      `/api/v1/tasks/my-day?businessDate=${encodeURIComponent(businessDate)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    const day = await response.json<MyDayResponse>();
    await cacheMyDay(day);
    return day;
  } catch {
    // オフライン・タイムアウト・DNS 失敗。**区別しない。**
    return null;
  }
}
