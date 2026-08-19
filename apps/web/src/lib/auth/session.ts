/**
 * セッションの発行・読み出し・破棄。実体は Workers KV（`SESSION`）。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #020
 *
 * ── セッションに認可情報を持たせない ────────────────────
 * 保存するのは識別情報だけ（`userId` / `organizationId` / `orgShortId` /
 * `membershipId` / `authMethod` / 期限）。**`role` と `allowedPropertyIds` を
 * 焼き込まない。** 焼き込むとロール降格・施設割当の解除が最長 12 時間反映されず、
 * その間ずっと権限が広い側に残る。`TenantContext` の組み立ては毎リクエスト
 * `findMembershipByUserId()` + `listAssignedPropertyIds()` で行う（P0-10 の責務）。
 *
 * ── 期限を二重に効かせる ────────────────────────────────
 *   1. KV の `expirationTtl` — 実体の掃除
 *   2. レコード内の `expiresAt` — 読み出し時の判定
 * KV の失効は結果整合で遅れうるため、1 だけに頼らない。
 * **延長しない（絶対期限）。** 12 時間 / 16 時間（1 勤務）は固定値で、
 * スライディング更新にすると「1 勤務」の意味が失われる。
 */

import type { Env, RandomBytes } from "@pk/db";

import { signSessionId, verifySignedSessionId } from "./cookie.js";

/**
 * 認証方式ごとのセッション有効期限（security.md §2）。
 *
 * **設定項目にしない**（docs/PK-IMPL-CONTRACT.md §11.4）。
 * `PIN` は P0-09 が使う。値をここに置いておくのは、有効期限の一覧性を
 * 1 か所に保つため。
 */
export const SESSION_TTL_SECONDS = {
  /** 管理系 12 時間。 */
  PASSWORD: 12 * 60 * 60,
  /** 現場系 16 時間（1 勤務）。 */
  PIN: 16 * 60 * 60,
} as const;

export type AuthMethod = keyof typeof SESSION_TTL_SECONDS;

/** KV のキー接頭辞。`SESSION` namespace には認証セッション以外を置かない。 */
const KEY_PREFIX = "sess:";

/** セッション ID の長さ（バイト）。base64url で 43 文字になる。 */
const SESSION_ID_BYTES = 32;

/** KV に置くレコード。**ここに認可情報を足さないこと**（DECISIONS #020）。 */
export interface SessionRecord {
  /** 形式の版。読み出し時に照合し、違えば無効として扱う。 */
  v: 1;
  userId: string;
  organizationId: string;
  orgShortId: string;
  membershipId: string;
  authMethod: AuthMethod;
  /** epoch ミリ秒。 */
  issuedAt: number;
  /** epoch ミリ秒。絶対期限。 */
  expiresAt: number;
  /**
   * 表示中の施設（PK-SPEC-P0 §23.4 / P0-14）。**認可情報ではない。**
   *
   * 「どの施設を見ているか」であって「どの施設を見てよいか」ではない。
   * 後者は `allowedPropertyIds` で、こちらは焼き込まない（DECISIONS #020）。
   * **この値は毎リクエスト `allowedPropertyIds` と突き合わせて検証する**
   * （`lib/property/selection.ts`）。権限から外れていれば既定施設へ落とす。
   *
   * 省略可能なまま `v` を上げていないのは、フィールドを持たない既存レコードが
   * 「未選択」として正しく読めるため（後方互換 / architecture.md §6）。
   * **`"ALL"`（全社サマリー）は P0-21 が足す。** ここでは施設 ID のみ。
   */
  selectedPropertyId?: string;
  /**
   * サイドバーをレール（56px）に畳んでいるか（PK-SPEC-UI-A01 §4.4 / P7-21）。
   * **認可情報ではない。** 表示の好みだけを持つ。
   *
   * `localStorage` ではなくここに置くのは、SSR の初回描画から確定した幅で
   * 描くため（A01 §4.4「ちらつき禁止」）。畳んでいるときだけ `true` を
   * 保存し、展開はフィールドごと消す（既存レコードとの後方互換）。
   */
  sidebarCollapsed?: boolean;
  /**
   * 現場画面で選んだ施設（PK-SPEC-P1 §19.4 / P1-22）。**認可情報ではない。**
   *
   * `selectedPropertyId`（管理画面の表示スコープ）と分けてある。両者は
   * 消える条件が違う — こちらは**業務日が変われば無効**（§19.4 の
   * 「当日中は再表示しない」）で、あちらは日付を持たない。同じ欄に
   * 入れると、PC で施設を切り替えた結果が現場の一覧を絞り込む。
   *
   * `propertyId` は `ALL_MOBILE_PROPERTIES` を取りうる（「すべての施設を
   * まとめて表示」）。**この値も毎リクエスト一覧と突き合わせる**
   * （`lib/mobile/pick.ts`）。一覧に無ければ絞り込みを掛けない。
   */
  mobilePick?: MobilePick;
}

