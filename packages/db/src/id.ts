/**
 * ID 採番。テナント分離の第 2 層（ID の自己記述化）。
 *
 * 仕様: docs/PK-SPEC-P0.md §19.4 第2層
 * ルール: .claude/rules/architecture.md §2
 * task:  docs/tasks/P0-05.md
 *
 * ── 形式 ────────────────────────────────────────────────
 *   {orgShortId}__{entityPrefix}_{ulid}
 *   例: o7k2m9__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH
 *
 * URL やリクエストで ID を受け取ったら、**DB へ問い合わせる前に**
 * `assertIdBelongsToTenant()` でセッションの組織と照合する。
 * 不一致は 403 ではなく 404（403 は存在を示唆する）。
 *
 * ── alphabet が 2 つある。統一しないこと ────────────────
 * `ORG_SHORT_ID_ALPHABET`（小文字 31 文字）と `ULID_ALPHABET`
 * （Crockford Base32・大文字 32 文字）は目的が違う。
 *   - orgShortId は人が読み・URL に載り・口頭で伝わるラベル。
 *     視認しにくい `0 1 i l o` を **alphabet から外す**（P0-05 完了条件）。
 *   - ULID は規格で alphabet が決まっている 26 桁。`0` `1` を含み、
 *     `I L O U` を除く。ここを変えると ULID ではなくなる。
 * 「重複しているから片方に寄せる」という整理をしないこと。
 *
 * ── 乱数 ────────────────────────────────────────────────
 * `Math.random()` を使わない。既定は `crypto.getRandomValues()`。
 * テストのために時計と乱数を注入できるようにしてあるが、
 * **本番経路で注入しない**（決定的な ID は推測可能な ID になる）。
 */

import { NotFoundError } from "./errors.js";
import type { ShardContext } from "./router.js";

// ────────────────────────────────────────────────────────────
// entityPrefix レジストリ
// ────────────────────────────────────────────────────────────

/**
 * ID に埋め込むエンティティ接頭辞。**仕様書に定義があるものだけを載せる。**
 *
 * 出典:
 *   task / insp / evd / lost / issue / inv / rcp … PK-SPEC-P0.md §19.4
 *   obs / find / run                             … .claude/rules/architecture.md §2
 *                                                   （obs の実例は PK-SPEC-P3.md の schema コメント）
 *   prop                                         … PK-SPEC-P0.md §23.3 / PK-SPEC-P1.md の
 *                                                   レスポンス例 `o7k2m9__prop_A`
 *
 * ── 閉じたレジストリにしている理由 ──────────────────────
 * `[a-z]+` のような開いた検証にすると、テーブルを足すたびに
 * `prop` / `property`、`insp` / `inspection` の表記揺れが増え、
 * ID は永続データなので後から統一できない。
 *
 *   org / tax / seq / usr / mem / asgn / bldg / flr / rtyp / room / sub / ent / audit
 *                                                … P0-06 の決定（DECISIONS #013）
 *                                                  `mem` / `room` は PK-SPEC-P2 の
 *                                                  記述（`mem_xxx` / `room_302`）に合わせた
 *
 * ── 追加するときの手順 ──────────────────────────────────
 * 新しいテーブルを作る task は ① ここへ追記し ② 由来を docs/DECISIONS.md に
 * 残すこと。推測で増やして良い場所ではない。
 * **一度使った接頭辞を変えないこと。** ID は永続データなので、
 * 変更すると過去の行が `parseId()` を通らなくなる。
 */
