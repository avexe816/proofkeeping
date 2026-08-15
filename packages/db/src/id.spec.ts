/**
 * ID 採番のユニットテスト。
 *
 * task: docs/tasks/P0-05.md
 * ルール: .claude/rules/testing.md
 *
 * `tests/` ではなくここに置く理由は router.spec.ts と同じ
 * （ルート tsconfig.json が `packages/db/**` を除外しているため）。
 *
 * ── 10 万件テストの組み立て ────────────────────────────
 * 完了条件「10 万件生成して衝突しない」は対象ごとに意味が違う。
 *   - ULID は 80bit 乱数なので、実 crypto で 10 万件回しても衝突しないのは
 *     自明で、テストとして何も証明しない。**証明したいのは「Workers で
 *     時計が凍っても一意かつ生成順＝辞書順になること」**で、それは
 *     時計を固定すれば決定的に検証できる。
 *   - orgShortId は 31⁶ しかなく、10 万件では期待衝突数が約 5.6 件ある。
 *     「衝突したか」を assert するとフレークになるため、リトライ経路は
 *     必ず衝突するスタブで決定的に検証する。
 */

import { describe, expect, it } from "vitest";

import { NotFoundError } from "./errors.js";
import {
  ENTITY_PREFIXES,
  ORG_SHORT_ID_ALPHABET,
  ORG_SHORT_ID_LENGTH,
  ORG_SHORT_ID_MAX_ATTEMPTS,
  ULID_LENGTH,
  assertIdBelongsToTenant,
  createUlidFactory,
  generateId,
  generateOrgShortId,
  parseId,
  ulid,
  type EntityPrefix,
  type RandomBytes,
} from "./id.js";
import type { ShardContext } from "./router.js";

// ────────────────────────────────────────────────────────────
// テストダブル
// ────────────────────────────────────────────────────────────