/** 現場画面の施設選択（§19.4）。 */
export interface MobilePick {
  /** 選んだ施設。`"ALL"` は絞り込まない（プロトタイプ 03 Q2 の逃げ道）。 */
  propertyId: string;
  /** その施設のタスクを見る業務日。翌日を選ぶと未来日になる。 */
  businessDate: string;
  /** **選んだ日の業務日。** これが当日でなければ選択画面を出し直す。 */
  pickedOn: string;
}

/** `createSession()` の入力。 */
export interface CreateSessionInput {
  userId: string;
  organizationId: string;
  orgShortId: string;
  membershipId: string;
  authMethod: AuthMethod;
  now: Date;
}

/** 発行結果。`cookieValue` をそのまま `Set-Cookie` に載せる。 */
export interface CreatedSession {
  record: SessionRecord;
  /** 署名付きの Cookie 値。**生の `sessionId` を外へ出さない。** */
  cookieValue: string;
  /** Cookie の `Max-Age`。 */
  maxAgeSeconds: number;
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * セッションを発行する。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function createSession(
  env: Env,
  input: CreateSessionInput,
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<CreatedSession> {
  const ttlSeconds = SESSION_TTL_SECONDS[input.authMethod];
  const issuedAt = input.now.getTime();
  const record: SessionRecord = {
    v: 1,
    userId: input.userId,
    organizationId: input.organizationId,
    orgShortId: input.orgShortId,
    membershipId: input.membershipId,
    authMethod: input.authMethod,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds * 1000,
  };

  const sessionId = toBase64Url(randomBytes(SESSION_ID_BYTES));
  await env.SESSION.put(KEY_PREFIX + sessionId, JSON.stringify(record), {
    expirationTtl: ttlSeconds,
  });

  return {
    record,
    cookieValue: await signSessionId(sessionId, env.SESSION_SECRET),
    maxAgeSeconds: ttlSeconds,
  };
}

/**
 * KV から読んだ値を検証する。**KV の中身を無検査で信用しない。**
 *
 * 形式の版が上がった後の古いレコード、手で書き換えられた値、
 * 別 namespace から紛れ込んだ値をここで落とす。
 */
function parseSessionRecord(raw: string): SessionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate["v"] !== 1) return null;
  const authMethod = candidate["authMethod"];
  if (authMethod !== "PASSWORD" && authMethod !== "PIN") return null;
  for (const key of ["userId", "organizationId", "orgShortId", "membershipId"]) {
    if (typeof candidate[key] !== "string" || candidate[key] === "") return null;
  }
  for (const key of ["issuedAt", "expiresAt"]) {
    if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key])) return null;
  }
  // 省略可能。**空文字は未選択として捨てる**（`""` が施設 ID として
  // 一致することは無いが、判定を後段に持ち越さない）。
  const selected = candidate["selectedPropertyId"];
  const selectedPropertyId = typeof selected === "string" && selected !== "" ? selected : undefined;
  const mobilePick = parseMobilePick(candidate["mobilePick"]);
  // `true` 以外（壊れた値・`false`）は「展開」として捨てる。
  const sidebarCollapsed = candidate["sidebarCollapsed"] === true ? true : undefined;

  return {
    v: 1,
    userId: candidate["userId"] as string,
    organizationId: candidate["organizationId"] as string,
    orgShortId: candidate["orgShortId"] as string,
    membershipId: candidate["membershipId"] as string,
    authMethod,
    issuedAt: candidate["issuedAt"] as number,
    expiresAt: candidate["expiresAt"] as number,
    ...(selectedPropertyId === undefined ? {} : { selectedPropertyId }),
    ...(mobilePick === undefined ? {} : { mobilePick }),
    ...(sidebarCollapsed === undefined ? {} : { sidebarCollapsed }),
  };
}