export const ENTITY_PREFIXES = [
  // 仕様に定義があるもの（P0-05）
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
  // P0-06 が決めたもの（docs/DECISIONS.md #013）
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
  // P0-08 が決めたもの（docs/DECISIONS.md #018）
  "pwh",
  // P1-01 が決めたもの（docs/DECISIONS.md #032）。
  // `task` は既に上にある（PK-SPEC-P0 §19.4）。ここは P1-01 が足す 7 表ぶん。
  "tlog", // taskTimeLog
  "ctpl", // checklistTemplate
  "citm", // checklistItem
  "cres", // taskChecklistResult
  "photo", // taskPhoto
  "stdt", // standardTime
  "plan", // dailyRoomPlan
  // P2-01 が決めたもの（docs/DECISIONS.md #059）。
  // `insp`（inspection）と `evd`（evidenceSnapshot）は既に上にある（PK-SPEC-P0 §19.4）。
  "ipol", // propertyInspectionPolicy
  "ires", // inspectionItemResult
  "ipho", // inspectionPhoto
  "rwk", // reworkCycle
  // P2-14 が決めたもの（docs/DECISIONS.md #083）。
  // 帳票の番号（`RPT-2026-0042`）とは別物。あちらは人が読む文書番号で、
  // こちらは行の ID。**同じ日報が「番号 1 つ・ID 複数（版ごと）」を持つ。**
  "rpt", // dailyReport
  // P3-01 が決めたもの（docs/DECISIONS.md #092）。
  // `obs`（roomObservation）は既に上にある（PK-SPEC-P0 §19.4）。
  "orev", // observationRevision
  "linen", // linenRecord
  "bsln", // consumptionBaseline
  "ocfg", // observationConfig
  "bxcl", // baselineExclusionLog
  // P4-01 が決めたもの（docs/DECISIONS.md #105）。
  // `find`（auditFinding）と `run`（reconciliationRun）は既に上にある
  // （architecture.md §2）。ここは残る 5 表ぶん。
  "occ", // occupancySnapshot
  "sig", // physicalSignal
  "racc", // roomAccessLog
  "dfb", // detectionFeedback
  "rcfg", // ruleConfig
] as const;

/** `ENTITY_PREFIXES` に載っている接頭辞だけを許す型。 */
export type EntityPrefix = (typeof ENTITY_PREFIXES)[number];

const ENTITY_PREFIX_SET: ReadonlySet<string> = new Set<string>(ENTITY_PREFIXES);

// ────────────────────────────────────────────────────────────
// 乱数
// ────────────────────────────────────────────────────────────

/** `size` バイトの乱数を返す関数。テストでのみ差し替える。 */
export type RandomBytes = (size: number) => Uint8Array;

function cryptoRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

// ────────────────────────────────────────────────────────────
// orgShortId
// ────────────────────────────────────────────────────────────

/** orgShortId の桁数。仕様 §19.4 の「6 桁の英数字」。 */
export const ORG_SHORT_ID_LENGTH = 6;

/**
 * 生成に使う 31 文字。`0` `1` `i` `l` `o` を除いてある。
 *
 * `l` は task の文面（O/0, I/1）には無いが `1` と紛らわしいため外した。
 * 要求より厳しい方向なので完了条件は満たす。
 */
export const ORG_SHORT_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/**
 * 剰余バイアスを避けるための棄却境界。256 を alphabet 長で割り切れる最大値。
 * これ以上のバイトは捨てる（31 × 8 = 248）。
 */
const ORG_SHORT_ID_REJECT_AT =
  Math.floor(256 / ORG_SHORT_ID_ALPHABET.length) * ORG_SHORT_ID_ALPHABET.length;

/** 衝突時のリトライ上限。 */
export const ORG_SHORT_ID_MAX_ATTEMPTS = 10;

/**
 * 棄却サンプリングの打ち切り回数。実 crypto なら 1 回で足りる（棄却率 3.1%）。
 * 壊れた `randomBytes` スタブで無限ループにならないための保険。
 */
const ORG_SHORT_ID_MAX_DRAWS = 32;

/**
 * 候補文字列を 1 つ作る。衝突チェックはしない。
 *
 * `String.prototype.charAt` を使うのは、添字が必ず範囲内であることを
 * `noUncheckedIndexedAccess` に説明するより読みやすいため。
 */
function randomOrgShortId(randomBytes: RandomBytes): string {
  let out = "";
  for (let draw = 0; draw < ORG_SHORT_ID_MAX_DRAWS; draw++) {
    const buf = randomBytes(ORG_SHORT_ID_LENGTH * 2);
    for (const byte of buf) {
      if (out.length === ORG_SHORT_ID_LENGTH) return out;
      if (byte >= ORG_SHORT_ID_REJECT_AT) continue; // 剰余バイアスを避ける
      out += ORG_SHORT_ID_ALPHABET.charAt(byte % ORG_SHORT_ID_ALPHABET.length);
    }
    if (out.length === ORG_SHORT_ID_LENGTH) return out;
  }
  // 実乱数では到達しない。注入されたスタブが偏った値を返し続けた場合のみ。
  throw new Error("ORG_SHORT_ID_RANDOM_EXHAUSTED");
}