/** seed 固定の xorshift32。実行ごとに同じ列を返す。 */
function seededRandomBytes(seed: number): RandomBytes {
  let state = seed >>> 0 || 0x9e3779b9;
  return (size: number): Uint8Array => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

/** 全バイトが同じ値の乱数。orgShortId は同じ文字 6 個になる。 */
function constantRandomBytes(value: number): RandomBytes {
  return (size: number): Uint8Array => new Uint8Array(size).fill(value);
}

/** 呼ばれるたびに次の値へ進む乱数。衝突とリトライを決定的に作る。 */
function sequencedRandomBytes(values: readonly number[]): RandomBytes {
  let call = 0;
  return (size: number): Uint8Array => {
    const value = values[Math.min(call, values.length - 1)] ?? 0;
    call++;
    return new Uint8Array(size).fill(value);
  };
}

/** 定数バイトから決まる orgShortId。`constantRandomBytes(n)` と対で使う。 */
function expectedOrgShortId(value: number): string {
  return ORG_SHORT_ID_ALPHABET.charAt(value % ORG_SHORT_ID_ALPHABET.length).repeat(
    ORG_SHORT_ID_LENGTH,
  );
}

const CTX: ShardContext = { organizationId: "org_alpha", orgShortId: "a2b3c4" };

// ────────────────────────────────────────────────────────────
// entityPrefix レジストリ
// ────────────────────────────────────────────────────────────

describe("ENTITY_PREFIXES", () => {
  it("仕様書由来の 11 個と P0-06 の 13 個・P0-08 の 1 個・P1-01 の 7 個・P2-01 の 4 個・P4-01 の 5 個・P5-01 の 6 個・P5-07 の 1 個・P5-12 の 1 個・P5-14 の 1 個を持つ", () => {
    // 前半: PK-SPEC-P0.md §19.4（task/insp/evd/lost/issue/inv/rcp）
    //       + architecture.md §2（obs/find/run）+ 仕様のレスポンス例（prop）。
    // 中盤: P0-06 の 13 テーブル分（docs/DECISIONS.md #013）。
    // 次:   P0-08 の password_history（docs/DECISIONS.md #018）。
    // 次:   P1-01 の 7 テーブル分（docs/DECISIONS.md #032）。
    // 次:   P2-01 の 4 テーブル分（docs/DECISIONS.md #059）。
    // 次:   P2-14 の日報（docs/DECISIONS.md #083）。
    // 次:   P3-01 の 5 テーブル分（docs/DECISIONS.md #092）。
    //       `obs`（roomObservation）は仕様書由来なので前半にある。
    //       `insp` / `evd` は仕様書由来なので前半にある。
    // 末尾: P4-01 の 5 テーブル分（docs/DECISIONS.md #105）。
    //       `find` / `run` は仕様書由来なので前半にある。
    //
    // **並びと綴りを変えないこと。** ID は永続データなので、
    // 接頭辞を変えると過去の行が parseId() を通らなくなる。
    expect([...ENTITY_PREFIXES]).toEqual([
      "task",
      "insp",
      "evd",
      "obs",
      "lost",
      "issue",
      "inv",
      "rcp",
      "find",
      "run",
      "prop",
      "org",
      "tax",
      "seq",
      "usr",
      "mem",
      "asgn",
      "bldg",
      "flr",
      "rtyp",
      "room",
      "sub",
      "ent",
      "audit",
      "pwh",
      "tlog",
      "ctpl",
      "citm",
      "cres",
      "photo",
      "stdt",
      "plan",
      "ipol",
      "ires",
      "ipho",
      "rwk",
      "rpt",
      "orev",
      "linen",
      "bsln",
      "ocfg",
      "bxcl",
      "occ",
      "sig",
      "racc",
      "dfb",
      "rcfg",
      // P5-01（PK-SPEC-P5 §2）。`inv` / `rcp` は仕様書由来で上にある。
      "cp",
      "prc",
      "invl",
      "invt",
      "dlv",
      "bper",
      // P5-07 が足した採番の控え（`document_sequence`）。
      "dseq",
      // P5-12 の双方合意の履歴（docs/DECISIONS.md #127）。
      "bprv",
      // P5-14 の日次集計（docs/DECISIONS.md #131）。
      "roll",
      // P6-01（PK-SPEC-P6 §2・§6）。
      "intg",
      "slog",
      "xmap",
      "psub",
      "npref",
      "akey",
      "owh",
      // P7-08。
      "arcm",
    ]);
  });

  it("重複が無い", () => {
    expect(new Set(ENTITY_PREFIXES).size).toBe(ENTITY_PREFIXES.length);
  });
});

// ────────────────────────────────────────────────────────────
// orgShortId
// ────────────────────────────────────────────────────────────

describe("generateOrgShortId", () => {
  const never: () => Promise<boolean> = () => Promise.resolve(false);

  it("6 桁で、生成 alphabet の文字だけを使う", async () => {
    for (let i = 0; i < 1000; i++) {
      const value = await generateOrgShortId(never);
      expect(value).toHaveLength(ORG_SHORT_ID_LENGTH);
      for (const ch of value) {
        expect(ORG_SHORT_ID_ALPHABET).toContain(ch);
      }
    }
  });

  it("紛らわしい文字（0 1 i l o）を含まない", async () => {
    for (let i = 0; i < 1000; i++) {
      const value = await generateOrgShortId(never);
      expect(value).not.toMatch(/[01ilo]/);
    }
  });

  it("10 万件採番しても衝突しない（既存チェックを注入）", async () => {
    const seen = new Set<string>();
    const isTaken = (candidate: string): Promise<boolean> => Promise.resolve(seen.has(candidate));

    for (let i = 0; i < 100_000; i++) {
      const value = await generateOrgShortId(isTaken);
      seen.add(value);
    }
    expect(seen.size).toBe(100_000);
  }, 60_000);

  it("衝突したら引き直す", async () => {
    // 1 回目は "222222"（使用済み）、2 回目は "333333"。
    const taken = expectedOrgShortId(0);
    const attempts: string[] = [];
    const value = await generateOrgShortId(
      (candidate) => {
        attempts.push(candidate);
        return Promise.resolve(candidate === taken);
      },
      { randomBytes: sequencedRandomBytes([0, 1]) },
    );

    expect(attempts).toEqual([taken, expectedOrgShortId(1)]);
    expect(value).toBe(expectedOrgShortId(1));
  });

  it("上限まで衝突したら黙って重複を返さず落ちる", async () => {
    let calls = 0;
    await expect(
      generateOrgShortId(
        () => {
          calls++;
          return Promise.resolve(true);
        },
        { randomBytes: constantRandomBytes(0) },
      ),
    ).rejects.toThrow("ORG_SHORT_ID_EXHAUSTED");
    expect(calls).toBe(ORG_SHORT_ID_MAX_ATTEMPTS);
  });

  it("maxAttempts を指定できる", async () => {
    let calls = 0;
    await expect(
      generateOrgShortId(
        () => {
          calls++;
          return Promise.resolve(true);
        },
        { maxAttempts: 3, randomBytes: constantRandomBytes(0) },
      ),
    ).rejects.toThrow("ORG_SHORT_ID_EXHAUSTED");
    expect(calls).toBe(3);
  });

  it("maxAttempts が 1 未満・非整数なら落ちる", async () => {
    await expect(generateOrgShortId(never, { maxAttempts: 0 })).rejects.toThrow(
      "ORG_SHORT_ID_MAX_ATTEMPTS_INVALID",
    );
    await expect(generateOrgShortId(never, { maxAttempts: 1.5 })).rejects.toThrow(
      "ORG_SHORT_ID_MAX_ATTEMPTS_INVALID",
    );
  });

  it("乱数が棄却域だけを返し続けても無限ループにならない", async () => {
    // 255 >= 248 なので全バイトが棄却される。
    await expect(
      generateOrgShortId(never, { randomBytes: constantRandomBytes(255) }),
    ).rejects.toThrow("ORG_SHORT_ID_RANDOM_EXHAUSTED");
  });
});

// ────────────────────────────────────────────────────────────
// ULID
// ────────────────────────────────────────────────────────────

describe("ULID", () => {
  it("26 桁の Crockford Base32（I L O U を含まない）", () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it("時計が凍ったまま 10 万件生成しても一意で、生成順＝辞書順", () => {
    // Workers は I/O の合間に時計を進めない。1 リクエスト内の一括生成は
    // 全件が同一ミリ秒になる。ここが単調増加カウンタの本番相当ケース。
    const nextUlid = createUlidFactory({ now: () => 1_700_000_000_000 });
    const generated: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      generated.push(nextUlid());
    }

    expect(new Set(generated).size).toBe(100_000);
    expect(generated).toEqual([...generated].sort());
  }, 60_000);

  it("seed 固定・時計を進めながら 10 万件生成しても一意で、生成順＝辞書順", () => {
    let clock = 1_700_000_000_000;
    let tick = 0;
    const nextUlid = createUlidFactory({
      now: () => {
        // 3 件ごとに 1ms 進む。同一ミリ秒と時刻更新が混ざる列にする。
        tick++;
        if (tick % 3 === 0) clock++;
        return clock;
      },
      randomBytes: seededRandomBytes(20260811),
    });

    const generated: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      generated.push(nextUlid());
    }

    expect(new Set(generated).size).toBe(100_000);
    expect(generated).toEqual([...generated].sort());
  }, 60_000);

  it("seed が同じなら実行ごとに同じ列になる", () => {
    const build = (): string[] => {
      const nextUlid = createUlidFactory({
        now: () => 1_700_000_000_000,
        randomBytes: seededRandomBytes(42),
      });
      return Array.from({ length: 1000 }, () => nextUlid());
    };
    expect(build()).toEqual(build());
  });

  it("時刻が進めば辞書順も進む", () => {
    const at = (time: number): string =>
      createUlidFactory({ now: () => time, randomBytes: constantRandomBytes(0) })();
    expect(at(1_700_000_000_000) < at(1_700_000_000_001)).toBe(true);
    expect(at(0) < at(1)).toBe(true);
  });

  it("時計が巻き戻っても落ちず、順序が保たれる", () => {
    let clock = 1_700_000_000_010;
    const nextUlid = createUlidFactory({ now: () => clock });

    const before = nextUlid();
    clock = 1_700_000_000_000; // 10ms 巻き戻る
    const after = nextUlid();

    // ID 生成が落ちると全書き込みが止まるため、例外にせず順序を優先する。
    expect(after > before).toBe(true);
    expect(after).toHaveLength(ULID_LENGTH);
  });

  it("乱数スタブが同じバッファを使い回しても壊れない", () => {
    const shared = new Uint8Array(10);
    const nextUlid = createUlidFactory({
      now: () => 1_700_000_000_000,
      randomBytes: () => shared, // コピーせず同一インスタンスを返す
    });
    const generated = Array.from({ length: 100 }, () => nextUlid());
    expect(new Set(generated).size).toBe(100);
    expect([...shared]).toEqual(new Array<number>(10).fill(0));
  });

  it("時刻が不正なら落ちる", () => {
    expect(() => createUlidFactory({ now: () => -1 })()).toThrow("ULID_TIME_INVALID");
    expect(() => createUlidFactory({ now: () => 1.5 })()).toThrow("ULID_TIME_INVALID");
    expect(() => createUlidFactory({ now: () => Number.NaN })()).toThrow("ULID_TIME_INVALID");
    // 48bit の上限（西暦 10889 年）を超える値。
    expect(() => createUlidFactory({ now: () => 281_474_976_710_656 })()).toThrow(
      "ULID_TIME_INVALID",
    );
  });

  it("乱数のバイト数が違えば落ちる", () => {
    expect(() => createUlidFactory({ randomBytes: (): Uint8Array => new Uint8Array(9) })()).toThrow(
      "ULID_RANDOM_BYTES_INVALID",
    );
  });
});

