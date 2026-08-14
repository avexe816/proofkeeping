/**
 * Resend の webhook イベントの読み取り（PK-SPEC-P5 §2.7 / P5-10）。
 *
 * task:  docs/tasks/P5-10.md
 * ルール: .claude/rules/security.md §7
 *
 * ── webhook は組織を知らない ────────────────────────────
 * Resend は「どのテナントの送付か」を知らない。一方こちらは
 * **シャードを引くために `organizationId` が要る**（architecture.md §1）。
 * 全シャード走査は禁止。
 *
 * そこで**送付ログの ID を送信時に持たせている**
 * （`consumers/notification.ts` の `tags` / `headers`）。ID は自己記述
 * （`{orgShortId}__dlv_{ulid}`）なので、返ってくれば
 * `lookupOrganizationId()` で組織を引ける。**新しい表を作らずに済む。**
 *
 * ── タグとヘッダの両方を見る ────────────────────────────
 * Resend の webhook payload がタグとヘッダのどちらを載せるかは
 * イベントの種類で違う。**両方を見て、先に見つかったほうを使う。**
 * どちらも無ければ処理できない（`null` を返して呼び出し側が ack する）。
 * docs/OPEN_QUESTIONS.md #077。
 */

/** 扱うイベント。**開封（`email.opened`）も §2.7 の `openedAt` に対応する。** */
export const RESEND_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.opened",
] as const;

export type ResendEventType = (typeof RESEND_EVENT_TYPES)[number];

/** 送付ログへ写す状態（§2.7）。 */
export type DeliveryStatusFromEvent = "SENT" | "DELIVERED" | "BOUNCED" | "FAILED";

/** 読み取れた 1 件。**組織はここから引く。** */
export interface ParsedDeliveryEvent {
  type: ResendEventType;
  /** `{orgShortId}__dlv_{ulid}`。 */
  deliveryId: string;
  status: DeliveryStatusFromEvent;
  /** 不達の理由。**本文や宛先を入れない**（ログに個人情報を残さない）。 */
  errorMessage: string | null;
}

/**
 * イベント種別 → 送付ログの状態（§2.7）。
 *
 * `email.complained`（迷惑メール報告）は **`BOUNCED` に寄せる。**
 * §2.7 の語彙に苦情の状態が無く、運用上どちらも「これ以上この宛先へ
 * 送ってはいけない」を意味する。
 */
export function statusOfEvent(type: ResendEventType): DeliveryStatusFromEvent | null {
  switch (type) {
    case "email.sent":
      return "SENT";
    case "email.delivered":
      return "DELIVERED";
    case "email.bounced":
    case "email.complained":
      return "BOUNCED";
    // 開封は状態を進めない（`openedAt` だけを立てる）。
    case "email.opened":
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** タグの配列から `pk_delivery_id` を拾う。 */
function deliveryIdFromTags(tags: unknown, tagName: string): string | null {
  if (!Array.isArray(tags)) return null;
  for (const entry of tags) {
    const tag = asRecord(entry);
    if (tag === null) continue;
    if (tag["name"] === tagName && typeof tag["value"] === "string") return tag["value"];
  }
  return null;
}

/** ヘッダの配列またはオブジェクトから拾う（Resend はどちらの形もありうる）。 */
function deliveryIdFromHeaders(headers: unknown, headerName: string): string | null {
  const lowered = headerName.toLowerCase();

  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const header = asRecord(entry);
      if (header === null) continue;
      const name = header["name"];
      if (typeof name === "string" && name.toLowerCase() === lowered) {
        const value = header["value"];
        if (typeof value === "string") return value;
      }
    }
    return null;
  }

  const record = asRecord(headers);
  if (record === null) return null;
  for (const [name, value] of Object.entries(record)) {
    if (name.toLowerCase() === lowered && typeof value === "string") return value;
  }
  return null;
}

/**
 * webhook の本文から 1 件読み取る。**読めなければ `null`。**
 *
 * `null` は「再送しても直らない」を意味する（呼び出し側が ack する）。
 * 知らないイベント種別も `null`（Resend は将来イベントを増やす）。
 */
export function parseDeliveryEvent(
  body: unknown,
  names: { tag: string; header: string },
): ParsedDeliveryEvent | null {
  const envelope = asRecord(body);
  if (envelope === null) return null;

  const type = envelope["type"];
  if (typeof type !== "string") return null;
  if (!(RESEND_EVENT_TYPES as readonly string[]).includes(type)) return null;
  const eventType = type as ResendEventType;

  const data = asRecord(envelope["data"]);
  if (data === null) return null;

  const deliveryId =
    deliveryIdFromTags(data["tags"], names.tag) ??
    deliveryIdFromHeaders(data["headers"], names.header);
  if (deliveryId === null) return null;

  const status = statusOfEvent(eventType);

  return {
    type: eventType,
    deliveryId,
    status: status ?? "SENT",
    // **理由だけ。宛先も本文も入れない。**
    errorMessage: eventType === "email.bounced" || eventType === "email.complained"
      ? reasonOf(data)
      : null,
  };
}

/** 不達の理由を短く取り出す。**無ければイベント名そのもの。** */
function reasonOf(data: Record<string, unknown>): string {
  const bounce = asRecord(data["bounce"]);
  const type = bounce?.["type"];
  const subType = bounce?.["subType"];
  const parts = [typeof type === "string" ? type : null, typeof subType === "string" ? subType : null]
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? "BOUNCED" : parts.join("/");
}