/** 候補が既に使われているかを問い合わせる関数。 */
export type OrgShortIdTaken = (candidate: string) => Promise<boolean>;

/** `generateOrgShortId()` の任意設定。 */
export interface GenerateOrgShortIdOptions {
  /** 衝突時のリトライ上限。既定 `ORG_SHORT_ID_MAX_ATTEMPTS`。 */
  maxAttempts?: number;
  /** 乱数源。テスト専用。 */
  randomBytes?: RandomBytes;
}

/**
 * 組織作成時に orgShortId を採番する。
 *
 * ── `isTaken` を必須引数にしている理由 ──────────────────
 * 31⁶ = 887,503,681 しかない。10,000 組織で誕生日衝突の確率は約 5.6%、
 * 100,000 組織なら実質確実に衝突する。**衝突チェックは飾りではない。**
 * 既定値を与えて「未指定なら無チェック」にすると、チェック忘れが静かに通り、
 * 同じ orgShortId を持つ 2 組織が `assertIdBelongsToTenant()` を相互に
 * 通過してテナント分離が破れる。よって呼び出し側に必ず書かせる。
 *
 * ── `isTaken` を実装する側（P0-06）への要求 ─────────────
 * 組織は 16 シャードへ分散するため、**1 シャードの UNIQUE 制約では
 * グローバル一意性を担保できない。** どこで全体一意を保証するかは
 * 仕様に記述が無く未解決（OPEN_QUESTIONS #009）。`SHARD_MAP` は
 * 明示マッピング専用なので相乗りさせないこと（architecture.md §1）。
 *
 * @throws `ORG_SHORT_ID_EXHAUSTED` リトライ上限まで空きが見つからなかった。
 *   100,000 組織時の 1 回あたり衝突率は 1.1×10⁻⁴。10 回連続は起きない。
 *   起きたなら `isTaken` の実装（常に true を返す等）を疑うべきで、
 *   黙って重複を返すより落とす。
 */
export async function generateOrgShortId(
  isTaken: OrgShortIdTaken,
  options?: GenerateOrgShortIdOptions,
): Promise<string> {
  const maxAttempts = options?.maxAttempts ?? ORG_SHORT_ID_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("ORG_SHORT_ID_MAX_ATTEMPTS_INVALID");
  }
  const randomBytes = options?.randomBytes ?? cryptoRandomBytes;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = randomOrgShortId(randomBytes);
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error("ORG_SHORT_ID_EXHAUSTED");
}

// ────────────────────────────────────────────────────────────
// ULID
// ────────────────────────────────────────────────────────────

/** Crockford Base32。ULID 規格の alphabet。`I L O U` を含まない。 */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** タイムスタンプ部の桁数（48bit）。 */
const ULID_TIME_LENGTH = 10;

/** ランダム部のバイト数（80bit = 16 桁）。 */
const ULID_RANDOM_BYTES = 10;

/** ULID 全体の桁数。仕様 §19.4 の「時系列ソート可能な 26 桁」。 */
export const ULID_LENGTH = 26;

/** 48bit で表せる最大ミリ秒（西暦 10889 年）。 */
const MAX_ULID_TIME = 281_474_976_710_655;

/** 48bit のミリ秒を 10 桁の Crockford Base32 にする。 */
function encodeTime(time: number): string {
  let out = "";
  let rest = time;
  for (let i = 0; i < ULID_TIME_LENGTH; i++) {
    const mod = rest % 32;
    out = ULID_ALPHABET.charAt(mod) + out;
    rest = (rest - mod) / 32;
  }
  return out;
}

/** 80bit を 16 桁の Crockford Base32 にする。5bit ずつ切り出す。 */
function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte; // bits < 13 に保たれるので 32bit 演算で安全
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ULID_ALPHABET.charAt((acc >>> bits) & 31);
    }
  }
  return out; // 80 / 5 = 16 桁ちょうど。端数は出ない
}

/**
 * ランダム部をビッグエンディアンの整数とみなして +1 する（破壊的）。
 *
 * @throws `ULID_RANDOMNESS_EXHAUSTED` 同一ミリ秒に 2⁸⁰ 件生成した場合のみ。到達不能。
 */