/** 業務日の形（`YYYY-MM-DD`）。**壊れた値を後段へ持ち越さない。** */
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 現場の施設選択を読む。**1 項目でも欠けていれば「未選択」。** */
function parseMobilePick(value: unknown): MobilePick | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const propertyId = candidate["propertyId"];
  const businessDate = candidate["businessDate"];
  const pickedOn = candidate["pickedOn"];
  if (typeof propertyId !== "string" || propertyId === "") return undefined;
  if (typeof businessDate !== "string" || !BUSINESS_DATE.test(businessDate)) return undefined;
  if (typeof pickedOn !== "string" || !BUSINESS_DATE.test(pickedOn)) return undefined;
  return { propertyId, businessDate, pickedOn };
}

/**
 * Cookie の値からセッションを引く。
 *
 * 署名不正・KV に無い・形式が違う・期限切れは**すべて `null`。**
 * 呼び出し側は理由を応答に出さないこと（security.md §2）。
 *
 * 期限切れのレコードを見つけたら KV から消す。`expirationTtl` の失効は
 * 結果整合で遅れうるので、読み出し側でも掃除する。
 */
export async function readSession(
  env: Env,
  cookieValue: string,
  now: Date,
): Promise<SessionRecord | null> {
  const sessionId = await verifySignedSessionId(cookieValue, env.SESSION_SECRET);
  if (sessionId === null) return null;

  const key = KEY_PREFIX + sessionId;
  const raw = await env.SESSION.get(key);
  if (raw === null) return null;

  const record = parseSessionRecord(raw);
  if (record === null) {
    await env.SESSION.delete(key);
    return null;
  }
  if (record.expiresAt <= now.getTime()) {
    await env.SESSION.delete(key);
    return null;
  }
  return record;
}

/**
 * 表示中の施設を記録する（PK-SPEC-P0 §23.4 / P0-14）。
 *
 * **期限を延長しない。** 残り時間を `expiresAt - now` から計算して
 * そのまま `expirationTtl` にする。ここで `SESSION_TTL_SECONDS` を使い直すと
 * 施設を切り替えるたびにセッションが延び、「12 時間 / 1 勤務」の絶対期限が
 * 崩れる（DECISIONS #020）。
 *
 * **無効なセッションには書かない。** `readSession()` が `null` を返す
 * （署名不正・期限切れ・破棄済み）ときに put すると、破棄したはずの
 * セッションが復活する。
 *
 * 施設の切替は監査ログに残さない（§23.4 — 頻度が高くノイズになる）。
 * ただし `"ALL"` への切替は記録する。**`"ALL"` の実装は P0-21。**
 *
 * @param propertyId `null` を渡すと選択を消す（既定施設に戻る）。
 *   **担当施設かどうかはここでは見ない。** 呼ぶ側が資源から解決してから渡す
 *   （`lib/property/selection.ts` の `switchProperty()`）。
 * @returns 書き込めたら更新後のレコード。セッションが無効なら `null`。
 */
