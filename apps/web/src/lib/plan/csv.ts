/**
 * 当日の客室状況の CSV 取込（PK-SPEC-P1 §3.4）。**純粋関数。**
 *
 * task: docs/tasks/P1-04.md
 *
 * ```
 * room_number,business_date,has_checkout,has_checkin,is_stayover,guest_count,decline_clean
 * 302,2026-09-01,true,true,false,2,false
 * ```
 *
 * ── 1 行の誤りで全体を落とさない ────────────────────────
 * 前日の夜に PMS から出した CSV を貼り付ける運用（§3.4）。1 行の書式違いで
 * 100 行が取り込めないと、現場は入力そのものを諦める。**読めた行は取り込み、
 * 読めなかった行の番号を返す。** 画面が「N 行を取り込めませんでした」と
 * 事実として示す（PK-IMPL-CONTRACT §11.3）。
 *
 * ── 保存しない列 ────────────────────────────────────────
 * 宿泊者名・予約者名の列が CSV に混ざっていても**読まない。**
 * 未知の列は無視する（security.md §3）。
 */

/** CSV の 1 行（客室番号は解決前）。 */
export interface ParsedPlanRow {
  roomNumber: string;
  businessDate: string;
  hasCheckout: boolean;
  hasCheckin: boolean;
  isStayover: boolean;
  guestCount: number;
  declineClean: boolean;
}

/** 取込結果。 */
export interface ParsedCsv {
  rows: ParsedPlanRow[];
  /** 読めなかった行の番号（1 始まり・ヘッダ行を含めて数える）。 */
  skippedLines: number[];
}

/** 読み取る列（§3.4 の 7 列）。**これ以外の列は無視する。** */
type Column =
  | "room_number"
  | "business_date"
  | "has_checkout"
  | "has_checkin"
  | "is_stayover"
  | "guest_count"
  | "decline_clean";

/**
 * 真偽値の受け取り方。**表計算ソフトの出力の揺れを吸収する。**
 * `TRUE` / `1` / `○` / `yes` はすべて真。空欄は偽。
 */
function parseBoolean(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "y" || value === "○";
}

/** 人数。**負値と非数は 0 にする。** 取り込みを落とすほどの誤りではない。 */
function parseCount(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 99) : 0;
}

/**
 * 1 行を列へ割る。**引用符つきの値に対応する。**
 * 施設名や備考にカンマが入った CSV でも列がずれない。
 */
function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char ?? "";
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char ?? "";
  }
  cells.push(cell);
  return cells;
}

/** 業務日の形（architecture.md §7）。 */
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 先頭の BOM を落とす。
 *
 * Excel が「CSV UTF-8」で書き出すと先頭に U+FEFF が付く。落とさないと
 * 1 列目のヘッダ名が `room_number` と一致せず、**ファイル全体が
 * 「ヘッダ無し」として 0 行になる。**
 */
function stripBom(line: string): string {
  return line.startsWith("\uFEFF") ? line.slice(1) : line;
}

/**
 * CSV を読む。
 *
 * @param businessDate 取込先の業務日。**CSV 側の `business_date` がこれと
 *   違う行は読み飛ばす。** 別の日のデータを黙って今日へ入れると、
 *   翌日ぶんの計画を上書きしてしまう。
 */
export function parsePlanCsv(csv: string, businessDate: string): ParsedCsv {
  const lines = csv.split(/\r?\n/);
  const rows: ParsedPlanRow[] = [];
  const skippedLines: number[] = [];

  // ヘッダを探す。**BOM と前後の空白を落とす。**
  let headerIndex = -1;
  let columnIndex = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const cells = splitLine(stripBom(line)).map((cell) => cell.trim().toLowerCase());
    if (!cells.includes("room_number")) break;
    headerIndex = index;
    columnIndex = new Map(cells.map((cell, position) => [cell, position]));
    break;
  }
  if (headerIndex === -1) return { rows, skippedLines };

  const at = (cells: string[], column: Column): string => {
    const position = columnIndex.get(column);
    return position === undefined ? "" : (cells[position] ?? "");
  };

  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;

    const cells = splitLine(line);
    const roomNumber = at(cells, "room_number").trim();
    if (roomNumber === "") {
      skippedLines.push(index + 1);
      continue;
    }

    const rowDate = at(cells, "business_date").trim();
    // 日付列が空なら取込先の業務日とみなす。書いてあって違う日なら飛ばす。
    if (rowDate !== "" && (!BUSINESS_DATE.test(rowDate) || rowDate !== businessDate)) {
      skippedLines.push(index + 1);
      continue;
    }

    rows.push({
      roomNumber,
      businessDate,
      hasCheckout: parseBoolean(at(cells, "has_checkout")),
      hasCheckin: parseBoolean(at(cells, "has_checkin")),
      isStayover: parseBoolean(at(cells, "is_stayover")),
      guestCount: parseCount(at(cells, "guest_count")),
      declineClean: parseBoolean(at(cells, "decline_clean")),
    });
  }

  return { rows, skippedLines };
}
