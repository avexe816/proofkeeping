/**
 * 第 2 要素（TOTP＋復旧コード / PF-17）。
 *
 * ── リポジトリ層を差し替える理由 ────────────────────────
 * 確かめたいのは「どの失敗も同じ結果になるか」「1 本 1 回」「監査に何が
 * 残り、**何が残らないか**」であって SQL ではない（login.spec.ts と同じ作り）。
 *
 * ── 秘密の非露出は走査で固定する ────────────────────────
 * `recordPlatformAudit` へ渡った全引数を JSON にし、TOTP secret・OTP・
 * 復旧コードの平文が**一切含まれない**ことを毎ケース確かめる。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmPlatformTwoFactor = vi.fn();
const consumePlatformRecoveryCode = vi.fn();
const listActivePlatformRecoveryCodes = vi.fn();
const recordPlatformAudit = vi.fn();
const recordPlatformTwoFactorAttempt = vi.fn();
const replacePlatformRecoveryCodes = vi.fn();
const savePlatformTwoFactorSecret = vi.fn();

vi.mock("@pk/db", () => ({
  confirmPlatformTwoFactor: (...args: unknown[]) => confirmPlatformTwoFactor(...args) as unknown,
  consumePlatformRecoveryCode: (...args: unknown[]) =>
    consumePlatformRecoveryCode(...args) as unknown,
  listActivePlatformRecoveryCodes: (...args: unknown[]) =>
    listActivePlatformRecoveryCodes(...args) as unknown,
  recordPlatformAudit: (...args: unknown[]) => recordPlatformAudit(...args) as unknown,
  recordPlatformTwoFactorAttempt: (...args: unknown[]) =>
    recordPlatformTwoFactorAttempt(...args) as unknown,
  replacePlatformRecoveryCodes: (...args: unknown[]) =>
    replacePlatformRecoveryCodes(...args) as unknown,
  savePlatformTwoFactorSecret: (...args: unknown[]) =>
    savePlatformTwoFactorSecret(...args) as unknown,
}));

const { computeTotpCode, totpStep } = await import("../auth/totp.js");
const { sha256HexOfText } = await import("../evidence/hash.js");
const {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  normalizeRecoveryCode,
  regenerateRecoveryCodes,
  verifySecondFactor,
  PLATFORM_TWO_FACTOR_LOCK_POLICY,
  RECOVERY_CODE_COUNT,
} = await import("./twoFactor.js");
const { createFakeKv } = await import("../auth/test-support/fake-kv.js");

type Env = import("@pk/db").Env;
type PlatformOperatorRow = import("@pk/db").PlatformOperatorRow;

const OPERATOR_ID = "plat_op_01JBXQ3ZK8N4P2VYR60000";
/** RFC 6238 のテスト秘密。 */
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const NOW = new Date("2026-08-21T09:00:00.000Z");

let env: Env;

function operatorRow(overrides: Partial<PlatformOperatorRow> = {}): PlatformOperatorRow {
  return {
    id: OPERATOR_ID,
    email: "ops@stek.ai",
    displayName: "運営 太郎",
    passwordHash: "pbkdf2$sha256$5000$x$y",
    status: "ACTIVE",
    failedAttempts: 0,
    lockedUntil: null,
    twoFactorSecret: SECRET,
    twoFactorConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
    twoFactorFailedAttempts: 0,
    twoFactorLockedUntil: null,
    twoFactorLastStep: null,
    ...overrides,
  };
}

/** いまの正しい TOTP。 */
async function currentCode(): Promise<string> {
  const code = await computeTotpCode(SECRET, totpStep(NOW.getTime()));
  if (code === null) throw new Error("test secret broken");
  return code;
}

/** 監査へ渡った全引数の JSON。**秘密の非露出をここで走査する。** */
function auditJson(): string {
  return JSON.stringify(recordPlatformAudit.mock.calls);
}

function auditActions(): string[] {
  return recordPlatformAudit.mock.calls.map(
    (call) => (call[1] as { action: string }).action,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  env = { SESSION: createFakeKv().namespace, SESSION_SECRET: "test-secret" } as unknown as Env;
  confirmPlatformTwoFactor.mockResolvedValue(undefined);
  consumePlatformRecoveryCode.mockResolvedValue(true);
  listActivePlatformRecoveryCodes.mockResolvedValue([]);
  recordPlatformAudit.mockResolvedValue(undefined);
  recordPlatformTwoFactorAttempt.mockResolvedValue(undefined);
  replacePlatformRecoveryCodes.mockResolvedValue(undefined);
  savePlatformTwoFactorSecret.mockResolvedValue(undefined);
});

afterEach(async () => {
  // **どのケースでも** TOTP secret と OTP が監査へ漏れていないこと（完了条件）。
  const json = auditJson();
  expect(json).not.toContain(SECRET);
  expect(json).not.toContain(await currentCode());
});

