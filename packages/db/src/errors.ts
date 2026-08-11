/**
 * リポジトリ層・ID 検証が投げるエラー。
 *
 * 仕様: docs/PK-SPEC-P0.md §19.4 第2層
 * task:  docs/tasks/P0-05.md
 *
 * ── なぜ P0-05 でこれを作るのか ──────────────────────────
 * `NotFoundError` は仕様 §19.4 のコード例に現れるだけで、定義を所有する
 * task が `docs/tasks/` 137 件のどこにも無い（P0-07 はリポジトリ層の雛形、
 * P0-10 は resourceGuard、P0-20 はヘルスチェックと Sentry）。
 * `assertIdBelongsToTenant()` は仕様上これを投げる契約なので、実体が無いと
 * P0-05 が完成しない。よってここに最小限だけ置く（DECISIONS #012）。
 *
 * ── 後続 task への申し送り ──────────────────────────────
 * エラー階層を作る task が現れたら、**このクラスを再定義せず再エクスポートで
 * 取り込むこと。** 同名クラスが 2 つあると `instanceof` が片方で外れ、
 * 越境時に 404 のはずが 500 になる。
 *
 * HTTP ステータスや レスポンス整形はここに持たせない。`packages/db` は
 * Hono を知らない。404 への写像は P0-10 の `resourceGuard.ts` の責務。
 */

/**
 * 「リソースが存在しない」ことを表す。
 *
 * **テナント越境でもこれを投げる。** 403 を返すとリソースの存在を
 * 示唆してしまうため（architecture.md §2 第2層）。呼び出し側は
 * このクラスを 404 に写像すること。
 */
export class NotFoundError extends Error {
  /** 機械可読なコード。既定は仕様 §19.4 の `RESOURCE_NOT_FOUND`。 */
  readonly code: string;

  constructor(code = "RESOURCE_NOT_FOUND") {
    super(code);
    this.name = "NotFoundError";
    this.code = code;
  }
}