function incrementRandom(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const byte = bytes[i] ?? 0; // 範囲内なので undefined にはならない
    if (byte < 0xff) {
      bytes[i] = byte + 1;
      return;
    }
    bytes[i] = 0;
  }
  throw new Error("ULID_RANDOMNESS_EXHAUSTED");
}

function assertUlidTime(time: number): number {
  if (!Number.isInteger(time) || time < 0 || time > MAX_ULID_TIME) {
    throw new Error("ULID_TIME_INVALID");
  }
  return time;
}

/**
 * ランダム部を取り直す。**必ずコピーする。**
 * スタブが同じバッファを使い回した場合、`incrementRandom()` の破壊的更新が
 * 呼び出し側へ漏れて次回の値を汚す。
 */
function takeRandom(randomBytes: RandomBytes): Uint8Array {
  const bytes = randomBytes(ULID_RANDOM_BYTES);
  if (bytes.length !== ULID_RANDOM_BYTES) {
    throw new Error("ULID_RANDOM_BYTES_INVALID");
  }
  return Uint8Array.from(bytes);
}

/** `createUlidFactory()` の任意設定。テスト専用。 */
export interface UlidFactoryDeps {
  /** 現在時刻（Unix epoch ミリ秒）。既定 `Date.now`。 */
  now?: () => number;
  /** 乱数源。既定 `crypto.getRandomValues`。 */
  randomBytes?: RandomBytes;
}

/**
 * 単調増加する ULID 生成器を作る。
 *
 * ── なぜ単調増加が必須か（Workers 固有）────────────────
 * Cloudflare Workers は I/O の合間に時計を進めない。`Date.now()` は
 * 直近の I/O 時点の値で固定される。したがって 1 リクエスト内で
 * 1,000 件のタスクを生成すると**全件のタイムスタンプが同一**になる。
 * 素朴な実装では並び順が乱数任せになり、完了条件「ULID 部分が
 * 時系列ソート可能」を満たさない。
 *
 * そこで同一ミリ秒ではランダム部を +1 する（ULID 規格の単調生成）。
 * Crockford の alphabet は ASCII 昇順なので、+1 した値の base32 表現は
 * 辞書順でも増加する。**生成順 = 辞書順** が保たれる。
 *
 * ── 時計が巻き戻ったとき ────────────────────────────────
 * 例外にせず直前のタイムスタンプに張り付けて +1 する。ID 生成が落ちると
 * 全書き込みが止まる。数ミリ秒古い時刻を載せるほうが害が小さく、順序は
 * 保たれる。`router.ts` の「曖昧なら落とす」を適用しないのは、シャード
 * 誤りと違いデータ破損に繋がらないため（DECISIONS #011）。
 *
 * 単調状態はファクトリごとに持つ。テスト同士が汚染し合わない。
 */
export function createUlidFactory(deps?: UlidFactoryDeps): () => string {
  const now = deps?.now ?? ((): number => Date.now());
  const randomBytes = deps?.randomBytes ?? cryptoRandomBytes;

  let lastTime = -1;
  // 型注釈を省くと `Uint8Array<ArrayBuffer>` に狭まり、`takeRandom()` の
  // `Uint8Array<ArrayBufferLike>` を代入できなくなる。
  let lastRandom: Uint8Array = new Uint8Array(ULID_RANDOM_BYTES);

  return (): string => {
    const time = assertUlidTime(now());
    if (time > lastTime) {
      lastTime = time;
      lastRandom = takeRandom(randomBytes);
    } else {
      // 同一ミリ秒、または時計の巻き戻し。順序を守るため lastTime を維持する。
      incrementRandom(lastRandom);
    }
    return encodeTime(lastTime) + encodeRandom(lastRandom);
  };
}

/** 既定の ULID 生成器。モジュール内で単調状態を 1 つ持つ。 */
const defaultUlid = createUlidFactory();

/** 26 桁の ULID を 1 つ返す。 */
export function ulid(): string {
  return defaultUlid();
}

// ────────────────────────────────────────────────────────────
// ID の組み立て・検証
// ────────────────────────────────────────────────────────────

