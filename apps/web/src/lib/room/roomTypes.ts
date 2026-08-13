/**
 * CSV の `room_type_code` を客室タイプのマスタへ突き合わせる。**純粋関数。**
 *
 * task:  docs/tasks/P1-24.md
 * 仕様:  docs/PK-SPEC-P0.md §24.2（CSV 取込）/ §24.3（客室タイプ）
 * ルール: .claude/rules/architecture.md §2
 *
 * ── ここは DB を知らない ────────────────────────────────
 * `parseRoomCsv()` と同じ方針。「どの行がどの客室タイプになるか」だけを
 * 決める。取込そのものは `createRooms()` が行う。
 *
 * ── 1 行の誤りで全体を落とさない ────────────────────────
 * §24.2 の「エラーにしない」。マスタに無いコードは**客室タイプ未設定として
 * 取り込み、コードを呼び出し側へ返す**（P1-04 の判断 1 と同じ向き）。
 * 100 室の CSV に 1 つ知らないコードが混ざっただけで最初からやり直させない。
 *
 * ── `PANTRY` の扱いは変えない ───────────────────────────
 * `isSellable` は `roomTypeCode === "PANTRY"` から決まる既存の扱いのまま
 * （`routes/app/rooms.tsx`）。**この関数は `isSellable` を判定しない。**
 * マスタに `PANTRY` を登録していない施設でも、清掃専用の場所の判定だけは
 * 従来どおり効く必要がある。突き合わせの成否と結びつけない。
 */

/** 突き合わせに使う客室タイプ。**有効なものだけを渡すこと。** */
export interface RoomTypeChoice {
  id: string;
  code: string;
}

/** 突き合わせの結果 1 行ぶん。 */
export interface ResolvedRoomTypeCode {
  /** 解決できた客室タイプの ID。できなければ `undefined`（＝未設定で取り込む）。 */
  roomTypeId: string | undefined;
}

/**
 * コード → ID の対応表を作る。
 *
 * **大文字小文字を無視して引く。** CSV は人が Excel で作るもので、
 * `twn` と `TWN` を別のタイプとして扱う理由が無い。同じコードが
 * 大小違いで 2 件登録されている場合は `sortOrder` の先勝ち
 * （呼び出し側が渡す順）。**登録側は `uq_room_type_property_code` が
 * 大小を区別するので、その状態自体は作れてしまう。**
 */
export function buildRoomTypeIndex(
  roomTypes: readonly RoomTypeChoice[],
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const type of roomTypes) {
    const key = type.code.trim().toLowerCase();
    if (key === "" || index.has(key)) continue;
    index.set(key, type.id);
  }
  return index;
}

/** `resolveRoomTypeCodes()` の結果。 */
export interface RoomTypeResolution {
  /** 入力と同じ並び・同じ長さ。 */
  rows: readonly ResolvedRoomTypeCode[];
  /**
   * マスタに無かったコード。**重複を除き、入力の順に並べる。**
   *
   * 画面はこれをそのまま出す。件数だけでは、どのコードを登録すれば
   * よいのかが分からない（完了条件「コードが応答に返る」）。
   */
  unknownCodes: readonly string[];
}

/**
 * CSV の各行のコードを ID へ写す。
 *
 * ```
 * resolveRoomTypeCodes([{ roomTypeCode: "TWN" }, { roomTypeCode: "XXX" }], index)
 *   → rows: [{ roomTypeId: "…rtyp_…" }, { roomTypeId: undefined }]
 *     unknownCodes: ["XXX"]
 * ```
 *
 * 空欄（`null`）は未知のコードではない。**`unknownCodes` に入れない。**
 * 客室タイプを決めずに部屋番号だけ取り込むのは正常な使い方で、
 * そこに警告を出すと、警告が出ているのが普通の状態になる。
 */
export function resolveRoomTypeCodes(
  rows: readonly { roomTypeCode: string | null }[],
  index: ReadonlyMap<string, string>,
): RoomTypeResolution {
  const resolved: ResolvedRoomTypeCode[] = [];
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();

  for (const row of rows) {
    const raw = row.roomTypeCode?.trim() ?? "";
    if (raw === "") {
      resolved.push({ roomTypeId: undefined });
      continue;
    }

    const id = index.get(raw.toLowerCase());
    resolved.push({ roomTypeId: id });
    if (id === undefined && !seenUnknown.has(raw)) {
      seenUnknown.add(raw);
      unknown.push(raw);
    }
  }

  return { rows: resolved, unknownCodes: unknown };
}
