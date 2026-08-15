/**
 * PMS・スマートロック等の外部連携アダプタ（PK-SPEC-P6 §3 / §4）。
 *
 * **連携先固有の分岐はこのパッケージの中だけ**（§1.1 MUST）。
 * `if (vendor === "xxx")` がここより外に出たら設計ミス。
 *
 * P6-03 の段階で公開しているのは型とインターフェースだけ。実アダプタは
 * P6-06 以降（実接続する PMS が確定してから / §3.2 MUST「想定で作らない」）。
 */

// リトライとサーキットブレーカー（P6-07 / §3.4）。**連携先を知らない。**
export {
  CIRCUIT_OPEN_THRESHOLD,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAYS_MINUTES,
  canRunScheduledSync,
  circuitStateOf,
  retryDelaySeconds,
  shouldOpenCircuit,
  shouldRetry,
  type CircuitState,
} from "./core/circuitBreaker.js";

// 送信 Webhook の配信規則（P6-13 / §6.4）。**受信側の刻みと別の表。**
export {
  OUTBOUND_DISABLE_THRESHOLD,
  OUTBOUND_EVENT_VALUES,
  OUTBOUND_MAX_ATTEMPTS,
  OUTBOUND_RETRY_DELAYS_MINUTES,
  isDeliverySuccess,
  outboundRetryDelaySeconds,
  shouldDisableOutbound,
  subscribesTo,
  type OutboundEvent,
} from "./core/outboundDelivery.js";

// 外部 ID の自動マッピング（P6-05 / §2.3・§7.2）。
export {
  autoMapRooms,
  normalizeRoomKey,
  type AutoMapCandidate,
  type AutoMapInput,
  type AutoMapPair,
  type AutoMapResult,
} from "./core/autoMapping.js";

export {
  OCCUPANCY_CHANNEL_CODE_VALUES,
  SIGNAL_ACTOR_TYPE_VALUES,
  SIGNAL_TYPE_VALUES,
  type Adapter,
  type AdapterConfig,
  type ExternalDevice,
  type ExternalRoom,
  type NormalizedOccupancy,
  type NormalizedSignal,
  type OccupancyAdapter,
  type OccupancyCapabilities,
  type OccupancyChannelCode,
  type SignalActorType,
  type SignalAdapter,
  type SignalType,
  type TestResult,
} from "./core/types.js";