/**
 * ID 全体の形式。
 *
 * orgShortId 部を生成 alphabet（31 文字）ではなく `[0-9a-z]{6}` で受けている。
 * 仕様書中の例 `o7k2m9` は `o` を含み生成器では作れないため、検証を生成
 * alphabet と揃えると仕様の例が「不正形式」になる。照合は完全一致で行うので、
 * 文字種を緩めても分離の強度は落ちない（長さと構造は厳格に見る）。
 *
 * 接頭辞は `_` を含まないため `o7k2m9__task_X__evil` のような入力は通らない。
 */
const ID_PATTERN = /^([0-9a-z]{6})__([a-z]+)_([0-9A-HJKMNP-TV-Z]{26})$/;

/** orgShortId 単体の形式。 */
const ORG_SHORT_ID_PATTERN = /^[0-9a-z]{6}$/;

/** ULID 単体の形式。Crockford Base32 大文字 26 桁。 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `parseId()` の戻り値。 */
export interface ParsedId {
  orgShortId: string;
  prefix: EntityPrefix;
  ulid: string;
}

function isEntityPrefix(value: string): value is EntityPrefix {
  return ENTITY_PREFIX_SET.has(value);
}

/**
 * ID を組み立てる。
 *
 * `ulidFn` はテスト用の差し替え口。本番経路では既定のまま使う。
 *
 * @throws `INVALID_ORG_SHORT_ID` / `INVALID_ENTITY_PREFIX` / `INVALID_ULID`
 */
export function generateId(
  orgShortId: string,
  prefix: EntityPrefix,
  ulidFn: () => string = defaultUlid,
): string {
  if (!ORG_SHORT_ID_PATTERN.test(orgShortId)) {
    throw new Error("INVALID_ORG_SHORT_ID");
  }
  if (!isEntityPrefix(prefix)) {
    // 型で弾けるが、JS からの呼び出しと `as` によるすり抜けが残る。
    throw new Error("INVALID_ENTITY_PREFIX");
  }
  const value = ulidFn();
  if (!ULID_PATTERN.test(value)) {
    // 壊れた生成器が返した値を永続 ID に載せない。
    // ここを通した ID は必ず `parseId()` で復元できる。
    throw new Error("INVALID_ULID");
  }
  return `${orgShortId}__${prefix}_${value}`;
}

/**
 * ID を 3 要素へ分解する。
 *
 * @throws `INVALID_ID_FORMAT` 形式不正、または未登録の接頭辞。
 */
export function parseId(id: string): ParsedId {
  const matched = ID_PATTERN.exec(id);
  const orgShortId = matched?.[1];
  const prefix = matched?.[2];
  const value = matched?.[3];
  if (orgShortId === undefined || prefix === undefined || value === undefined) {
    throw new Error("INVALID_ID_FORMAT");
  }
  if (!isEntityPrefix(prefix)) {
    throw new Error("INVALID_ID_FORMAT");
  }
  return { orgShortId, prefix, ulid: value };
}

/**
 * ID がセッションの組織のものかを検証する。第 2 層の要。
 *
 * **DB へ問い合わせる前に呼ぶこと。** 一元化は P0-10 の
 * `withResourceGuard()` ミドルウェアが行う。
 *
 * 仕様 §19.4 のスニペットは `id.split("__")[0]` を比較するだけだが、
 * それでは `o7k2m9__task_X__evil` のような入力が通る。ここでは形式全体を
 * 検証する（仕様より厳しく、緩くはならない）。
 *
 * 形式不正と越境で**同じ例外を投げる**。区別すると「形式は正しいが他組織」と
 * 「そもそも不正」が呼び分けられ、403 と同じくリソースの存在を示唆する。
 *
 * `ctx.orgShortId` 側も形式を見る。両方 `undefined` の比較が成立して
 * 素通りする経路（型を持たない呼び出し側）を塞ぐため。
 *
 * @throws {NotFoundError} `RESOURCE_NOT_FOUND`。呼び出し側が 404 に写像する。
 */
export function assertIdBelongsToTenant(id: string, ctx: ShardContext): void {
  if (!ORG_SHORT_ID_PATTERN.test(ctx.orgShortId)) {
    throw new NotFoundError();
  }
  let parsed: ParsedId;
  try {
    parsed = parseId(id);
  } catch {
    throw new NotFoundError();
  }
  if (parsed.orgShortId !== ctx.orgShortId) {
    throw new NotFoundError();
  }
}
