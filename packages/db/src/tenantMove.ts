/**
 * テナント移送の照合（PK-SPEC-P7 §4.4 / P7-07）。**純粋。**
 *
 * task:  docs/tasks/P7-07.md
 * ルール: .claude/rules/architecture.md §1
 *
 * ```
 * 1. 対象テナントを読み取り専用にする
 * 2. 全テーブルを新シャードへコピー
 * 3. 行数とチェックサムを照合      ← ここが担う
 * 4. ルーティングテーブルを更新（明示マッピング）
 * 5. 読み書きを再開
 * 6. 旧シャードのデータを削除
 * ```
 *
 * ── ここに Workers の型を持ち込まない ───────────────────
 * **`scripts/tenant-move.ts`（node が直接起動する CLI）が import する。**
 * `shardUsage.ts` と同じ理由で、`D1Database` を参照すると node 側の
 * tsconfig が Workers の型を持たないため型検査が落ちる。
 * **schema も import しない**（下の「表の一覧を schema から作らない」）。
 *
 * ── 表の一覧を schema から作らない ──────────────────────
 * 移送する表は **移送元の `sqlite_master` から取る。** schema の定義から
 * 作ると、「schema に載っていないが D1 には在る表」が黙って置き去りになる。
 * 移送は**取りこぼしが即データ消失になる**操作なので、
 * 「実際にそこに在るもの」を数える側に倒す。
 *
 * 代わりに**移してはならない表を名指しで除く**（`NON_MOVABLE_TABLES`）。
 * ここは列挙で正しい。増えるのはテナントの表であって、
 * シャード固有の表（`schema_version`）や全体で 1 つの表（`org_directory`）
 * ではない。**知らない表は移す側**に倒してある。
 *
 * ── これは運用者向けであってテナント向けではない ────────
 * `shardUsage.ts` と同じ。**テナント向けの API・画面から呼ばないこと。**
 * シャード番号を持つ値を扱う（CLAUDE.md §4）。
 */

/**
 * 移送してはならない表。**ここ以外はすべて移す。**
 *
 * - `schema_version` … シャードごとの適用履歴（§19.8）。移送先には
 *   移送先自身の履歴が既に在る。上書きすると migration の状態が壊れる。
 * - `org_directory` … SHARD_00 にだけ在る全体の逆引き表（security.md §2）。
 *   組織が別シャードへ移っても、この表は SHARD_00 に在り続ける。
 */
export const NON_MOVABLE_TABLES = ["schema_version", "org_directory"] as const;

/**
 * SQLite / D1 の内部表を表す接頭辞。**移送の対象にしない。**
 *
 * `sqlite_` は SQLite 自身（`sqlite_master` / `sqlite_sequence`）、
 * `_cf_` と `d1_` は D1 の管理表。
 */
const INTERNAL_TABLE_PREFIXES = ["sqlite_", "_cf_", "d1_"] as const;

/** 移送する表か。**知らない表は真**（取りこぼしを作らない）。 */
export function isMovableTable(table: string): boolean {
  if ((NON_MOVABLE_TABLES as readonly string[]).includes(table)) return false;
  return !INTERNAL_TABLE_PREFIXES.some((prefix) => table.startsWith(prefix));
}

/** `sqlite_master` から取った名前を移送対象へ絞る。**名前順に並べる。** */
export function movableTablesOf(names: readonly string[]): string[] {
  return [...new Set(names)].filter(isMovableTable).sort();
}

/**
 * 1 行を安定した文字列にする。
 *
 * **列の順序に依存しない。** `SELECT *` の列順は D1 の実装と
 * migration の適用順で変わりうる。キーを名前順に並べてから JSON にする。
 *
 * `undefined` の値は `null` に寄せる。JSON で消える値を残すと、
 * 「列が無い」と「値が NULL」を区別できないまま照合が通ってしまう。
 */
export function canonicalRow(row: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(row).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) normalized[key] = row[key] ?? null;
  return JSON.stringify(normalized);
}

/**
 * 表 1 つぶんのチェックサム（SHA-256 の 16 進）。
 *
 * ── 並びに依存させない ──────────────────────────────────
 * 行を並べ替えてから連結する。移送先の `SELECT` が移送元と同じ順で
 * 返す保証は無く、**順序の違いだけで不一致になると照合が使い物にならない。**
 * 一方で「行の中身の集合が同じ」ことは、これで確かに言える。
 *
 * ── 空の表も値を持つ ────────────────────────────────────
 * 0 行なら空文字のハッシュ。**表ごとに必ず 1 つ値が出る**ので、
 * 「照合していない表」と「空だった表」を取り違えない。
 */
