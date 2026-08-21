/**
 * 運営面の監査記録の小物（PF-01 の login.ts から PF-17 で切り出し）。
 *
 * ログイン（`login.ts`）と第 2 要素（`twoFactor.ts`）が同じ形で記録する。
 * **`detail` に秘密・コード・OTP を入れないこと**（PF-17 の完了条件）。
 */

import { recordPlatformAudit, type Env, type RandomBytes } from "@pk/db";

/** 監査ログの ID。`plat_audit_{epoch}_{乱数}`。 */
export function platformAuditId(now: Date, randomBytes: RandomBytes | undefined): string {
  const bytes = (randomBytes ?? ((size: number) => crypto.getRandomValues(new Uint8Array(size))))(
    12,
  );
  let suffix = "";
  for (const byte of bytes) suffix += byte.toString(16).padStart(2, "0");
  return `plat_audit_${String(now.getTime())}_${suffix}`;
}

/**
 * 監査の失敗で認証を壊さない。
 *
 * ここで投げると、記録できないときだけ応答が 500 になり、**失敗の理由が
 * 応答から読める**（`AUTH_FAILED` 一本の原則が崩れる）。
 */
export async function auditQuietly(
  env: Env,
  input: Parameters<typeof recordPlatformAudit>[1],
): Promise<void> {
  try {
    await recordPlatformAudit(env, input);
  } catch {
    // 握りつぶす（上の注記）。
  }
}
