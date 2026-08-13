/**
 * 入室時の観察記録の既定値を推定する（PK-SPEC-P3 §3.3）。**純粋関数。**
 *
 * task: docs/tasks/P3-02.md
 *
 * ── ここに持ち込まないもの ──────────────────────────────
 * DB・fetch・環境変数・`Date.now()`（CLAUDE.md §5）。客室タイプと
 * 当日の稼働予定を引数で受け取るだけにする。
 *
 * ── 既定値は「当てる」ためではなく「触らせない」ため ────
 * §1.2 の要求は 15 秒で終わること。1 室 60 秒かかると 1 日 30 室で
 * 30 分の追加負担になり、入力が必ず形骸化する。**既定値のままでよければ
 * 1 タップで確定できる**状態を作るのが目的で、推定の精度そのものではない。
 * 外れたぶんは清掃員がステッパーで直す。
 *
 * ただし**当たりすぎても困る**。既定値のまま確定した比率（`usedDefaults`）が
 * 90% を超える施設は入力が形骸化している可能性があるため W-22 が警告する
 * （§3.3 MUST）。ここは施設単位の警告で、個人の評価に使わない
 * （.claude/rules/security.md §5）。
 *
 * ── 仕様が省略している既定値 ────────────────────────────
 * §3.3 の擬似コードは `bedsUsed` / `trashLevel` / `bathTowelUsed` /
 * `faceTowelUsed` / `bathMatUsed` の 5 つを書いて残りを `...` で省いている。
 * 省かれた 4 つ（ハンドタオル・スリッパ・グラス・追加布団）の既定は
 * docs/DECISIONS.md #094 で決めた。**人数ぶん置かれるもの**は人数、
 * **部屋に 1 つのもの**は 1、**通常は使われないもの**は 0。
 *
 * ── アメニティの既定値をここで作らない ──────────────────
 * `amenitiesUsed`（§2.1）は施設ごとに有効な品目が違う
 * （`observationConfig.enabledItemCodes` / §2.5 MUST）。品目の一覧を
 * 知らないこの関数では決められないため、M-05b を作る P3-04 が扱う。
 */

/** ゴミの量。`packages/db` の `TRASH_LEVELS` と同じ語彙（依存はさせない）。 */
export const TRASH_LEVEL_VALUES = ["NONE", "LOW", "NORMAL", "HIGH"] as const;

export type TrashLevelValue = (typeof TRASH_LEVEL_VALUES)[number];

/** 当日の稼働予定。`dailyRoomPlan` の 1 行に対応する。 */
export interface RoomPlanForDefaults {
  hasCheckout: boolean;
  isStayover: boolean;
  /** 予定人数。0 は「人数が入っていない」を意味する（既定値 0 の列）。 */
  guestCount: number;
}

/**
 * 客室タイプ。`roomType` の 1 行に対応する。
 *
 * **仕様 §3.3 の `standardCapacity` はこの表では `capacity`。**
 * どちらも「その客室タイプに通常泊まれる人数」で、列名だけが違う
 * （`packages/db/src/schema/property.ts`）。
 */
export interface RoomTypeForDefaults {
  /** ベッド数。未設定なら `null`。 */
  bedCount: number | null;
  /** 標準人数。未設定なら `null`。 */
  capacity: number | null;
}

/** M-05 / M-05b が初期表示する値（§4.1 / §4.2）。 */
export interface ObservationDefaults {
  bedsUsed: number;
  trashLevel: TrashLevelValue;
  bathTowelUsed: number;
  faceTowelUsed: number;
  handTowelUsed: number;
  bathMatUsed: number;
  slippersUsed: number;
  cupsUsed: number;
  extraFutonUsed: number;
}

/**
 * 人数がどこからも分からないときの人数。
 *
 * **0 にしない。** 0 にすると全項目 0 の「空室」と同じ既定値になり、
 * 稼働していた部屋で 1 タップ確定すると使用実績が消える。
 * 少なめに外す（1 名）ほうが、清掃員がステッパーで足す動機が残る。
 */
export const FALLBACK_GUEST_COUNT = 1;

/** 空室想定の既定値（§3.3 の第 1 分岐）。 */
const EMPTY_ROOM_DEFAULTS: ObservationDefaults = {
  bedsUsed: 0,
  trashLevel: "NONE",
  bathTowelUsed: 0,
  faceTowelUsed: 0,
  handTowelUsed: 0,
  bathMatUsed: 0,
  slippersUsed: 0,
  cupsUsed: 0,
  extraFutonUsed: 0,
};

/** 0 以上の整数に丸める。負値・小数を既定値として出さない。 */
function toCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 既定値の人数を決める。
 *
 * 予定人数（`guestCount`）→ 客室タイプの標準人数 → ベッド数 →
 * `FALLBACK_GUEST_COUNT` の順に落ちる。**どこかで必ず 1 以上になる。**
 */
export function estimateGuestCount(
  plan: RoomPlanForDefaults | null,
  roomType: RoomTypeForDefaults,
): number {
  const planned = plan === null ? 0 : toCount(plan.guestCount);
  if (planned > 0) return planned;

  const capacity = toCount(roomType.capacity ?? 0);
  if (capacity > 0) return capacity;

  const beds = toCount(roomType.bedCount ?? 0);
  if (beds > 0) return beds;

  return FALLBACK_GUEST_COUNT;
}

/**
 * 客室タイプと当日の稼働予定から既定値を推定する。
 *
 * ── 稼働予定が無いときは「稼働」側に倒す ────────────────
 * `plan` が `null` なのは、CSV も手入力も無い施設でタスクだけが
 * 生成された場合（`dailyRoomPlan` は必須ではない / P1-03）。
 * **空室として全項目 0 を既定にしない。** 清掃タスクが存在する時点で
 * その部屋は使われた可能性が高く、全 0 のまま 1 タップ確定されると
 * 「使用実績なし」という誤ったデータが残る。人数は客室タイプから推定する。
 *
 * ── 連泊を退室清掃と分けていない ────────────────────────
 * §3.3 の分岐は「空室」か「それ以外」の 2 つだけで、連泊
 * （`isStayover`）専用の推定式を持たない。**独自に分けないこと。**
 * 連泊 2 日目以降の観察をどう扱うかは §12 の未決事項で、
 * 決着前に推定式だけ先に作ると、後で決まった仕様と食い違う。
 */
export function estimateObservationDefaults(
  plan: RoomPlanForDefaults | null,
  roomType: RoomTypeForDefaults,
): ObservationDefaults {
  // 空室想定。稼働予定があり、退室も連泊も無い部屋（§3.3）。
  if (plan !== null && !plan.hasCheckout && !plan.isStayover) {
    return { ...EMPTY_ROOM_DEFAULTS };
  }

  const guests = estimateGuestCount(plan, roomType);
  const beds = toCount(roomType.bedCount ?? 0);

  return {
    // ベッド数を超える「使用済みベッド」は存在しない。
    bedsUsed: beds > 0 ? Math.min(guests, beds) : guests,
    trashLevel: "NORMAL",
    // 人数ぶん置かれるもの。
    bathTowelUsed: guests,
    faceTowelUsed: guests,
    handTowelUsed: guests,
    slippersUsed: guests,
    cupsUsed: guests,
    // 部屋に 1 つのもの。
    bathMatUsed: 1,
    // 通常は使われないもの。**人数がベッド数を超えても 0 のまま。**
    // 追加布団を敷いたかは予約情報ではなく現場が見た事実で決まる。
    extraFutonUsed: 0,
  };
}
