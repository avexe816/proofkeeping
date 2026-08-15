/**
 * テナント移送の照合（P7-07 / PK-SPEC-P7 §4.4）。
 *
 * 完了条件のうち 2 つをここで押さえる。
 *   - 行数とチェックサムが照合される
 *   - 明示マッピングがハッシュより優先される（`router.spec.ts` と対）
 *
 * 「検証環境で実際に移送が成功する」は実 D1 が要る。**人間が実施。**
 */

import { describe, expect, it } from "vitest";

import {
  NON_MOVABLE_TABLES,
  TENANT_MOVE_STEPS,
  TENANT_MOVE_STEP_LABELS,
  assertShardMapValue,
  canonicalRow,
  checksumOfRows,
  isMovableTable,
  mayProceedAfterVerify,
  movableTablesOf,
  shardMapKey,
  verifyTenantMove,
  type TableSnapshot,
} from "./tenantMove.js";

describe("移送する表の選び方", () => {
  it("**知らない表は移す**（取りこぼしを作らない）", () => {
    // 表が増えたときに「一覧へ書き足し忘れて置き去り」が起きない向き。
    expect(isMovableTable("cleaning_task")).toBe(true);
    expect(isMovableTable("archive_manifest")).toBe(true);
    expect(isMovableTable("some_table_added_later")).toBe(true);
  });

  it("`schema_version` は移さない（シャードごとの適用履歴）", () => {
    expect(isMovableTable("schema_version")).toBe(false);
  });

  it("`org_directory` は移さない（SHARD_00 にだけ在る）", () => {
    expect(isMovableTable("org_directory")).toBe(false);
  });

  it("SQLite / D1 の内部表を移さない", () => {
    for (const table of ["sqlite_master", "sqlite_sequence", "_cf_KV", "d1_migrations"]) {
      expect(isMovableTable(table), table).toBe(false);
    }
  });

  it("移送してはならない表は 2 つだけ（**増やすときは理由が要る**）", () => {
    expect([...NON_MOVABLE_TABLES]).toEqual(["schema_version", "org_directory"]);
  });

  it("重複を畳んで名前順に並べる", () => {
    expect(movableTablesOf(["room", "cleaning_task", "room", "schema_version"])).toEqual([
      "cleaning_task",
      "room",
    ]);
  });
});

describe("canonicalRow", () => {
  it("**列の順序に依存しない**", () => {
    expect(canonicalRow({ b: 2, a: 1 })).toBe(canonicalRow({ a: 1, b: 2 }));
  });

  it("`undefined` を `null` に寄せる（列の欠けを黙って通さない）", () => {
    expect(canonicalRow({ a: undefined })).toBe(canonicalRow({ a: null }));
    expect(canonicalRow({ a: undefined })).toBe('{"a":null}');
  });

  it("値が違えば違う文字列になる", () => {
    expect(canonicalRow({ a: 1 })).not.toBe(canonicalRow({ a: 2 }));
    // 型が違うことも見分ける（"1" と 1 を同じにしない）。
    expect(canonicalRow({ a: 1 })).not.toBe(canonicalRow({ a: "1" }));
  });
});

