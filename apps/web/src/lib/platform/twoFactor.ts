/**
 * 運営担当者の第 2 要素（TOTP＋復旧コード / PF-17）。
 *
 * task:  docs/tasks/PF-17.md
 * ルール: .claude/rules/security.md §2・§7
 * 決定:  docs/DECISIONS.md #241
 *
 * ── ログインはここで成立する ────────────────────────────
 * `platformLogin()`（パスワード）は `PASSWORD_ONLY` の札しか出さない。
 * ここで TOTP か復旧コードが通ったときだけ `COMPLETE` の札を発行し、
 * 監査ログに `platform.login` を書く。
 *
 * ── 失敗の理由を返さない ────────────────────────────────
 * コードが違う・ロック中・未登録・秘密が壊れている — どこで落ちても
 * `{ ok: false }` 1 種類（security.md §2 の「失敗応答を一律にする」）。
 *
 * ── 試行回数制限 ────────────────────────────────────────
 * PIN と同じ考え方（security.md §2）: **5 回失敗で 15 分ロック。**
 * 6 桁 TOTP は候補 100 万通りで、KDF の強度は効かない。守るのは
 * このロックと、入口のレート制限（ルート側 / login と同じバケツ）。
 *
 * ── 復旧コードはハッシュだけ ────────────────────────────
 * 公開 API キーと同じ扱い（security.md §7）: 平文は発行の応答で
 * 1 回だけ返し、DB には SHA-256 だけを置く。**再表示の関数を作らない。**
 * コードは 50 bit の乱数なので総当たりは成立せず、KDF は要らない。
 *
 * ── 秘密・コードを持ち出さない ──────────────────────────
 * TOTP secret・復旧コード・OTP を**ログにも監査ログの `detail` にも
 * 入れない**（PF-17 の完了条件）。`detail` に入れてよいのは方式名と本数だけ。
 *
 * ── secret は暗号化して保存する（DECISIONS #244）────────
 * DB にあるのは `totpSecretBox.ts` の封筒（AES-256-GCM）。開封するのは
 * 検証の直前と登録画面の表示だけで、**開封できなければ認証失敗**へ倒す
 * （秘密の状態を応答に出さない）。
 *
 * ── ステップの消費は DB の条件付き UPDATE ───────────────
 * 「受理済みステップ以下を拒む」比較をアプリ側でやると、同じコードを
 * 載せた並行リクエストが両方通る。`consumePlatformTotpStep()` /
 * `confirmPlatformTwoFactor()` の **changes = 1 を取れた 1 本だけ**が
 * 成功し、そのときだけセッション発行と `platform.login` を行う。
 */

import {
  confirmPlatformTwoFactor,
  consumePlatformRecoveryCode,
  consumePlatformTotpStep,
  listActivePlatformRecoveryCodes,
  recordPlatformTwoFactorAttempt,
  replacePlatformRecoveryCodes,
  savePlatformTwoFactorSecret,
  type Env,
  type PlatformOperatorRow,
  type RandomBytes,
} from "@pk/db";

import { timingSafeEqual } from "../auth/pbkdf2.js";
import { buildOtpauthUri, generateTotpSecret, verifyTotpCode } from "../auth/totp.js";
import { sha256HexOfText } from "../evidence/hash.js";

import { auditQuietly, platformAuditId } from "./audit.js";
import { createPlatformSession, type CreatedPlatformSession } from "./session.js";
import { openTotpSecret, sealTotpSecret } from "./totpSecretBox.js";

/** 第 2 要素のロック方針。PIN と同じ（security.md §2）。**設定項目にしない。** */
export const PLATFORM_TWO_FACTOR_LOCK_POLICY = {
  /** 連続 5 回失敗で。 */
  maxFailures: 5,
  /** 15 分ロックする。 */
  lockSeconds: 15 * 60,
} as const;

/** 復旧コードの本数。 */
export const RECOVERY_CODE_COUNT = 10;

/** otpauth URI の発行者名。認証アプリの一覧に出る。 */
export const TOTP_ISSUER = "ProofKeeping";

/** 復旧コードの字母（RFC 4648 base32）。32 文字なので 1 バイトから偏りなく引ける。 */
const RECOVERY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 復旧コードの長さ（区切りを除く）。10 文字 = 50 bit。 */
const RECOVERY_CODE_LENGTH = 10;

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/** `XXXXX-XXXXX`。表示用の区切りは照合時に落とす。 */
function generateRecoveryCode(randomBytes: RandomBytes): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += RECOVERY_ALPHABET.charAt(byte & 31);
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** 照合前の正規化。大文字化し、区切り（ハイフン・空白）を落とす。 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

