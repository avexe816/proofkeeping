/**
 * Resend（Svix）の webhook 署名検証（PK-SPEC-P5 §2.7 / P5-10）。
 *
 * task:  docs/tasks/P5-10.md
 * ルール: .claude/rules/security.md §7
 *
 * ── security.md §7 が要求するもの ───────────────────────
 *   - **HMAC-SHA256 署名を必須検証。失敗は 401。**
 *   - タイムスタンプが 5 分以上ずれていたら拒否（リプレイ対策）。
 *
 * ── Svix の形 ───────────────────────────────────────────
 * Resend は Svix を使う。3 つのヘッダが来る。
 * ```
 * svix-id         メッセージ ID
 * svix-timestamp  秒（UNIX 時刻）
 * svix-signature  "v1,<base64>" を空白区切りで複数
 * ```
 * 署名の対象は `${svix-id}.${svix-timestamp}.${body}`。鍵は
 * `whsec_` を除いた部分を base64 デコードしたバイト列。
 *
 * ── 純粋に近い形にしてある ──────────────────────────────
 * `Date.now()` を呼ばない。**「いま」は引数**（テストから固定できる）。
 * WebCrypto だけに依存する。
 */

/** 許容するタイムスタンプのずれ（秒）。security.md §7 の「5 分」。 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** 検証の結果。**失敗の理由を呼び出し側へ返さない**（401 を一律にする）。 */
export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: "MISSING_HEADERS" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" | "NO_SECRET" };

export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/** ヘッダを 3 つ取り出す。**大文字小文字を問わない。** */
export function readWebhookHeaders(request: Request): WebhookHeaders {
  return {
    id: request.headers.get("svix-id") ?? undefined,
    timestamp: request.headers.get("svix-timestamp") ?? undefined,
    signature: request.headers.get("svix-signature") ?? undefined,
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 2 つの文字列を**長さに依らない時間**で比べる。
 *
 * 署名の比較を `===` で書くと、先頭から何文字一致したかが実行時間に
 * 出る。総当たりの足がかりになるので使わない。
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
 * 署名を検証する（security.md §7）。
 *
 * @param secret `whsec_` 付きの鍵。**空なら検証を素通りさせず `NO_SECRET`。**
 * @param now 受信時刻。**この関数の中で `Date.now()` を呼ばない。**
 */
export async function verifyWebhookSignature(input: {
  secret: string;
  headers: WebhookHeaders;
  body: string;
  now: Date;
}): Promise<WebhookVerification> {
  // **鍵が無いときに「検証成功」にしない。** 設定漏れが、誰でも
  // webhook を叩ける状態として現れないようにする。
  if (input.secret === "") return { ok: false, reason: "NO_SECRET" };

  const { id, timestamp, signature } = input.headers;
  if (id === undefined || timestamp === undefined || signature === undefined) {
    return { ok: false, reason: "MISSING_HEADERS" };
  }

  const sentAtSeconds = Number(timestamp);
  if (!Number.isFinite(sentAtSeconds)) return { ok: false, reason: "STALE_TIMESTAMP" };
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - sentAtSeconds);
  // **未来方向のずれも拒否する。** 時計を進めた署名を貯めておく
  // 攻撃を許さない。
  if (skew > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "STALE_TIMESTAMP" };

  const rawSecret = input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret;
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(rawSecret).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${input.body}`),
  );
  const expected = bytesToBase64(new Uint8Array(signed));

  // `svix-signature` は "v1,<base64> v1,<base64>" の形（鍵の交代期に複数）。
  const candidates = signature
    .split(" ")
    .map((part) => part.split(",")[1] ?? "")
    .filter((part) => part !== "");

  const matched = candidates.some((candidate) => timingSafeEqual(candidate, expected));
  return matched ? { ok: true } : { ok: false, reason: "BAD_SIGNATURE" };
}