// ────────────────────────────────────────────────────────────
// generateId / parseId
// ────────────────────────────────────────────────────────────

describe("generateId", () => {
  it("{orgShortId}__{prefix}_{ulid} を組み立てる", () => {
    const id = generateId("a2b3c4", "task");
    expect(id).toMatch(/^a2b3c4__task_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(parseId(id)).toEqual({
      orgShortId: "a2b3c4",
      prefix: "task",
      ulid: id.slice(-ULID_LENGTH),
    });
  });

  it("登録済みの接頭辞すべてで組み立てられ、復元できる", () => {
    for (const prefix of ENTITY_PREFIXES) {
      expect(parseId(generateId("a2b3c4", prefix)).prefix).toBe(prefix);
    }
  });

  it("未登録の接頭辞を拒否する", () => {
    // 型では弾けるが、JS からの呼び出しと `as` のすり抜けが残る。
    // `guest` は宿泊者を保存しないため（security.md §3）永久に登録されない。
    expect(() => generateId("a2b3c4", "guest" as unknown as EntityPrefix)).toThrow(
      "INVALID_ENTITY_PREFIX",
    );
  });

  it("不正な orgShortId を拒否する", () => {
    expect(() => generateId("a2b3c", "task")).toThrow("INVALID_ORG_SHORT_ID");
    expect(() => generateId("A2B3C4", "task")).toThrow("INVALID_ORG_SHORT_ID");
    expect(() => generateId("a2b3c4x", "task")).toThrow("INVALID_ORG_SHORT_ID");
    expect(() => generateId("", "task")).toThrow("INVALID_ORG_SHORT_ID");
  });

  it("壊れた ULID 生成器の値を ID に載せない", () => {
    expect(() => generateId("a2b3c4", "task", () => "SHORT")).toThrow("INVALID_ULID");
    // Crockford に無い I / L / O / U と小文字を弾く。
    expect(() => generateId("a2b3c4", "task", () => "I".repeat(26))).toThrow("INVALID_ULID");
    expect(() => generateId("a2b3c4", "task", () => "a".repeat(26))).toThrow("INVALID_ULID");
  });
});

describe("parseId", () => {
  const validUlid = "01JBXQ3ZK8N4P2VYR6ABCDEFGH";

  it("仕様書の例（o7k2m9）を受け付ける", () => {
    // 生成器は `o` を作らないが、検証は `[0-9a-z]{6}` で受ける。
    // 揃えると仕様書中の例が「不正形式」になるため（id.ts のコメント参照）。
    expect(parseId(`o7k2m9__task_${validUlid}`).orgShortId).toBe("o7k2m9");
  });

  it.each([
    ["空文字", ""],
    ["区切りが無い", `a2b3c4task${validUlid}`],
    ["区切りが 1 本", `a2b3c4_task_${validUlid}`],
    ["orgShortId が 5 桁", `a2b3c__task_${validUlid}`],
    ["orgShortId が大文字", `A2B3C4__task_${validUlid}`],
    ["未登録の接頭辞", `a2b3c4__guest_${validUlid}`],
    ["接頭辞が空", `a2b3c4___${validUlid}`],
    ["ULID が 25 桁", `a2b3c4__task_${validUlid.slice(1)}`],
    ["ULID が小文字", `a2b3c4__task_${validUlid.toLowerCase()}`],
    ["ULID に I が混じる", `a2b3c4__task_I${validUlid.slice(1)}`],
    ["区切りが 2 組", `a2b3c4__task_${validUlid}__evil`],
    ["前後に空白", ` a2b3c4__task_${validUlid} `],
    ["改行の混入", `a2b3c4__task_${validUlid}\n`],
  ])("不正な形式で落ちる: %s", (_label, id) => {
    expect(() => parseId(id)).toThrow("INVALID_ID_FORMAT");
  });
});

// ────────────────────────────────────────────────────────────
// assertIdBelongsToTenant（第 2 層の要）
// ────────────────────────────────────────────────────────────

describe("assertIdBelongsToTenant", () => {
  const own = generateId(CTX.orgShortId, "task");
  const other = generateId("z9y8x7", "task");

  it("自組織の ID なら通す", () => {
    expect(() => {
      assertIdBelongsToTenant(own, CTX);
    }).not.toThrow();
  });

  it("別組織の ID は NotFoundError（403 ではない）", () => {
    expect(() => {
      assertIdBelongsToTenant(other, CTX);
    }).toThrow(NotFoundError);
    try {
      assertIdBelongsToTenant(other, CTX);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).code).toBe("RESOURCE_NOT_FOUND");
    }
  });

  it("形式不正でも越境と同じ NotFoundError にする", () => {
    // 区別すると「形式は正しいが他組織」と「そもそも不正」が呼び分けられ、
    // 403 と同じくリソースの存在を示唆する。
    for (const id of ["", "not-an-id", "a2b3c4__task_short", `${CTX.orgShortId}__room_x`]) {
      expect(() => {
        assertIdBelongsToTenant(id, CTX);
      }).toThrow(NotFoundError);
    }
  });

  it("接頭辞の後ろに区切りを足した細工を通さない", () => {
    // 仕様 §19.4 のスニペット（split("__")[0] の比較）はこれを通してしまう。
    expect(() => {
      assertIdBelongsToTenant(`${CTX.orgShortId}__task_X__evil`, CTX);
    }).toThrow(NotFoundError);
  });

  it("セッション側の orgShortId が壊れていたら通さない", () => {
    // 型を持たない呼び出し側から undefined 同士が一致してしまう経路を塞ぐ。
    const broken: ShardContext = { organizationId: "org_alpha", orgShortId: "" };
    expect(() => {
      assertIdBelongsToTenant(own, broken);
    }).toThrow(NotFoundError);

    const missing = { organizationId: "org_alpha" } as unknown as ShardContext;
    expect(() => {
      assertIdBelongsToTenant(own, missing);
    }).toThrow(NotFoundError);
  });
});
