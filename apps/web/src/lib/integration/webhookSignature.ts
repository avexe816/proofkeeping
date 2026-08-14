/**
 * 汎用 Webhook 受信口の署名検証（PK-SPEC-P6 §4.2 / P6-04）。
 *
 * task:  docs/tasks/P6-04.md
 * ルール: .claude/rules/security.md §7
 *
 * ── Resend（Svix）の検証と別に置く理由 ──────────────────
 * `lib/billing/webhookSignature.ts` は Svix の形（3 ヘッダ・`v1,<base64>` の
 * 並び）に合わせてある。こちらは**仕様 §4.2 が定めた自前の形**で、
 * 顧客が自分で実装して送ってくる。両者を 1 つの関数に寄せると、
 * どちらかの形が変わったときにもう一方が黙って壊れる。
 *
 * ── 形（§4.2）────────────────────────────────────────────
 * ```
 * X-PK-Signature: sha256=<hex>
 * X-PK-Timestamp: 1757462400        // 秒
 * ```
 * 署名の対象は `${timestamp}.${body}`。鍵は KV に暗号化して置いた
 * 共有秘密の生文字列（`lib/integration/credentials.ts`）。
 *
 * **16 進で受ける。** 顧客が自前で実装する口なので、`hexdigest` が
 * そのまま使える形にしておく。base64 のパディング差で落ちる事故が減る。
 *
 * ── 純粋に近い形にしてある ──────────────────────────────
 * `Date.now()` を呼ばない。**「いま」は引数**（テストから固定できる）。
 * WebCrypto だけに依存する。
 */

/** 許容するタイムスタンプのずれ（秒）。security.md §7 / §4.2 MUST の「5 分」。 */
export const PK_WEBHOOK_TOLERANCE_SECONDS = 300;

/** 署名ヘッダの名前。**大文字小文字を問わず読む。** */
export const PK_SIGNATURE_HEADER = "x-pk-signature";

/** タイムスタンプヘッダの名前。 */
export const PK_TIMESTAMP_HEADER = "x-pk-timestamp";

/** 検証の結果。**失敗の理由を応答に出さない**（401 を一律にする）。 */
export type PkWebhookVerification =
  | { ok: true }
  | { ok: false; reason: "MISSING_HEADERS" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" | "NO_SECRET" };

export interface PkWebhookHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
}

/** ヘッダを 2 つ取り出す。 */
export function readPkWebhookHeaders(request: Request): PkWebhookHeaders {
  return {
    signature: request.headers.get(PK_SIGNATURE_HEADER) ?? undefined,
    timestamp: request.headers.get(PK_TIMESTAMP_HEADER) ?? undefined,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * 2 つの文字列を**長さに依らない時間**で比べる。
 *
 * 署名の比較を `===` で書くと、先頭から何文字一致したかが実行時間に出る。
 * 総当たりの足がかりになるので使わない。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * 署名を検証する（§4.2 MUST）。
 *
 * @param secret 共有秘密。**空なら検証を素通りさせず `NO_SECRET`。**
 *   未設定の連携に誰でも投げられる状態を作らない。
 * @param now 受信時刻。**この関数の中で `Date.now()` を呼ばない。**
 */
export async function verifyPkWebhookSignature(input: {
  secret: string;
  headers: PkWebhookHeaders;
  body: string;
  now: Date;
}): Promise<PkWebhookVerification> {
  if (input.secret === "") return { ok: false, reason: "NO_SECRET" };

  const { signature, timestamp } = input.headers;
  if (signature === undefined || timestamp === undefined) {
    return { ok: false, reason: "MISSING_HEADERS" };
  }

  // `1757462400` の形だけを受ける。**空白や符号を許さない**
  // （`Number(" 1 ")` が通ってしまう）。
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: "STALE_TIMESTAMP" };
  const sentAtSeconds = Number(timestamp);
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - sentAtSeconds);
  // **未来方向のずれも拒否する。** 時計を進めた署名を貯めておく攻撃を許さない。
  if (skew > PK_WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "STALE_TIMESTAMP" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${input.body}`),
  );
  const expected = bytesToHex(new Uint8Array(signed));

  // `sha256=` は必須。**素の 16 進を通さない**（方式を書かせることで、
  // 将来 sha512 を足したときに古い実装が黙って通り続けない）。
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return { ok: false, reason: "BAD_SIGNATURE" };
  const candidate = signature.slice(prefix.length).toLowerCase();

  return timingSafeEqual(candidate, expected)
    ? { ok: true }
    : { ok: false, reason: "BAD_SIGNATURE" };
}
