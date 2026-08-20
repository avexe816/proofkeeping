/**
 * 稼働記録の CSV 取込（PK-SPEC-P4 §8.1）。**純粋関数。**
 *
 * task: docs/tasks/P4-02.md
 *
 * ```
 * room_number,business_date,is_occupied,guest_count,reservation_ref,check_in_at,check_out_at,is_stayover,night_index,nights_total,is_house_use
 * 302,2026-09-09,false,0,,,,false,,,false
 * 303,2026-09-09,true,2,RSV-8891,2026-09-09T15:20:00+09:00,,false,1,3,false
 * ```
 *
 * ── 保存しない列 ────────────────────────────────────────
 * **宿泊者の氏名・連絡先・住所・パスポート・カードの列が CSV に混ざっていても
 * 読まない**（§2.1 MUST / security.md §3）。§8.1 が定める 11 列だけを見て、
 * 未知の列は無視する。照合に要るのは人数と予約参照番号だけ。
 *
 * ── 1 行の誤りで全体を落とさない ────────────────────────
 * PMS から出した CSV を貼り付ける運用。1 行の書式違いで 100 行が
 * 取り込めないと、現場は取込そのものを諦める。**読めた行は取り込み、
 * 読めなかった行の番号を返す**（`lib/plan/csv.ts` と同じ方針）。
 *
 * ── ただし `is_occupied` だけは既定値に倒さない ──────────
 * 空欄や未知の表記を「空室」と読むと、**その部屋は使われていないという
 * 主張**になる。R001（稼働記録のない使用痕跡）はまさに「空室なのに
 * 使用痕跡がある」で発火するため、取込の既定値がそのまま根拠のない
 * 差異になる。読めない行は取り込まない（DECISIONS #107）。
 */

import {
  BUSINESS_DATE_PATTERN,
  findCsvHeader,
  parseCsvBoolean,
  parseCsvBooleanStrict,
  splitCsvLine,
} from "../csv/reader.js";

/** CSV の 1 行（客室番号は解決前）。時刻は epoch ミリ秒。 */
export interface ParsedOccupancyRow {
  roomNumber: string;
  businessDate: string;
  isOccupied: boolean;
  guestCount: number;
  /** 予約番号のみ。**予約者名が入っていても列として読まない。** */
  reservationRef: string | null;
  checkInAt: number | null;
  checkOutAt: number | null;
  isStayover: boolean;
  nightIndex: number | null;
  nightsTotal: number | null;
  isHouseUse: boolean;
}

/** 取込結果。 */
export interface ParsedOccupancyCsv {
  rows: ParsedOccupancyRow[];
  /**
   * 取り込まなかった行の番号（1 始まり・ヘッダ行を含めて数える）。
   *
   * 部屋番号が空・業務日が違う・`is_occupied` が読めない・同じ部屋の
   * 先に出てきたほう（後勝ち）の 4 通りが入る。
   */
  skippedLines: number[];
}

/** 読み取る列（§8.1 の 11 列）。**これ以外の列は無視する。** */
type Column =
  | "room_number"
  | "business_date"
  | "is_occupied"
  | "guest_count"
  | "reservation_ref"
  | "check_in_at"
  | "check_out_at"
  | "is_stayover"
  | "night_index"
  | "nights_total"
  | "is_house_use";

/** 人数の上限。**誤入力の門番**（`contracts/observation.ts` の `MAX_OBSERVED_QTY` と同じ考え）。 */
const MAX_GUEST_COUNT = 99;

/** 泊数の上限。長期滞在でも 1 年を超える予約は誤入力とみなす。 */
const MAX_NIGHTS = 365;

/** 予約参照番号の長さ。超える値は切らずに落とす（別の列がずれている疑いがある）。 */
const MAX_RESERVATION_REF_LENGTH = 64;

/** 人数。**負値と非数は 0 にする。** 取り込みを落とすほどの誤りではない。 */
function parseCount(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_GUEST_COUNT) : 0;
}