describe("checksumOfRows", () => {
  it("SHA-256 の 16 進 64 桁", async () => {
    expect(await checksumOfRows([{ id: "x" }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("**行の並びに依存しない**（移送先の返す順が違っても一致する）", async () => {
    const a = await checksumOfRows([{ id: "1" }, { id: "2" }, { id: "3" }]);
    const b = await checksumOfRows([{ id: "3" }, { id: "1" }, { id: "2" }]);
    expect(a).toBe(b);
  });

  it("列の並びに依存しない", async () => {
    const a = await checksumOfRows([{ id: "1", name: "n" }]);
    const b = await checksumOfRows([{ name: "n", id: "1" }]);
    expect(a).toBe(b);
  });

  it("1 行でも違えば変わる", async () => {
    const a = await checksumOfRows([{ id: "1" }, { id: "2" }]);
    const b = await checksumOfRows([{ id: "1" }, { id: "2x" }]);
    expect(a).not.toBe(b);
  });

  it("行が落ちれば変わる", async () => {
    const a = await checksumOfRows([{ id: "1" }, { id: "2" }]);
    const b = await checksumOfRows([{ id: "1" }]);
    expect(a).not.toBe(b);
  });

  it("**空の表も値を持つ**（「照合していない」と取り違えない）", async () => {
    expect(await checksumOfRows([])).toMatch(/^[0-9a-f]{64}$/);
    expect(await checksumOfRows([])).not.toBe(await checksumOfRows([{ id: "1" }]));
  });

  it("同じ入力なら何度呼んでも同じ", async () => {
    const rows = [{ id: "1", n: 3 }, { id: "2", n: null }];
    const first = await checksumOfRows(rows);
    expect(await checksumOfRows(rows)).toBe(first);
    expect(await checksumOfRows(rows)).toBe(first);
  });
});

function snapshot(table: string, rowCount: number, checksum: string): TableSnapshot {
  return { table, rowCount, checksum };
}

describe("verifyTenantMove", () => {
  const SOURCE = [snapshot("cleaning_task", 2, "aa"), snapshot("room", 1, "bb")];

  it("一致すれば ok", () => {
    const result = verifyTenantMove(SOURCE, [
      snapshot("room", 1, "bb"),
      snapshot("cleaning_task", 2, "aa"),
    ]);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ tables: 2, rows: 3, mismatches: [] });
  });

  it("**行数が違えば止める**", () => {
    const result = verifyTenantMove(SOURCE, [
      snapshot("cleaning_task", 1, "aa"),
      snapshot("room", 1, "bb"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { table: "cleaning_task", reason: "ROW_COUNT", sourceRowCount: 2, targetRowCount: 1 },
    ]);
  });

  it("**行数が合っていてもチェックサムが違えば止める**", () => {
    // 型の丸め・列の欠けは行数に出ない。ここが最後の砦。
    const result = verifyTenantMove(SOURCE, [
      snapshot("cleaning_task", 2, "zz"),
      snapshot("room", 1, "bb"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { table: "cleaning_task", reason: "CHECKSUM", sourceRowCount: 2, targetRowCount: 2 },
    ]);
  });

  it("**移送先に作られなかった表を見逃さない**", () => {
    const result = verifyTenantMove(SOURCE, [snapshot("cleaning_task", 2, "aa")]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { table: "room", reason: "MISSING_ON_TARGET", sourceRowCount: 1, targetRowCount: null },
    ]);
  });

  it("移送先に余分な表が在っても止める", () => {
    const result = verifyTenantMove(SOURCE, [
      snapshot("cleaning_task", 2, "aa"),
      snapshot("room", 1, "bb"),
      snapshot("lost_item", 4, "cc"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { table: "lost_item", reason: "UNEXPECTED_ON_TARGET", sourceRowCount: null, targetRowCount: 4 },
    ]);
  });

  it("両側とも空でも ok（移送するものが無い組織）", () => {
    expect(verifyTenantMove([], [])).toEqual({ ok: true, tables: 0, rows: 0, mismatches: [] });
  });

  it("食い違いは表名順に並ぶ（出力を読める形にする）", () => {
    const result = verifyTenantMove(
      [snapshot("room", 1, "a"), snapshot("cleaning_task", 1, "a")],
      [snapshot("room", 2, "a"), snapshot("cleaning_task", 2, "a")],
    );
    expect(result.mismatches.map((m) => m.table)).toEqual(["cleaning_task", "room"]);
  });
});

describe("mayProceedAfterVerify", () => {
  it("**照合を通らなければ先へ進ませない**", () => {
    // ここが真になると、欠けたデータの側が正になる。
    expect(mayProceedAfterVerify(verifyTenantMove([snapshot("room", 1, "a")], []))).toBe(false);
  });

  it("通れば進める", () => {
    expect(
      mayProceedAfterVerify(verifyTenantMove([snapshot("room", 1, "a")], [snapshot("room", 1, "a")])),
    ).toBe(true);
  });
});

describe("shardMapKey", () => {
  it("`router.ts` の読み取り側と同じ綴り", () => {
    // ずれると「書いたのに読まれない」明示マッピングができる。
    expect(shardMapKey("org_test_alpha")).toBe("shard:org_test_alpha");
  });
});

describe("assertShardMapValue", () => {
  it("範囲内の整数を通す", () => {
    for (const index of [0, 1, 15]) {
      expect(() => {
        assertShardMapValue(index, 16);
      }).not.toThrow();
    }
  });

  it("**範囲外を弾く**（書くとその組織が読めなくなる）", () => {
    // `router.ts` は妥当でない値を読んだら例外にする（ハッシュへ落とさない）。
    expect(() => {
      assertShardMapValue(16, 16);
    }).toThrow(/SHARD_MAP_VALUE_OUT_OF_RANGE/);
    expect(() => {
      assertShardMapValue(-1, 16);
    }).toThrow(/SHARD_MAP_VALUE_OUT_OF_RANGE/);
  });

  it("整数でない値を弾く", () => {
    expect(() => {
      assertShardMapValue(1.5, 16);
    }).toThrow(/SHARD_MAP_VALUE_OUT_OF_RANGE/);
    expect(() => {
      assertShardMapValue(Number.NaN, 16);
    }).toThrow(/SHARD_MAP_VALUE_OUT_OF_RANGE/);
  });
});

describe("§4.4 の手順", () => {
  it("6 段。仕様の順序どおり", () => {
    expect([...TENANT_MOVE_STEPS]).toEqual([
      "FREEZE",
      "COPY",
      "VERIFY",
      "WRITE_SHARD_MAP",
      "RESUME",
      "DROP_SOURCE",
    ]);
  });

  it("**明示マッピングを書くのが旧シャードの取り外しより前**", () => {
    // 逆にすると、その隙間の読み書きが空になった旧シャードへ向かう。
    const steps = [...TENANT_MOVE_STEPS];
    expect(steps.indexOf("WRITE_SHARD_MAP")).toBeLessThan(steps.indexOf("DROP_SOURCE"));
  });

  it("**照合が明示マッピングより前**", () => {
    const steps = [...TENANT_MOVE_STEPS];
    expect(steps.indexOf("VERIFY")).toBeLessThan(steps.indexOf("WRITE_SHARD_MAP"));
  });

  it("全段に説明がある", () => {
    for (const step of TENANT_MOVE_STEPS) {
      expect(TENANT_MOVE_STEP_LABELS[step].length, step).toBeGreaterThan(0);
    }
  });

  it("**「削除」と書かない**（P7 固有の絶対ルール）", () => {
    // 旧シャードの取り外しはアーカイブではないが、文言を揃えておく。
    for (const label of Object.values(TENANT_MOVE_STEP_LABELS)) {
      expect(label, label).not.toContain("削除");
    }
  });
});