describe("登録の開始（beginTotpEnrollment）", () => {
  it("未登録なら秘密を作り、未確認のまま保存する", async () => {
    const result = await beginTotpEnrollment(env, {
      operator: operatorRow({ twoFactorSecret: null, twoFactorConfirmedAt: null }),
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(result?.otpauthUri).toContain("otpauth://totp/");
    expect(savePlatformTwoFactorSecret).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ operatorId: OPERATOR_ID, secret: result?.secret }),
    );
  });

  it("未確認の秘密が残っていればそれを使い回す（QR を無効にしない）", async () => {
    const result = await beginTotpEnrollment(env, {
      operator: operatorRow({ twoFactorSecret: SECRET, twoFactorConfirmedAt: null }),
      now: NOW,
    });
    expect(result?.secret).toBe(SECRET);
    expect(savePlatformTwoFactorSecret).not.toHaveBeenCalled();
  });

  it("**登録済みには秘密を作らない**（パスワードだけで 2FA を掛け替えさせない）", async () => {
    const result = await beginTotpEnrollment(env, { operator: operatorRow(), now: NOW });
    expect(result).toBeNull();
    expect(savePlatformTwoFactorSecret).not.toHaveBeenCalled();
  });
});

describe("登録の確認（confirmTotpEnrollment）", () => {
  const enrolling = () => operatorRow({ twoFactorConfirmedAt: null });

  it("正しいコードで確定し、復旧コード 10 本と COMPLETE の札が出る", async () => {
    const result = await confirmTotpEnrollment(env, {
      operator: enrolling(),
      code: await currentCode(),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of result.recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(result.session.record.state).toBe("COMPLETE");
    expect(confirmPlatformTwoFactor).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ operatorId: OPERATOR_ID, lastStep: totpStep(NOW.getTime()) }),
    );
  });

  it("**DB へ渡るのはハッシュだけ**（走査 / 完了条件）", async () => {
    const result = await confirmTotpEnrollment(env, {
      operator: enrolling(),
      code: await currentCode(),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = JSON.stringify(replacePlatformRecoveryCodes.mock.calls);
    for (const code of result.recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(normalizeRecoveryCode(code));
    }
    const rows = (
      replacePlatformRecoveryCodes.mock.calls[0]?.[1] as {
        codes: { codeHash: string }[];
      }
    ).codes;
    expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
    for (const [i, row] of rows.entries()) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      const plain = result.recoveryCodes[i] ?? "";
      expect(row.codeHash).toBe(await sha256HexOfText(normalizeRecoveryCode(plain)));
    }
  });

  it("登録と ログインの成立が監査に残る（enrolled → login）", async () => {
    await confirmTotpEnrollment(env, {
      operator: enrolling(),
      code: await currentCode(),
      now: NOW,
      ip: "203.0.113.9",
    });
    expect(auditActions()).toEqual(["platform.2fa.enrolled", "platform.login"]);
    // detail に載るのは本数だけ。
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        action: "platform.2fa.enrolled",
        detail: { recoveryCodes: RECOVERY_CODE_COUNT },
        ip: "203.0.113.9",
      }),
    );
  });

  it("**復旧コードの平文が監査に出ない**（走査 / 完了条件）", async () => {
    const result = await confirmTotpEnrollment(env, {
      operator: enrolling(),
      code: await currentCode(),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = auditJson();
    for (const code of result.recoveryCodes) {
      expect(json).not.toContain(code);
      expect(json).not.toContain(normalizeRecoveryCode(code));
    }
  });

  it("コードが違うと失敗し、試行として数える", async () => {
    const result = await confirmTotpEnrollment(env, {
      operator: enrolling(),
      code: "000000",
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(recordPlatformTwoFactorAttempt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        operatorId: OPERATOR_ID,
        success: false,
        maxAttempts: PLATFORM_TWO_FACTOR_LOCK_POLICY.maxFailures,
        lockMs: PLATFORM_TWO_FACTOR_LOCK_POLICY.lockSeconds * 1000,
      }),
    );
    expect(auditActions()).toEqual(["platform.2fa.failed"]);
    expect(confirmPlatformTwoFactor).not.toHaveBeenCalled();
  });

  it("登録済みの担当者では失敗する（掛け替えの経路にしない）", async () => {
    const result = await confirmTotpEnrollment(env, {
      operator: operatorRow(),
      code: await currentCode(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(confirmPlatformTwoFactor).not.toHaveBeenCalled();
  });

  it("ロック中は正しいコードでも失敗する（試行回数制限 / 完了条件）", async () => {
    const result = await confirmTotpEnrollment(env, {
      operator: operatorRow({
        twoFactorConfirmedAt: null,
        twoFactorLockedUntil: new Date(NOW.getTime() + 60_000),
      }),
      code: await currentCode(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(confirmPlatformTwoFactor).not.toHaveBeenCalled();
  });
});

describe("ログインの第 2 要素（verifySecondFactor / TOTP）", () => {
  it("正しい 6 桁で COMPLETE の札が出て、verified と login が残る", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow(),
      code: await currentCode(),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe("TOTP");
    expect(result.session.record.state).toBe("COMPLETE");
    expect(auditActions()).toEqual(["platform.2fa.verified", "platform.login"]);
    expect(recordPlatformTwoFactorAttempt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ success: true, lastStep: totpStep(NOW.getTime()) }),
    );
  });

  it("**同じステップのコードは 2 回使えない**（RFC 6238 §5.2）", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow({ twoFactorLastStep: totpStep(NOW.getTime()) }),
      code: await currentCode(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(auditActions()).toEqual(["platform.2fa.failed"]);
  });

  it("コードが違うと失敗として数える", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow(),
      code: "000000",
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(recordPlatformTwoFactorAttempt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ success: false }),
    );
  });

  it("ロック中は正しいコードでも失敗する", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow({ twoFactorLockedUntil: new Date(NOW.getTime() + 60_000) }),
      code: await currentCode(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
  });

  it("ロックが切れていれば通る", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow({ twoFactorLockedUntil: new Date(NOW.getTime() - 1) }),
      code: await currentCode(),
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("TOTP 未登録では失敗する（未登録で通る抜け道を作らない）", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow({ twoFactorConfirmedAt: null }),
      code: await currentCode(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
  });

  it("無効化済みでは失敗する", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow({ status: "SUSPENDED" }),
      code: await currentCode(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
  });
});

describe("ログインの第 2 要素（verifySecondFactor / 復旧コード）", () => {
  const RECOVERY_PLAIN = "ABCDE-23456";

  beforeEach(async () => {
    listActivePlatformRecoveryCodes.mockResolvedValue([
      { id: "plat_rc_a", codeHash: await sha256HexOfText("OTHER00002") },
      { id: "plat_rc_b", codeHash: await sha256HexOfText(normalizeRecoveryCode(RECOVERY_PLAIN)) },
    ]);
  });

  it("有効な復旧コードで通り、その 1 本を消費し、残数が返る", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow(),
      code: RECOVERY_PLAIN,
      now: NOW,
      ip: "203.0.113.9",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe("RECOVERY");
    expect(result.recoveryRemaining).toBe(1);
    expect(consumePlatformRecoveryCode).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id: "plat_rc_b", operatorId: OPERATOR_ID }),
    );
    expect(auditActions()).toEqual(["platform.2fa.recovery.used", "platform.login"]);
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        action: "platform.2fa.recovery.used",
        detail: { remaining: 1 },
      }),
    );
    // **平文もハッシュ以外の形でも監査に出ない。**
    expect(auditJson()).not.toContain(normalizeRecoveryCode(RECOVERY_PLAIN));
  });

  it("小文字・区切り無しでも通る（正規化）", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow(),
      code: "abcde23456",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("**使用済み（消費に負けた）なら失敗**（1 本 1 回 / 完了条件）", async () => {
    consumePlatformRecoveryCode.mockResolvedValue(false);
    const result = await verifySecondFactor(env, {
      operator: operatorRow(),
      code: RECOVERY_PLAIN,
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(auditActions()).toEqual(["platform.2fa.failed"]);
  });

  it("一致しないコードは失敗として数える", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow(),
      code: "ZZZZZ-ZZZZZ",
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(recordPlatformTwoFactorAttempt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ success: false }),
    );
  });

  it("ロック中は有効な復旧コードでも失敗する", async () => {
    const result = await verifySecondFactor(env, {
      operator: operatorRow({ twoFactorLockedUntil: new Date(NOW.getTime() + 60_000) }),
      code: RECOVERY_PLAIN,
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(consumePlatformRecoveryCode).not.toHaveBeenCalled();
  });
});