/** 泊数・何泊目。**1 以上の整数だけを採り、それ以外は `null`。** 0 は「不明」と区別できない。 */
function parseNights(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 1 || value > MAX_NIGHTS) return null;
  return value;
}

/**
 * ISO 8601 の時刻を epoch ミリ秒へ。
 *
 * **オフセット付きの表記を前提とする**（§8.1 の例は `+09:00`）。
 * オフセットの無い `2026-09-09T15:20:00` は実行環境の時間帯で解釈されうるため
 * 受け取らない。**施設の時間帯を推測して補わない。** 読めない値は `null`。
 * `checkInAt` / `checkOutAt` はどちらも列として null 可なので、
 * 行そのものは取り込める。
 */
function parseTimestamp(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 予約参照番号。空欄と長すぎる値は `null`。 */
function parseReservationRef(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > MAX_RESERVATION_REF_LENGTH) return null;
  return value;
}

/**
 * CSV を読む。
 *
 * @param businessDate 取込先の業務日。**CSV 側の `business_date` がこれと
 *   違う行は読み飛ばす。** 別の日のデータを黙って今日へ入れると、
 *   照合が別の日の稼働記録を根拠にしてしまう。
 */
export function parseOccupancyCsv(csv: string, businessDate: string): ParsedOccupancyCsv {
  const lines = csv.split(/\r?\n/);
  const skippedLines: number[] = [];

  const header = findCsvHeader(lines, "room_number");
  if (header.index === -1) return { rows: [], skippedLines };

  const at = (cells: string[], column: Column): string => {
    const position = header.columns.get(column);
    return position === undefined ? "" : (cells[position] ?? "");
  };

  // 同じ部屋が 2 行あったら**後の行を採る**。CSV を継ぎ足して直す運用で、
  // 後ろに書いたほうが新しいという読み方が自然なため。先の行は
  // 「取り込まなかった行」として番号を返す（黙って捨てない）。
  const byRoomNumber = new Map<string, { line: number; row: ParsedOccupancyRow }>();

  for (let index = header.index + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    const lineNumber = index + 1;

    const cells = splitCsvLine(line, header.delimiter);
    const roomNumber = at(cells, "room_number").trim();
    if (roomNumber === "") {
      skippedLines.push(lineNumber);
      continue;
    }

    const rowDate = at(cells, "business_date").trim();
    // 日付列が空なら取込先の業務日とみなす。書いてあって違う日なら飛ばす。
    if (rowDate !== "" && (!BUSINESS_DATE_PATTERN.test(rowDate) || rowDate !== businessDate)) {
      skippedLines.push(lineNumber);
      continue;
    }

    // **既定値に倒さない唯一の列**（上のコメント / DECISIONS #107）。
    const isOccupied = parseCsvBooleanStrict(at(cells, "is_occupied"));
    if (isOccupied === null) {
      skippedLines.push(lineNumber);
      continue;
    }

    const previous = byRoomNumber.get(roomNumber);
    if (previous !== undefined) skippedLines.push(previous.line);

    byRoomNumber.set(roomNumber, {
      line: lineNumber,
      row: {
        roomNumber,
        businessDate,
        isOccupied,
        // 空室なら人数は 0。**書いてあっても採らない。**「空室に 2 名」は
        // どちらかが誤りで、そのまま入れると照合の根拠が矛盾する。
        guestCount: isOccupied ? parseCount(at(cells, "guest_count")) : 0,
        reservationRef: parseReservationRef(at(cells, "reservation_ref")),
        checkInAt: parseTimestamp(at(cells, "check_in_at")),
        checkOutAt: parseTimestamp(at(cells, "check_out_at")),
        isStayover: parseCsvBoolean(at(cells, "is_stayover")),
        nightIndex: parseNights(at(cells, "night_index")),
        nightsTotal: parseNights(at(cells, "nights_total")),
        isHouseUse: parseCsvBoolean(at(cells, "is_house_use")),
      },
    });
  }

  return {
    rows: [...byRoomNumber.values()].map((entry) => entry.row),
    skippedLines: skippedLines.sort((a, b) => a - b),
  };
}