async function hashRecoveryCode(code: string): Promise<string> {
  return sha256HexOfText(normalizeRecoveryCode(code));
}

/** 発行した平文と保存用ハッシュの組。**平文はこの往復の外で保持しない。** */
interface IssuedRecoveryCodes {
  /** 画面に 1 回だけ出す平文。 */
  codes: string[];
  rows: { id: string; codeHash: string }[];
}

async function issueRecoveryCodes(
  now: Date,
  randomBytes: RandomBytes,
): Promise<IssuedRecoveryCodes> {
  const codes: string[] = [];
  const rows: { id: string; codeHash: string }[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = generateRecoveryCode(randomBytes);
    let suffix = "";
    for (const byte of randomBytes(6)) suffix += byte.toString(16).padStart(2, "0");
    codes.push(code);
    rows.push({
      // **ID をコードから導かない**（ID がコードのヒントにならないように乱数で振る）。
      id: `plat_rc_${String(now.getTime())}_${String(i).padStart(2, "0")}_${suffix}`,
      codeHash: await hashRecoveryCode(code),
    });
  }
  return { codes, rows };
}

/** 共通の入力。`randomBytes` を差し替えられるのはテストのためだけ。 */
export interface TwoFactorInput {
  operator: PlatformOperatorRow;
  code: string;
  /** 現在時刻。**`Date.now()` を直接呼ばない**（CLAUDE.md §5）。 */
  now: Date;
  /** 操作元 IP。監査ログの `ip` 列に入る。 */
  ip?: string | undefined;
  randomBytes?: RandomBytes | undefined;
}

/** 第 2 要素の結果。**失敗の内訳を持たせない。** */
export type SecondFactorResult =
  | {
      ok: true;
      session: CreatedPlatformSession;
      method: "TOTP" | "RECOVERY";
      /** 復旧コードで通ったときの残本数。TOTP のときは `null`。 */
      recoveryRemaining: number | null;
    }
  | { ok: false };

const FAILED: { ok: false } = { ok: false };

/**
 * TOTP の登録を始める（PF-17）。
 *
 * **未登録の担当者にしか秘密を作らない。** 登録済みに対して呼ぶと `null`
 * （パスワードだけ通った札で 2FA を掛け替えられる形にしない）。
 * 未確認の秘密が既にあればそれを返す — 確認 POST のたびに秘密が変わると、
 * 利用者のアプリに残った古い QR が永遠に通らない。
 */
export async function beginTotpEnrollment(
  env: Env,
  input: { operator: PlatformOperatorRow; now: Date; randomBytes?: RandomBytes | undefined },
): Promise<{ secret: string; otpauthUri: string } | null> {
  if (input.operator.twoFactorConfirmedAt !== null) return null;

  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  // 未確認の封筒が残っていれば開けて使い回す。**開封できない封筒
  // （鍵の交代・破損）は捨てて作り直す** — 未確認なので失うものが無い。
  let secret =
    input.operator.twoFactorSecret === null
      ? null
      : await openTotpSecret(env, input.operator.id, input.operator.twoFactorSecret);
  if (secret === null) {
    secret = generateTotpSecret(randomBytes);
    await savePlatformTwoFactorSecret(env, {
      operatorId: input.operator.id,
      // **平文を DB へ渡さない。** 封をしてから保存する（DECISIONS #244）。
      sealedSecret: await sealTotpSecret(env, input.operator.id, secret, randomBytes),
      now: input.now,
    });
  }
  return { secret, otpauthUri: buildOtpauthUri(secret, input.operator.email, TOTP_ISSUER) };
}

/** ロック中か。**検証は行ってから使う**（応答時間で状態を読ませない）。 */
function isLocked(operator: PlatformOperatorRow, now: Date): boolean {
  return (
    operator.twoFactorLockedUntil !== null &&
    operator.twoFactorLockedUntil.getTime() > now.getTime()
  );
}

async function recordFailure(env: Env, input: TwoFactorInput, phase: string): Promise<void> {
  await recordPlatformTwoFactorAttempt(env, {
    operatorId: input.operator.id,
    success: false,
    now: input.now,
    maxAttempts: PLATFORM_TWO_FACTOR_LOCK_POLICY.maxFailures,
    lockMs: PLATFORM_TWO_FACTOR_LOCK_POLICY.lockSeconds * 1000,
  });
  // **失敗も毎回残す**（platform.login.failed と同じ理由 — 母数が小さく、
  // 試行の痕跡が無いと総当たりに気づけない）。`detail` は段階名だけ。
  await auditQuietly(env, {
    id: platformAuditId(input.now, input.randomBytes),
    operatorId: input.operator.id,
    action: "platform.2fa.failed",
    detail: { phase },
    now: input.now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });
}

