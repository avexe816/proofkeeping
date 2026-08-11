/**
 * テナントスコープのスキーマ。`getTenantDb()` に渡す唯一の集合。
 *
 * task: docs/tasks/P0-06.md
 *
 * **全局テーブル（`global.ts`）とメタテーブル（`meta.ts`）をここへ含めない。**
 * ここに載せた表は `getTenantDb()` 経由で引けるようになる。テナント文脈で
 * 全局テーブルを引けてしまうと、テナント横断のクエリ（architecture.md §3 で禁止）が
 * 型の上で自然に書けてしまう。それぞれ `getGlobalDb()` / ランナー専用の経路から使う。
 */

export {
  DOCUMENT_TYPES,
  TAX_ROUNDING_MODES,
  documentSequence,
  organization,
  organizationTaxProfile,
} from "./organization.js";

export { ROLES, membership, propertyAssignment, user, type Role } from "./user.js";

export {
  ROOM_SOURCE_TYPES,
  building,
  floor,
  property,
  room,
  roomType,
} from "./property.js";

export {
  BILLING_CYCLES,
  ENTITLEMENT_SOURCES,
  MODULE_CODES,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUSES,
  moduleEntitlement,
  subscription,
  type ModuleCode,
} from "./billing.js";

export { auditLog } from "./audit.js";