export async function checksumOfRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): Promise<string> {
  const canonical = rows.map(canonicalRow).sort().join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 表 1 つぶんの計測結果。 */
export interface TableSnapshot {
  table: string;
  rowCount: number;
  /** `checksumOfRows()` の値。 */
  checksum: string;
}

/** 照合で見つかった食い違い 1 件。 */
export interface TableMismatch {
  table: string;
  /** 何が食い違ったか。**行数とチェックサムを分けて報告する。** */
  reason: "ROW_COUNT" | "CHECKSUM" | "MISSING_ON_TARGET" | "UNEXPECTED_ON_TARGET";
  sourceRowCount: number | null;
  targetRowCount: number | null;
}

/** 照合の結果。 */
export interface TenantMoveVerification {
  ok: boolean;
  /** 照合した表の数。 */
  tables: number;
  /** 照合した行の合計（移送元）。 */
  rows: number;
  mismatches: TableMismatch[];
}

/**
 * 移送元と移送先を照合する（§4.4 の手順 3）。**純粋関数。**
 *
 * ── 片側にしか無い表も食い違い ──────────────────────────
 * 行数とチェックサムだけを見ると、**移送先に作られなかった表**が
 * 「照合対象に入っていない」だけで見逃される。表の集合そのものを
 * 突き合わせる。
 *
 * ── 移送先に余分な行が在ることも食い違い ────────────────
 * 移送先に別の組織のデータが在るのは正常（シャードは共有される）。
 * **ここへ渡すのは移送する組織で絞った結果**であること。
 * 絞らずに渡すと必ず不一致になるので、間違いは黙って通らない。
 */
export function verifyTenantMove(
  source: readonly TableSnapshot[],
  target: readonly TableSnapshot[],
): TenantMoveVerification {
  const targetByTable = new Map(target.map((snapshot) => [snapshot.table, snapshot]));
  const sourceTables = new Set(source.map((snapshot) => snapshot.table));
  const mismatches: TableMismatch[] = [];

  for (const from of source) {
    const to = targetByTable.get(from.table);
    if (to === undefined) {
      mismatches.push({
        table: from.table,
        reason: "MISSING_ON_TARGET",
        sourceRowCount: from.rowCount,
        targetRowCount: null,
      });
      continue;
    }
    if (from.rowCount !== to.rowCount) {
      mismatches.push({
        table: from.table,
        reason: "ROW_COUNT",
        sourceRowCount: from.rowCount,
        targetRowCount: to.rowCount,
      });
      continue;
    }
    // 行数が合っていても中身が違うことがある（型の丸め・欠けた列）。
    if (from.checksum !== to.checksum) {
      mismatches.push({
        table: from.table,
        reason: "CHECKSUM",
        sourceRowCount: from.rowCount,
        targetRowCount: to.rowCount,
      });
    }
  }

  for (const to of target) {
    if (sourceTables.has(to.table)) continue;
    mismatches.push({
      table: to.table,
      reason: "UNEXPECTED_ON_TARGET",
      sourceRowCount: null,
      targetRowCount: to.rowCount,
    });
  }

  return {
    ok: mismatches.length === 0,
    tables: source.length,
    rows: source.reduce((total, snapshot) => total + snapshot.rowCount, 0),
    mismatches: mismatches.sort((a, b) => (a.table < b.table ? -1 : 1)),
  };
}

/**
 * `SHARD_MAP` のキー（architecture.md §1）。
 *
 * **ここ以外でキーを組み立てないこと。** `router.ts` の読み取り側と
 * 綴りがずれると、書いたのに読まれない明示マッピングができる。
 */
export function shardMapKey(organizationId: string): string {
  return `shard:${organizationId}`;
}

/**
 * 明示マッピングに書いてよい値か確かめる（DECISIONS #007）。
 *
 * **書き込み側が検証の責任を負う。** `router.ts` は妥当でない値を
 * 読んだら例外にする（ハッシュへ落とさない）ので、範囲外の値を
 * 書くと**その組織が丸ごと読めなくなる。**
 *
 * @throws 範囲外・非整数のとき
 */
export function assertShardMapValue(shardIndex: number, shardCount: number): void {
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`SHARD_MAP_VALUE_OUT_OF_RANGE:${String(shardIndex)}`);
  }
}

/**
 * §4.4 の手順。**順序に意味がある。**
 *
 * `WRITE_SHARD_MAP` が `DROP_SOURCE` より前なのは仕様どおりで、
 * **理由がある。** 明示マッピングを書く前に旧シャードを消すと、
 * その隙間の読み書きが「空になった旧シャード」へ向かい、
 * **在るはずのデータが無いように見える。**
 */
export const TENANT_MOVE_STEPS = [
  "FREEZE",
  "COPY",
  "VERIFY",
  "WRITE_SHARD_MAP",
  "RESUME",
  "DROP_SOURCE",
] as const;

export type TenantMoveStep = (typeof TENANT_MOVE_STEPS)[number];

/** 手順の説明。**運用者が CLI の出力で読む。** */
export const TENANT_MOVE_STEP_LABELS: Readonly<Record<TenantMoveStep, string>> = {
  FREEZE: "対象テナントを読み取り専用にする",
  COPY: "全テーブルを新シャードへコピーする",
  VERIFY: "行数とチェックサムを照合する",
  WRITE_SHARD_MAP: "明示マッピングを書く（SHARD_MAP / TTL を付けない）",
  RESUME: "読み書きを再開する",
  DROP_SOURCE: "旧シャードのデータを取り外す",
};

/**
 * 照合を通らなかったときに進んでよい手順か。
 *
 * **`VERIFY` より後へ進ませない。** 行数もチェックサムも合っていない
 * まま明示マッピングを書くと、**欠けたデータの側が正になる。**
 */
export function mayProceedAfterVerify(verification: TenantMoveVerification): boolean {
  return verification.ok;
}