/** `COMPLETE` の札を発行し、`platform.login` を書く（ログインの成立点）。 */
async function completeLogin(
  env: Env,
  input: TwoFactorInput,
  method: "TOTP" | "RECOVERY",
): Promise<CreatedPlatformSession> {
  await auditQuietly(env, {
    id: platformAuditId(input.now, input.randomBytes),
    operatorId: input.operator.id,
    action: "platform.login",
    detail: { secondFactor: method },
    now: input.now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });
  return createPlatformSession(env, {
    operatorId: input.operator.id,
    state: "COMPLETE",
    now: input.now,
  });
}

/**
 * 登録を確認する（PF-17）。通れば復旧コードを発行し、ログインも成立する。
 *
 * 返る `recoveryCodes` は**このとき 1 回だけ**画面に出す。保存しない・
 * 再表示しない（security.md §7 の公開 API キーと同じ扱い）。
 */
export async function confirmTotpEnrollment(
  env: Env,
  input: TwoFactorInput,
): Promise<{ ok: true; session: CreatedPlatformSession; recoveryCodes: string[] } | { ok: false }> {
  const { operator, now } = input;
  if (operator.twoFactorConfirmedAt !== null) return FAILED;
  if (operator.twoFactorSecret === null) return FAILED;

  // **開封できない封筒は認証失敗**（鍵未設定・改竄・鍵違いを区別しない）。
  const secret = await openTotpSecret(env, operator.id, operator.twoFactorSecret);
  if (secret === null) return FAILED;

  // **ロック中でも検証は行う**（即返すと応答時間で状態が読める）。
  const matchedStep = await verifyTotpCode(secret, input.code, now.getTime());
  if (isLocked(operator, now) || operator.status !== "ACTIVE") return FAILED;

  if (matchedStep === null) {
    await recordFailure(env, input, "enroll");
    return FAILED;
  }

  // 条件付き UPDATE（`confirmed_at IS NULL`）。**changes = 1 を取れた
  // 1 本だけ**が先へ進む — 同じコードで同時に確認しても、復旧コードと
  // セッションが二重に出ることはない。
  const confirmed = await confirmPlatformTwoFactor(env, {
    operatorId: operator.id,
    lastStep: matchedStep,
    now,
  });
  if (!confirmed) {
    await recordFailure(env, input, "enroll");
    return FAILED;
  }

  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const issued = await issueRecoveryCodes(now, randomBytes);
  await replacePlatformRecoveryCodes(env, { operatorId: operator.id, codes: issued.rows, now });

  await auditQuietly(env, {
    id: platformAuditId(now, input.randomBytes),
    operatorId: operator.id,
    action: "platform.2fa.enrolled",
    detail: { recoveryCodes: issued.rows.length },
    now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  const session = await completeLogin(env, input, "TOTP");
  return { ok: true, session, recoveryCodes: issued.codes };
}

/**
 * ログインの第 2 要素を検証する（PF-17）。
 *
 * 6 桁の数字は TOTP、それ以外は復旧コードとして照合する（形が重ならない —
 * 復旧コードの字母に数字だけの並びはあり得るが長さが 10 で、6 桁と衝突しない）。
 */
export async function verifySecondFactor(
  env: Env,
  input: TwoFactorInput,
): Promise<SecondFactorResult> {
  const { operator, now } = input;
  if (operator.status !== "ACTIVE") return FAILED;
  if (operator.twoFactorConfirmedAt === null || operator.twoFactorSecret === null) return FAILED;

  if (/^\d{6}$/.test(input.code.trim())) {
    // **開封できない封筒は認証失敗**（鍵未設定・改竄・鍵違いを区別しない）。
    const secret = await openTotpSecret(env, operator.id, operator.twoFactorSecret);
    if (secret === null) return FAILED;

    const matchedStep = await verifyTotpCode(secret, input.code.trim(), now.getTime());
    if (isLocked(operator, now)) return FAILED;
    if (matchedStep === null) {
      await recordFailure(env, input, "login");
      return FAILED;
    }

    // **受理済みステップ以下は DB の条件付き UPDATE が拒む**（RFC 6238 §5.2）。
    // アプリ側で行の値と比べない — 読みが交差した並行リクエストが
    // 両方通る。changes = 1 を取れた 1 本だけが成功する。
    const consumed = await consumePlatformTotpStep(env, {
      operatorId: operator.id,
      matchedStep,
      now,
    });
    if (!consumed) {
      await recordFailure(env, input, "login");
      return FAILED;
    }

    await auditQuietly(env, {
      id: platformAuditId(now, input.randomBytes),
      operatorId: operator.id,
      action: "platform.2fa.verified",
      detail: { method: "totp" },
      now,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
    const session = await completeLogin(env, input, "TOTP");
    return { ok: true, session, method: "TOTP", recoveryRemaining: null };
  }

  return verifyWithRecoveryCode(env, input);
}

/** 復旧コードで通す。**1 本 1 回**（消費は行の条件付き UPDATE が担保）。 */
async function verifyWithRecoveryCode(
  env: Env,
  input: TwoFactorInput,
): Promise<SecondFactorResult> {
  const { operator, now } = input;
  const givenHash = await hashRecoveryCode(input.code);
  const active = await listActivePlatformRecoveryCodes(env, operator.id);

  // 一致しても最後まで回す（どの行かを実行時間に出さない）。
  const encoder = new TextEncoder();
  const given = encoder.encode(givenHash);
  let matchedId: string | null = null;
  for (const row of active) {
    if (timingSafeEqual(encoder.encode(row.codeHash), given)) matchedId ??= row.id;
  }

  if (isLocked(operator, now)) return FAILED;
  if (matchedId === null) {
    await recordFailure(env, input, "recovery");
    return FAILED;
  }

  const consumed = await consumePlatformRecoveryCode(env, {
    id: matchedId,
    operatorId: operator.id,
    now,
  });
  if (!consumed) {
    // 同時消費に負けた = 既に使われた。**使用済みは無効**（PF-17 の完了条件）。
    await recordFailure(env, input, "recovery");
    return FAILED;
  }

  await recordPlatformTwoFactorAttempt(env, {
    operatorId: operator.id,
    success: true,
    now,
    maxAttempts: PLATFORM_TWO_FACTOR_LOCK_POLICY.maxFailures,
    lockMs: PLATFORM_TWO_FACTOR_LOCK_POLICY.lockSeconds * 1000,
  });
  const remaining = active.length - 1;
  await auditQuietly(env, {
    id: platformAuditId(now, input.randomBytes),
    operatorId: operator.id,
    action: "platform.2fa.recovery.used",
    detail: { remaining },
    now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });
  const session = await completeLogin(env, input, "RECOVERY");
  return { ok: true, session, method: "RECOVERY", recoveryRemaining: remaining };
}

/**
 * 復旧コードを再発行する（PF-17）。既存の未使用コードはすべて失効する。
 *
 * **現在の TOTP コードを要求する。** `COMPLETE` の札を盗んだだけの相手に
 * 復旧コードを刷り直させない（画面はログイン済み領域にある）。
 */
export async function regenerateRecoveryCodes(
  env: Env,
  input: TwoFactorInput,
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false }> {
  const { operator, now } = input;
  if (operator.status !== "ACTIVE") return FAILED;
  if (operator.twoFactorConfirmedAt === null || operator.twoFactorSecret === null) return FAILED;

  // **開封できない封筒は認証失敗**（鍵未設定・改竄・鍵違いを区別しない）。
  const secret = await openTotpSecret(env, operator.id, operator.twoFactorSecret);
  if (secret === null) return FAILED;

  const matchedStep = await verifyTotpCode(secret, input.code.trim(), now.getTime());
  if (isLocked(operator, now)) return FAILED;
  if (matchedStep === null) {
    await recordFailure(env, input, "regenerate");
    return FAILED;
  }

  // ログインの検証と同じく、ステップの消費は条件付き UPDATE（changes = 1 の
  // 1 本だけが通る）。同じコードの 2 回目・並行の 2 本目はここで落ちる。
  const consumed = await consumePlatformTotpStep(env, {
    operatorId: operator.id,
    matchedStep,
    now,
  });
  if (!consumed) {
    await recordFailure(env, input, "regenerate");
    return FAILED;
  }

  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const issued = await issueRecoveryCodes(now, randomBytes);
  await replacePlatformRecoveryCodes(env, { operatorId: operator.id, codes: issued.rows, now });

  await auditQuietly(env, {
    id: platformAuditId(now, input.randomBytes),
    operatorId: operator.id,
    action: "platform.2fa.recovery.regenerated",
    detail: { recoveryCodes: issued.rows.length },
    now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });
  return { ok: true, recoveryCodes: issued.codes };
}

/** 有効な復旧コードの残本数（`/plat/2fa/recovery` の表示用）。 */
export async function countActiveRecoveryCodes(env: Env, operatorId: string): Promise<number> {
  return (await listActivePlatformRecoveryCodes(env, operatorId)).length;
}