describe("復旧コードの再発行（regenerateRecoveryCodes）", () => {
  it("正しい TOTP で新しい 10 本が出て、再発行が監査に残る", async () => {
    const result = await regenerateRecoveryCodes(env, {
      operator: operatorRow(),
      code: await currentCode(),
      now: NOW,
      ip: "203.0.113.9",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(replacePlatformRecoveryCodes).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ operatorId: OPERATOR_ID }),
    );
    expect(auditActions()).toEqual(["platform.2fa.recovery.regenerated"]);
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        action: "platform.2fa.recovery.regenerated",
        detail: { recoveryCodes: RECOVERY_CODE_COUNT },
      }),
    );
    // 平文が監査に出ない。
    const json = auditJson();
    for (const code of result.recoveryCodes) expect(json).not.toContain(code);
  });

  it("コードが違うと再発行されない", async () => {
    const result = await regenerateRecoveryCodes(env, {
      operator: operatorRow(),
      code: "000000",
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(replacePlatformRecoveryCodes).not.toHaveBeenCalled();
  });

  it("ロック中は再発行できない", async () => {
    const result = await regenerateRecoveryCodes(env, {
      operator: operatorRow({ twoFactorLockedUntil: new Date(NOW.getTime() + 60_000) }),
      code: await currentCode(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    expect(replacePlatformRecoveryCodes).not.toHaveBeenCalled();
  });
});
