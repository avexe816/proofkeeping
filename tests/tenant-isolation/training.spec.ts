/**
 * tenant isolation: training_program / training_record / certification_record
 *
 * task:  docs/tasks/P8-10.md
 * ルール: .claude/rules/testing.md §2 / .claude/rules/security.md §5
 *
 * 研修の修了・資格の期限は雇用管理の個人情報。1 行でも混ざれば、
 * 他社スタッフの研修状況が自社の画面に載る。
 *
 * 3 表とも施設の次元を持たない（`propertyColumn: null`）。
 */

import { listCertifications, listTrainingPrograms, listTrainingRecords } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "training_program",
  list: (env, ctx) => listTrainingPrograms(env, ctx),
  entityPrefix: "trpg",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "training_record",
  list: (env, ctx) => listTrainingRecords(env, ctx),
  entityPrefix: "trrc",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "certification_record",
  list: (env, ctx) => listCertifications(env, ctx),
  entityPrefix: "cert",
  propertyColumn: null,
});
