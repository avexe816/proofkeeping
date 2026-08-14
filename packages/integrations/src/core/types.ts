/**
 * 連携アダプタの共通インターフェース（PK-SPEC-P6 §3.1 / §4.1 / P6-03）。
 *
 * task: docs/tasks/P6-03.md
 * 仕様: docs/PK-SPEC-P6.md §1.1（アダプタ層で吸収する）
 *
 * ── この層が存在する理由 ────────────────────────────────
 * §1.1 MUST: **連携先固有の分岐をアダプタ層の外に書かない。**
 * `if (vendor === "xxx")` がここより外に出たら設計ミス。エンジンと
 * アプリケーションは連携先を一切知らず、`NormalizedOccupancy` /
 * `NormalizedSignal` だけを見る。
 *
 * ── 「わからない」を潰さない ────────────────────────────
 * 正規化型の任意項目（`actorType` / `guestCount` の内訳など）は
 * **取得できなければ省く。** 0 や推測値で埋めない（§4.3 MUST）。
 * 埋めた瞬間、照合は「情報が無い」と「情報があって 0」を区別できなくなる。
 * `capabilities` はアダプタが何を返せるかの宣言で、呼び出し側は
 * これを見て「取れないもの」を要求しない。
 *
 * ── ここに秘密を持たない ────────────────────────────────
 * `AdapterConfig.credentials` は**呼び出し側が KV から復号して渡す**
 * （`apps/web/src/lib/integration/credentials.ts` / security.md §7）。
 * アダプタは受け取って使うだけで、保存も記録もしない。
 * 例外・ログに資格情報を載せないこと。
 *
 * ── 時刻の型 ────────────────────────────────────────────
 * 正規化型の時刻は **ISO 8601 文字列**（仕様 §3.1 / §4.1 のまま）。
 * DB の `timestamp_ms` へ直す責務は取込側にある。外部システムの応答は
 * オフセット付きで来ることが多く、ここで数値に潰すと施設のタイムゾーンを
 * 決めるための情報が失われる（architecture.md §7 の業務日計算に効く）。
 */

/**
 * 物理シグナルの種類。
 *
 * **`packages/db` の `SIGNAL_TYPES` の写し。** 依存の辺を
 * integrations → db に張らないために値を写している。
 * 片側だけ増えたら `packages/db/src/schema/vocabulary.spec.ts` が落ちる
 * （`packages/engine` / `packages/billing` と同じ扱い）。
 */
export const SIGNAL_TYPE_VALUES = [
  "DOOR_UNLOCK",
  "DOOR_OPEN",
  "KEY_ISSUE",
  "POWER_ON",
  "WIFI_JOIN",
  "SELF_CHECKIN",
  "SAFE_USE",
  "MINIBAR_SENSOR",
] as const;

export type SignalType = (typeof SIGNAL_TYPE_VALUES)[number];

/**
 * シグナルを発生させた鍵の種別。同じく `packages/db` の写し。
 *
 * **多くのロックは「誰が開けたか」を返さない**（§4.3）。返さない機種では
 * `UNKNOWN` にする。省略と `UNKNOWN` を区別しないこと（どちらも「不明」）。
 */
export const SIGNAL_ACTOR_TYPE_VALUES = [
  "GUEST_KEY",
  "STAFF_KEY",
  "MASTER_KEY",
  "MOBILE_KEY",
  "UNKNOWN",
] as const;

export type SignalActorType = (typeof SIGNAL_ACTOR_TYPE_VALUES)[number];

/** 販売経路。同じく `packages/db` の写し。 */
export const OCCUPANCY_CHANNEL_CODE_VALUES = ["OTA", "DIRECT", "WALK_IN"] as const;

export type OccupancyChannelCode = (typeof OCCUPANCY_CHANNEL_CODE_VALUES)[number];

// ────────────────────────────────────────────────────────────
// 接続設定
// ────────────────────────────────────────────────────────────

/**
 * アダプタに渡す接続設定。
 *
 * `settings` は `integration.config` の中身（URL・タイムアウト・機種名）。
 * `credentials` は KV から復号した資格情報。**この 2 つを混ぜない。**
 * 混ぜると `config` に秘密が紛れ込む経路ができ、D1 に平文が載る。
 */
export interface AdapterConfig {
  /** `integration.id`。ログと `syncLog` の紐付けに使う。 */
  integrationId: string;
  /** `integration.config`。**秘密を入れない。** */
  settings: Readonly<Record<string, unknown>>;
  /** KV から復号した資格情報。**保存・記録しない。** */
  credentials: Readonly<Record<string, string>>;
  /** 施設単位の連携なら施設 ID。組織全体なら `null`。 */
  propertyId: string | null;
}

/**
 * 接続テストの結果。
 *
 * **例外を投げるのではなく結果として返す。** 接続失敗は
 * 「その日の稼働記録が未取得」という状態であって、システムの異常ではない
 * （§1.2）。`message` は管理画面に出るので、資格情報を含めないこと。
 */
