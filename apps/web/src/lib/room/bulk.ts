/**
 * 範囲一括登録と CSV 取込の解釈。**純粋関数。**
 *
 * task:  docs/tasks/P0-22.md
 * 仕様:  docs/PK-SPEC-P0.md §24.2
 * ルール: .claude/rules/architecture.md §2
 *
 * ── ここは DB を知らない ────────────────────────────────
 * 「どんな行を作るか」だけを決める。既存の部屋番号との突き合わせは
 * リポジトリ層（`createRooms()` の `onConflictDoNothing()`）が行う。
 * **重複判定をここへ持ち込まない。** 判定を 2 か所に置くと、
 * 画面の件数と実際の登録数がずれる。
 *
 * ── 欠番を除外できる ────────────────────────────────────
 * §24.2 MUST。日本の宿泊施設では 4 を避ける慣習がある。
 * 除外は**利用者が明示した番号だけ。** 「4 を含む番号を自動で飛ばす」
 * ような気の利かせ方をしない。施設によって慣習が違う。
 */

/** 一括登録で作れる上限。100 室を 3 分以内（§24.2）に対して十分な余裕。 */
export const MAX_BULK_ROOMS = 500;

/** 範囲指定の入力。 */
export interface RoomRangeInput {
  /** 開始番号。数字のみ。 */
  from: number;
  /** 終了番号。`from` 以上。 */
  to: number;
  /** 除外する番号。範囲外の値は黙って捨てる。 */
  exclude?: readonly number[];
}

/** 範囲の解釈に失敗した理由。**UI は理由を細分化して見せなくてよい。** */
export type RoomRangeErrorCode = "INVALID_RANGE" | "TOO_MANY";

export type RoomRangeResult =
  | { ok: true; roomNumbers: readonly string[]; excluded: number }
  | { ok: false; error: RoomRangeErrorCode };

/**
 * 範囲を部屋番号の並びへ展開する。
 *
 * ```
 * expandRoomRange({ from: 301, to: 320, exclude: [304, 314] })
 *   → 18 室（304 と 314 を除く）
 * ```
 *
 * **番号は文字列で返す。** `room.roomNumber` は text 列で、`B01` のような
 * 英字混じりも入る（CSV 取込）。範囲指定だけ数値で持つと、後で型が割れる。
 */
export function expandRoomRange(input: RoomRangeInput): RoomRangeResult {
  const { from, to } = input;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { ok: false, error: "INVALID_RANGE" };
  if (from < 0 || to < from) return { ok: false, error: "INVALID_RANGE" };
  if (to - from + 1 > MAX_BULK_ROOMS) return { ok: false, error: "TOO_MANY" };

  const excluded = new Set(input.exclude ?? []);
  const roomNumbers: string[] = [];
  let skipped = 0;
  for (let n = from; n <= to; n++) {
    if (excluded.has(n)) {
      skipped += 1;
      continue;
    }
    roomNumbers.push(String(n));
  }
  return { ok: true, roomNumbers, excluded: skipped };
}

/**
 * 除外番号の入力（`304, 314` / `304 314` / `304、314`）を数値の並びにする。
 *
 * **解釈できない断片は捨てる。** 現場が全角の読点で区切ってくることを
 * 想定していて、そこで登録全体を止める理由が無い。
 */
export function parseExcludedNumbers(raw: string): readonly number[] {
  return raw
    .split(/[,、\s]+/)
    .map((piece) => piece.trim())
    .filter((piece) => /^\d+$/.test(piece))
    .map(Number);
}

// ────────────────────────────────────────────────────────────
// CSV 取込（§24.2 のフォーマット）
// ────────────────────────────────────────────────────────────

/** 期待する列。**順序も含めてこの並び**（§24.2）。 */
export const ROOM_CSV_HEADER = [
  "room_number",
  "room_type_code",
  "floor_name",
  "building_name",
  "bed_count",
  "capacity",
  "note",
] as const;

/** 取り込んだ 1 行。**`isSellable` は CSV に列が無い。** 下の注記を参照。 */
export interface RoomCsvRow {
  roomNumber: string;
  roomTypeCode: string | null;
  floorName: string | null;
  buildingName: string | null;
  bedCount: number | null;
  capacity: number | null;
  note: string | null;
}

/** 取り込めなかった行。**行番号を持つ**（1 始まり・ヘッダを含む）。 */
export interface RoomCsvRejection {
  line: number;
  reason: "MISSING_ROOM_NUMBER" | "TOO_FEW_COLUMNS";
}

export interface RoomCsvResult {
  rows: readonly RoomCsvRow[];
  rejected: readonly RoomCsvRejection[];
}

/**
 * CSV を解釈する。
 *
 * ── 引用符を扱わない ────────────────────────────────────
 * §24.2 のフォーマットに引用符を要する列が無い（部屋番号・コード・階名）。
 * `note` にカンマを入れたい場合は取り込み後に画面で直す。
 * **簡単な形のまま留めるのは、壊れ方が読めるようにするため。**
 * 引用符付き CSV を受けるなら、その時にパーサを入れ替えること。
 *
 * ── 1 行でも壊れていたら全部やめる、をしない ────────────
 * 取り込めた行は取り込み、落ちた行は行番号付きで返す（§24.2 の
 * 「エラーにしない」と同じ考え方）。100 行のうち 1 行の打ち間違いで
 * 最初からやり直させない。
 *
 * ── 清掃専用の場所 ──────────────────────────────────────
 * §24.2 の CSV に `is_sellable` 列は無く、例では `PANTRY` という
 * **客室タイプ**で表している。`isSellable` は客室タイプ側の設定から
 * 決める（呼び出し側の責務）。ここで列を勝手に増やさない。
 */
export function parseRoomCsv(text: string): RoomCsvResult {
  const lines = text.split(/\r?\n/);
  const rows: RoomCsvRow[] = [];
  const rejected: RoomCsvRejection[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim() === "") continue;

    const cells = line.split(",").map((cell) => cell.trim());

    // ヘッダ行は読み飛ばす。**あっても無くても動く。**
    if (index === 0 && cells[0] === ROOM_CSV_HEADER[0]) continue;

    if (cells.length < 2) {
      rejected.push({ line: lineNumber, reason: "TOO_FEW_COLUMNS" });
      continue;
    }

    const roomNumber = cells[0] ?? "";
    if (roomNumber === "") {
      rejected.push({ line: lineNumber, reason: "MISSING_ROOM_NUMBER" });
      continue;
    }

    rows.push({
      roomNumber,
      roomTypeCode: emptyToNull(cells[1]),
      floorName: emptyToNull(cells[2]),
      buildingName: emptyToNull(cells[3]),
      bedCount: toNumber(cells[4]),
      capacity: toNumber(cells[5]),
      note: emptyToNull(cells[6]),
    });
  }

  return { rows, rejected };
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/** 数値列。空欄と解釈できない値は `null`。**0 を null に落とさない。** */
function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  return /^\d+$/.test(value) ? Number(value) : null;
}
