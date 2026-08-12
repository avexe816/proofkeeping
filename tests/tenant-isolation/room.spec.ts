/**
 * tenant isolation: room
 *
 * task: docs/tasks/P0-13.md
 */

import { findRoomById, listRooms } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "room",
  list: (env, ctx) => listRooms(env, ctx, {}),
  findById: (env, ctx, id) => findRoomById(env, ctx, id),
  entityPrefix: "room",
  propertyColumn: "property_id",
});