export type TestResult =
  | { ok: true; message?: string }
  | { ok: false; code: string; message: string };

/** アダプタが何を返せるか（§3.1）。 */
export interface OccupancyCapabilities {
  pull: boolean;
  push: boolean;
  /** 遡って取得できる日数。0 なら当日ぶんのみ。 */
  historicalDays: number;
  providesGuestCount: boolean;
  providesCheckInTime: boolean;
  providesStayover: boolean;
}

/** 外部システム側の客室（マッピング画面 W-23 が並べる）。 */
export interface ExternalRoom {
  externalId: string;
  label: string;
  roomTypeLabel?: string;
}

/** 外部システム側の機器（ロック等）。 */
export interface ExternalDevice {
  externalId: string;
  label: string;
  /** その機器が出せるシグナル。宣言できない機種では省く。 */
  signalTypes?: SignalType[];
}

// ────────────────────────────────────────────────────────────
// 正規化型
// ────────────────────────────────────────────────────────────

/**
 * 正規化された稼働記録（§3.1）。
 *
 * **宿泊者の氏名・連絡先・住所・パスポート・カードの欄が 1 つも無い**
 * （security.md §3 / PK-SPEC-P4 §2.1 MUST）。照合に要るのは人数と
 * 予約参照番号だけ。アダプタが外部から受け取っても、この型に載せる場所が
 * 無いので先へ進めない。**欄を足さないこと。**
 *
 * `raw` は取込元の生データ。`syncLog.rawSample` に載せるときは
 * **マスクしてから**入れる（security.md §3。保持 7 日）。
 */
export interface NormalizedOccupancy {
  externalRoomId: string;
  /** `YYYY-MM-DD`（architecture.md §7 の業務日）。 */
  businessDate: string;
  isOccupied: boolean;
  guestCount: number;
  adultCount?: number;
  childCount?: number;
  /** 予約番号のみ。**予約者名を入れない。** */
  reservationRef?: string;
  channelCode?: OccupancyChannelCode;
  /** ISO 8601。 */
  checkInAt?: string;
  /** ISO 8601。 */
  checkOutAt?: string;
  isStayover?: boolean;
  nightIndex?: number;
  nightsTotal?: number;
  isHouseUse?: boolean;
  isComplimentary?: boolean;
  raw: unknown;
}

/**
 * 正規化された物理シグナル（§4.1）。
 *
 * `actorType` を省いてよい。**推測で埋めない**（§4.3 MUST）。省いた場合の
 * 扱い（R002 / R013 の confidence を 25 下げる）は照合側の責務。
 *
 * `actorRef` は鍵・カードの識別子。**個人名を入れない**（security.md §3）。
 */
export interface NormalizedSignal {
  externalDeviceId: string;
  signalType: SignalType;
  /** ISO 8601。 */
  occurredAt: string;
  actorType?: SignalActorType;
  /** 鍵・端末の識別子。**個人名を入れない。** */
  actorRef?: string;
  raw: unknown;
}

// ────────────────────────────────────────────────────────────
// インターフェース
// ────────────────────────────────────────────────────────────

/** 稼働記録（A 系統）を取る連携（§3.1）。 */
export interface OccupancyAdapter {
  readonly vendorCode: string;
  readonly capabilities: Readonly<OccupancyCapabilities>;

  testConnection(config: AdapterConfig): Promise<TestResult>;
  listRooms(config: AdapterConfig): Promise<ExternalRoom[]>;
  fetchOccupancy(
    config: AdapterConfig,
    params: { businessDate: string },
  ): Promise<NormalizedOccupancy[]>;
  /** PUSH 型のみ。**署名検証は `verifySignature` の責務**（ここではしない）。 */
  parseWebhook?(body: unknown, headers: Headers): Promise<NormalizedOccupancy[]>;
}

/** 物理信号（C 系統）を取る連携（§4.1）。 */
export interface SignalAdapter {
  readonly vendorCode: string;
  readonly signalTypes: readonly SignalType[];

  testConnection(config: AdapterConfig): Promise<TestResult>;
  listDevices(config: AdapterConfig): Promise<ExternalDevice[]>;
  fetchEvents?(
    config: AdapterConfig,
    params: { from: string; to: string },
  ): Promise<NormalizedSignal[]>;
  parseWebhook?(body: unknown, headers: Headers): Promise<NormalizedSignal[]>;
  /**
   * 機種固有の署名方式を持つときだけ実装する。
   *
   * **未実装は「検証不要」ではない。** 汎用受信口（§4.2）が
   * `X-PK-Signature` の HMAC-SHA256 を必ず検証する。ここは
   * それを機種固有の方式へ差し替えるための口。
   */
  verifySignature?(body: string, headers: Headers, secret: string): boolean;
}

/** どちらのアダプタか。**登録簿の分岐はここまで。** */
export type Adapter = OccupancyAdapter | SignalAdapter;
