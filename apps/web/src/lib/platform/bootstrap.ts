/**
 * 運営担当者の初期開通（PF-16 / **1 人目だけ**）。
 *
 * task:  docs/tasks/PF-16.md
 * 決定:  docs/DECISIONS.md #240（オーナー判断）・#245（この実装）
 * ルール: .claude/rules/security.md §2・§6・§7
 * 手順:  docs/runbook/platform-bootstrap.md
 *
 * ── 経路は 2 本だけ ─────────────────────────────────────
 *   ① 発行  `issuePlatformBootstrap()` — 人が押した workflow から 1 回
 *   ② 開通  `activatePlatformBootstrap()` — 本人がリンクを開いて 1 回
 *
 * ── 券の段階で運営担当者を作らない ──────────────────────
 * 作るなら `password_hash` を何かで埋めることになる。**既定パスワードを
 * 作らない**（#240 の 3）を型のうえで満たすため、行が生えるのは本人が
 * パスワードを決めた瞬間だけにする。
 *
 * ── 平文の token はこのファイルの外へ出ない ─────────────
 * 生成 → メール本文に 1 回だけ載せる → 捨てる。**戻り値にも監査ログにも
 * ログにも入れない**（要件 10）。DB にあるのは SHA-256 だけで、ダンプから
 * 開通リンクは再構成できない。
 *
 * ── 失敗の理由を外へ広げない ────────────────────────────
 * 開通側（②）は「無い・使用済み・失効・期限切れ・既に運営担当者が居る」を
 * **すべて `REJECTED` 1 種類**にする（要件「期限切れ、使用済み、不正 token は
 * 同じ失敗応答にする」）。パスワードの規約違反だけは分けてよい — 有効な券を
 * 持っている本人に対して「なぜ設定できないか」を伏せる理由が無い。
 *
 * ── 1 人目であることは DB が保証する ────────────────────
 * 発行時にも既存の運営担当者を見て断るが、**保証しているのは開通時の
 * `createFirstPlatformOperator()`**（`INSERT ... WHERE NOT EXISTS` の
 * 条件付き 1 文）。数えてから書く形にすると、交差した 2 本が両方通る。
 */

import { passwordSchema } from "@pk/contracts";
import {
  consumePlatformBootstrapToken,
  createFirstPlatformOperator,
  createPlatformBootstrapToken,
  findActivePlatformBootstrapToken,
  platformOperatorExists,
  revokePlatformBootstrapTokens,
  type Env,
  type RandomBytes,
} from "@pk/db";

import { hashPassword } from "../auth/password.js";
import { sha256HexOfText } from "../evidence/hash.js";

import { auditQuietly, platformAuditId } from "./audit.js";
import { sendBootstrapLink } from "./bootstrapMail.js";
import { createPlatformSession, type CreatedPlatformSession } from "./session.js";

/**
 * 開通リンクの有効期間。**30 分**（#240 の 4「短時間だけ有効」）。
 *
 * メール 1 通が届いて、受け取った人がパスワードを決めるまでに要る長さだけ
 * 持たせる。**設定項目にしない**（PK-IMPL-CONTRACT §11.4）。切れたら
 * workflow をもう一度押す — 押せる人しか押せないので、それが正しい復旧手順。
 */
export const BOOTSTRAP_TOKEN_TTL_SECONDS = 30 * 60;

/** 開通 token の長さ（バイト）。base64url で 43 文字になる。 */
const TOKEN_BYTES = 32;

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 券の ID。**token から導かない**（ID が token のヒントにならないようにする）。 */
function bootstrapTokenId(now: Date, randomBytes: RandomBytes): string {
  let suffix = "";
  for (const byte of randomBytes(12)) suffix += byte.toString(16).padStart(2, "0");
  return `plat_bs_${String(now.getTime())}_${suffix}`;
}

/**
 * 発行の結果。**`ok: true` でも token を返さない。**
 *
 * 呼び出し元は API ハンドラ（＝ workflow の runner が受け取る応答）で、
 * そこへ渡したものは GitHub Actions のログに出る可能性がある。
 * 返すのは「いつ切れるか」だけ。
 */
export type IssueBootstrapResult =
  | { ok: true; expiresAt: Date }
  | {
      ok: false;
      /**
       * `OPERATOR_EXISTS` 既に運営担当者が居る（要件 8）
       * `DELIVERY_UNAVAILABLE` メールの経路が無い（**何も作っていない**）
       * `DELIVERY_FAILED` 送信に失敗した（**券は失効させた**）
       */
      reason: "OPERATOR_EXISTS" | "DELIVERY_UNAVAILABLE" | "DELIVERY_FAILED";
    };

