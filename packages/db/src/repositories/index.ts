/**
 * リポジトリ層の入口。
 *
 * task: docs/tasks/P0-07.md
 *
 * **DB へのアクセスはすべてここを通す。** API ハンドラから
 * `getTenantDb()` を呼んで直に `select()` しないこと（PK-SPEC-P0 §19.4 第1層）。
 *
 * `test-support/` はテスト専用のため公開しない。
 */

export {
  ALWAYS_FALSE,
  ALWAYS_TRUE,
  NO_PROPERTY_SCOPE,
  isOrgWideRole,
  scopeToProperties,
  withOrganizationScope,
  withTenantScope,
  type PropertyScope,
  type TenantScopedTable,
} from "./base.js";

export { findOrganization, findTaxProfile } from "./organization.js";

export {
  createProperty,
  findPropertyByCode,
  findPropertyById,
  listProperties,
  type CreatePropertyInput,
  type PropertyFilter,
} from "./property.js";

export { findRoomById, listRooms, type RoomFilter } from "./room.js";

export {
  findMembershipByUserId,
  findUserById,
  listAssignedPropertyIds,
  listUsers,
  type UserFilter,
} from "./user.js";