export async function setSelectedPropertyId(
  env: Env,
  cookieValue: string,
  propertyId: string | null,
  now: Date,
): Promise<SessionRecord | null> {
  const sessionId = await verifySignedSessionId(cookieValue, env.SESSION_SECRET);
  if (sessionId === null) return null;

  const current = await readSession(env, cookieValue, now);
  if (current === null) return null;

  const updated: SessionRecord = { ...current };
  if (propertyId === null) delete updated.selectedPropertyId;
  else updated.selectedPropertyId = propertyId;

  await putSession(env, sessionId, updated, now);
  return updated;
}

/**
 * 現場画面で選んだ施設を記録する（PK-SPEC-P1 §19.4 / P1-22）。
 *
 * **`setSelectedPropertyId()` と同じ制約に従う。** 期限を延長しない。
 * 無効なセッションには書かない。理由はそちらの注記を参照。
 *
 * **担当施設かどうかはここでは見ない。** 呼ぶ側が当日の一覧から解決してから
 * 渡す（`lib/mobile/pick.ts`）。選択は絞り込みであって認可ではないので、
 * 一覧に無い値が残っていても効かないだけで済む。
 *
 * @param pick `null` を渡すと選択を消す（次の起動で選択画面が出る）。
 */
export async function setMobilePick(
  env: Env,
  cookieValue: string,
  pick: MobilePick | null,
  now: Date,
): Promise<SessionRecord | null> {
  const sessionId = await verifySignedSessionId(cookieValue, env.SESSION_SECRET);
  if (sessionId === null) return null;

  const current = await readSession(env, cookieValue, now);
  if (current === null) return null;

  const updated: SessionRecord = { ...current };
  if (pick === null) delete updated.mobilePick;
  else updated.mobilePick = pick;

  await putSession(env, sessionId, updated, now);
  return updated;
}

/**
 * サイドバーの折りたたみを記録する（PK-SPEC-UI-A01 §4.4 / P7-21）。
 *
 * **`setSelectedPropertyId()` と同じ制約に従う。** 期限を延長しない。
 * 無効なセッションには書かない。理由はそちらの注記を参照。
 *
 * @param collapsed `false` はフィールドごと消す（既定 = 展開）。
 */
export async function setSidebarCollapsed(
  env: Env,
  cookieValue: string,
  collapsed: boolean,
  now: Date,
): Promise<SessionRecord | null> {
  const sessionId = await verifySignedSessionId(cookieValue, env.SESSION_SECRET);
  if (sessionId === null) return null;

  const current = await readSession(env, cookieValue, now);
  if (current === null) return null;

  const updated: SessionRecord = { ...current };
  if (collapsed) updated.sidebarCollapsed = true;
  else delete updated.sidebarCollapsed;

  await putSession(env, sessionId, updated, now);
  return updated;
}

/**
 * 更新後のレコードを書き戻す。**期限を延ばさない。**
 *
 * 残り時間を `expiresAt - now` から計算してそのまま `expirationTtl` にする。
 * ここで `SESSION_TTL_SECONDS` を使い直すと、施設を選ぶたびにセッションが
 * 延び、「12 時間 / 1 勤務」の絶対期限が崩れる（DECISIONS #020）。
 *
 * KV の `expirationTtl` は 60 秒が下限。残りがそれを下回る場合だけ
 * 実体の掃除が最大 1 分遅れるが、`expiresAt` による読み出し時の判定
 * （二重の期限のうち 2 つ目）が先に効くので、使えるセッションは増えない。
 */
async function putSession(
  env: Env,
  sessionId: string,
  record: SessionRecord,
  now: Date,
): Promise<void> {
  const remainingMs = record.expiresAt - now.getTime();
  const ttlSeconds = Math.max(60, Math.ceil(remainingMs / 1000));
  await env.SESSION.put(KEY_PREFIX + sessionId, JSON.stringify(record), {
    expirationTtl: ttlSeconds,
  });
}

/** セッションを破棄する。署名が合わない値では何もしない。 */
export async function deleteSession(env: Env, cookieValue: string): Promise<void> {
  const sessionId = await verifySignedSessionId(cookieValue, env.SESSION_SECRET);
  if (sessionId === null) return;
  await env.SESSION.delete(KEY_PREFIX + sessionId);
}