export interface IssueBootstrapInput {
  email: string;
  displayName: string;
  /** 現在時刻。**`Date.now()` を直接呼ばない**（CLAUDE.md §5）。 */
  now: Date;
  ip?: string | undefined;
  randomBytes?: RandomBytes | undefined;
}

/**
 * 開通リンクを 1 本発行し、**メールで 1 回だけ渡す**（PF-16 の ①）。
 *
 * 手順は 5 つ。**どの段階で落ちても token は外へ出ない。**
 *   1. 送れる経路があるか（無ければ**何も作らずに**断る）
 *   2. 運営担当者が居ないか（居れば断る / 要件 8）
 *   3. 未使用の券をすべて失効させる（有効なリンクを 2 本作らない）
 *   4. 券を作る（DB にはハッシュだけ）
 *   5. 送る。**送れなければ券を失効させて**断る
 */
export async function issuePlatformBootstrap(
  env: Env,
  input: IssueBootstrapInput,
): Promise<IssueBootstrapResult> {
  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const audit = (action: string, detail?: Record<string, unknown>) =>
    auditQuietly(env, {
      id: platformAuditId(input.now, randomBytes),
      // 運営担当者はまだ居ない。**主体は空**（`platform_audit_log` の注記）。
      operatorId: null,
      action,
      targetType: "platform_bootstrap",
      ...(detail === undefined ? {} : { detail }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      now: input.now,
    });

  // 1. **送れないなら作らない。** 券だけができて誰にも渡らない状態を残さない。
  //    ここで「代わりにログへ出す」ことはしない（要件）。
  if (!canDeliverBootstrapLink(env)) {
    await audit("platform.bootstrap.rejected", { reason: "DELIVERY_UNAVAILABLE" });
    return { ok: false, reason: "DELIVERY_UNAVAILABLE" };
  }

  // 2. 既に居るなら断る（要件 8）。**2 人目以降は PF-14 の招待が持つ。**
  if (await platformOperatorExists(env)) {
    await audit("platform.bootstrap.rejected", { reason: "OPERATOR_EXISTS" });
    return { ok: false, reason: "OPERATOR_EXISTS" };
  }

  // 3. 前に出した券を失効させる。**有効な開通リンクは常に 1 本以下。**
  await revokePlatformBootstrapTokens(env, input.now);

  // 4. 券を作る。**平文はここから先、メール本文にしか現れない。**
  const token = toBase64Url(randomBytes(TOKEN_BYTES));
  const id = bootstrapTokenId(input.now, randomBytes);
  const expiresAt = new Date(input.now.getTime() + BOOTSTRAP_TOKEN_TTL_SECONDS * 1000);
  await createPlatformBootstrapToken(env, {
    id,
    email: input.email,
    displayName: input.displayName,
    tokenHash: await sha256HexOfText(token),
    expiresAt,
    now: input.now,
  });

  // 5. 送る。**失敗したら券を失効させる** — 届いていないリンクを 30 分
  //    生かしておく理由が無い（再実行はやり直しから始められる）。
  const delivered = await sendBootstrapLink(env, {
    to: input.email,
    link: buildBootstrapLink(env, token),
    expiresAt,
  });
  if (!delivered) {
    await revokePlatformBootstrapTokens(env, input.now);
    await audit("platform.bootstrap.delivery_failed", { tokenId: id });
    return { ok: false, reason: "DELIVERY_FAILED" };
  }

  // **`detail` に入れてよいのは券の ID と期限まで。** メールアドレスも
  // token も入れない（要件 10 / security.md §6）。
  await audit("platform.bootstrap.issued", {
    tokenId: id,
    expiresAt: expiresAt.toISOString(),
  });
  return { ok: true, expiresAt };
}

/** 開通リンク。**`APP_BASE_URL` は環境ごとの vars**（wrangler.toml）。 */
export function buildBootstrapLink(env: Pick<Env, "APP_BASE_URL">, token: string): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, "")}/plat/bootstrap/${token}`;
}

/** メールを送れる環境か。**鍵が無ければ発行そのものを断る。** */
function canDeliverBootstrapLink(env: Pick<Env, "RESEND_API_KEY">): boolean {
  return typeof env.RESEND_API_KEY === "string" && env.RESEND_API_KEY.trim() !== "";
}

/** 開通の画面に出してよい情報。**token も期限の秒数も含めない。** */
export interface BootstrapInvitation {
  email: string;
  displayName: string;
}

/**
 * 券が生きているかだけを見る（開通画面の GET / PF-16 の ②-1）。
 *
 * **ここでは消費しない。** メールのリンクはプレビュー・スキャナ・
 * 先読みで開かれることがあり、GET で消すと本人が着く前に燃える。
 * 消費は POST（`activatePlatformBootstrap()`）で行う。
 */
export async function findBootstrapInvitation(
  env: Env,
  input: { token: string; now: Date },
): Promise<BootstrapInvitation | null> {
  const row = await findActivePlatformBootstrapToken(env, {
    tokenHash: await sha256HexOfText(input.token),
    now: input.now,
  });
  if (row === null) return null;
  return { email: row.email, displayName: row.displayName };
}

/**
 * 開通の結果。
 *
 * `REJECTED` は**券の側の失敗すべて**（無い・使用済み・失効・期限切れ・
 * 既に運営担当者が居る）。`POLICY_VIOLATION` はパスワードの規約違反だけ。
 */
export type ActivateBootstrapResult =
  | { ok: true; session: CreatedPlatformSession; operatorId: string }
  | { ok: false; reason: "REJECTED" | "POLICY_VIOLATION" };

const REJECTED: ActivateBootstrapResult = { ok: false, reason: "REJECTED" };

export interface ActivateBootstrapInput {
  token: string;
  /** 平文。**ログ・監査ログ・例外メッセージへ出さないこと。** */
  password: string;
  now: Date;
  ip?: string | undefined;
  randomBytes?: RandomBytes | undefined;
}

/**
 * 開通する（PF-16 の ②-2）。パスワードを決め、運営担当者を 1 名だけ作る。
 *
 * 手順は 5 つ。**順序に意味がある。**
 *   1. 券が生きているか（**まだ消費しない**）
 *   2. パスワードの規約（**規約違反で券を燃やさない**）
 *   3. 券を**原子的に**消費する（同時に来た 2 本のうち 1 本だけが通る）
 *   4. パスワードをハッシュ化し、**条件付き INSERT** で 1 人目を作る
 *   5. `PASSWORD_ONLY` の札を出す（**この先は PF-17 の 2FA 登録が必須**）
 *
 * 4 で負けたときに券を戻さないのは意図的。戻すと、負けた側が同じ券で
 * 再試行できてしまう（開通は 1 回きりの操作で、やり直しは再発行から）。
 */
export async function activatePlatformBootstrap(
  env: Env,
  input: ActivateBootstrapInput,
): Promise<ActivateBootstrapResult> {
  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const tokenHash = await sha256HexOfText(input.token);
  const audit = (
    action: string,
    operatorId: string | null,
    detail?: Record<string, unknown>,
  ) =>
    auditQuietly(env, {
      id: platformAuditId(input.now, randomBytes),
      operatorId,
      action,
      targetType: "platform_bootstrap",
      ...(detail === undefined ? {} : { detail }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      now: input.now,
    });

  // 1. 生きている券か。**理由は返さない。**
  const invitation = await findActivePlatformBootstrapToken(env, { tokenHash, now: input.now });
  if (invitation === null) {
    await audit("platform.bootstrap.activation.rejected", null, { reason: "TOKEN_INVALID" });
    return REJECTED;
  }

  // 2. 規約（10 文字以上・英大小・数字 / security.md §2）。
  //    **券を消費する前に見る** — 打ち間違いで 1 回きりの券を失わせない。
  if (!passwordSchema.safeParse(input.password).success) {
    return { ok: false, reason: "POLICY_VIOLATION" };
  }

  // 3. **1 回だけ成功する消費。** 条件付き UPDATE（DB 側の保証）。
  if (!(await consumePlatformBootstrapToken(env, { tokenHash, now: input.now }))) {
    await audit("platform.bootstrap.activation.rejected", null, { reason: "TOKEN_INVALID" });
    return REJECTED;
  }

  // 4. **1 人目だけ。** `INSERT ... WHERE NOT EXISTS` が保証する（要件 8）。
  const operatorId = `plat_op_${String(input.now.getTime())}_${randomHex(randomBytes)}`;
  const created = await createFirstPlatformOperator(env, {
    id: operatorId,
    email: invitation.email,
    displayName: invitation.displayName,
    passwordHash: await hashPassword(input.password, randomBytes),
    now: input.now,
  });
  if (!created) {
    await audit("platform.bootstrap.activation.rejected", null, { reason: "OPERATOR_EXISTS" });
    return REJECTED;
  }

  await audit("platform.bootstrap.completed", operatorId, { tokenId: invitation.id });

  // 5. **パスワードだけの札**（10 分）。ログイン後の画面へはまだ入れない —
  //    `/plat/2fa/setup` で TOTP を登録し復旧コードを控えるまで、
  //    `requirePlatformOperator()` が 404 を返す（PF-17）。
  return {
    ok: true,
    operatorId,
    session: await createPlatformSession(
      env,
      { operatorId, state: "PASSWORD_ONLY", now: input.now },
      randomBytes,
    ),
  };
}

function randomHex(randomBytes: RandomBytes): string {
  let hex = "";
  for (const byte of randomBytes(12)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
