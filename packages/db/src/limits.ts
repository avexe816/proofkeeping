/**
 * D1 の 1 文あたりのバインド変数の上限と、それに収める分割。
 *
 * task: docs/tasks/P2-06.md（現場で通しに回らなかったものの修正）
 * ルール: .claude/rules/architecture.md §1
 *
 * ── なぜ 100 なのか ─────────────────────────────────────
 * **D1 は 1 ステートメントあたりのバインド変数を 100 個までしか受けない。**
 * 超えると `D1_ERROR: too many SQL variables` になる。SQLite 本体の既定は
 * 999（3.32 以降は 32766）だが、**D1 はそれより厳しい独自の上限を持つ。**
 * ローカルの workerd でも同じ 100 で落ちるので、開発中に気づける。
 *
 * この値を「SQLite の 999」と思って分割の大きさを決めると、
 * **60 行 × 11 列 = 660 変数**のような文ができて実行時に落ちる。
 * 実際に `expandChecklist()` がそうなっており、清掃タスクの自動生成
 * （PK-SPEC-P1 §3）が 1 件も通らなかった。タスクが作れないので
 * 検査待ち（M-08）にも検査（M-09）にも到達できていなかった。
 *
 * ── 行数ではなく「変数の数」で割る ──────────────────────
 * 1 行あたりの変数の数は列の数で決まり、列は task ごとに増える。
 * **行数を定数で持つと、列を 1 つ足した日に静かに上限を超える。**
 * だから `chunkByParamBudget()` は「1 件あたり何個の変数を使うか」を
 * 受け取り、そこから 1 塊の件数を計算する。
 *
 * ── `reserved` を必ず渡すこと ───────────────────────────
 * `withTenantScope()` は `organizationId` に 1 個、施設スコープロールでは
 * `allowedPropertyIds` の件数ぶんの変数を足す。`SET` 句や他の条件も乗る。
 * **予約分を引かずに割ると、境界の塊だけが落ちる**（テストでは
 * 組織全体ロールで通り、現場の施設スコープロールで落ちる）。
 */

/** D1 が 1 文で受けるバインド変数の上限。**これを上げられない。** */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * 1 件あたり `paramsPerItem` 個の変数を使う並びを、D1 の上限に収まる塊へ割る。
 *
 * @param items 分割する並び。空なら空配列を返す。
 * @param paramsPerItem 1 件が使うバインド変数の数（挿入なら列の数）。
 * @param reserved その文が件数と無関係に使う変数の数（条件・SET 句など）。
 * @returns 各塊。**元の順序を保つ。** 並べ替えない。
 *
 * @throws {RangeError} 1 件すら収まらないとき（列が多すぎる設計の検出）。
 */
export function chunkByParamBudget<T>(
  items: readonly T[],
  paramsPerItem: number,
  reserved = 0,
): T[][] {
  if (items.length === 0) return [];
  if (paramsPerItem <= 0) return [[...items]];

  const budget = D1_MAX_BOUND_PARAMS - reserved;
  const perChunk = Math.floor(budget / paramsPerItem);
  if (perChunk < 1) {
    // **黙って 1 件ずつにしない。** 1 行が上限を超える表は設計の誤りで、
    // 分割では解けない（列を減らすか、文を分ける必要がある）。
    throw new RangeError(
      `D1_PARAM_BUDGET_TOO_SMALL:${String(paramsPerItem)}/${String(budget)}`,
    );
  }

  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += perChunk) {
    chunks.push([...items.slice(offset, offset + perChunk)]);
  }
  return chunks;
}

/**
 * `inArray()` に渡す ID の並びを、D1 の上限に収まる塊へ割る。
 *
 * ID は 1 件 1 変数なので `chunkByParamBudget(ids, 1, reserved)` と同じ。
 * **専用の名前にしてあるのは呼び出し側の意図が読めるようにするため**
 * （挿入の分割と読み取りの分割は、失敗したときの直し方が違う）。
 *
 * @param reserved 組織条件・施設スコープ・その他の条件が使う変数の数。
 *   既定の 16 は「`organizationId` 1 + 施設 15 件まで」を見込んだ値。
 *   担当施設がそれより多い組織では呼び出し側が実数を渡すこと。
 */
export function chunkIdsForInArray(
  ids: readonly string[],
  reserved = 16,
): string[][] {
  return chunkByParamBudget(ids, 1, reserved);
}
