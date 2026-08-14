/**
 * 照合バッチの二重起動防止（Durable Object）。
 *
 * task:  docs/tasks/P4-05.md
 * 仕様:  docs/PK-SPEC-P4.md §5.2
 * ルール: .claude/rules/architecture.md §4
 *
 * ── 粒度は施設 × 業務日 ─────────────────────────────────
 * architecture.md §4 の表どおり。同じ施設の別の日は同時に走ってよい
 * （手動の遡及実行 §5.4 が夜間バッチと重ならない）。
 *
 * ── D1 の一意制約だけでは足りない ───────────────────────
 * `reconciliation_run` には `uq_run`（組織 × 施設 × 業務日 × engineVersion）が
 * あるので、2 本目の Run 行は作れない。**作れないこと自体は正しいが、
 * 遅い。** 照合は 3 系統の読み込み（客室数ぶん）を伴うので、衝突に気づく
 * のが最後の INSERT では、2 回ぶんの読み込みが走ってしまう。DO は
 * インスタンスごとに単一スレッドで動くため、2 本目は読み込みを始める前に
 * 断られる。**一意制約を外さないこと。** DO は速い断り方であって、
 * 唯一の防波堤ではない（`InspectionLock` と同じ判断）。
 *
 * ── 落ちた実行に永久に塞がれない ────────────────────────
 * コンシューマが途中で落ちると `release()` が呼ばれない。保持に**貸出
 * 期限**を持たせ、期限を過ぎた保持は次の要求が奪う（DECISIONS #109）。
 * 期限が無いと、1 回の障害でその施設・その業務日の照合が二度と走らなく
 * なる。**期限は「実行にかかる時間の上限」であって、正常時に効くもの
 * ではない。**
 */

/** 保持している実行。**形を変えるときは互換に注意する**（DO のストレージに移行は無い）。 */
export interface ReconciliationHolder {
  /** 実行の識別子（`reconciliationRun.id` か、採番前なら仮の鍵）。 */
  runKey: string;
  /** どの engine が走っているか。**版が違えば別の Run**（§5.4）。 */
  engineVersion: string;
  /** 保持を取った時刻（epoch ミリ秒）。**サーバー時刻。** */
  startedAtMs: number;
}

/** 保持の置き場。**キーを変えると保持中の実行が消える。** */
export const RECONCILIATION_LOCK_STORAGE_KEY = "holder";

/**
 * 貸出期限（ミリ秒）。**15 分**（DECISIONS #109）。
 *
 * 1 施設ぶんの照合は客室数 × 3 系統の読み込みで、大きな施設でも分の単位に
 * 収まる見込み。Queue の再送（`max_retries = 3`）が一巡するより長く、
 * 人が異常に気づくより短い幅を取った。
 */
export const RECONCILIATION_LEASE_MS = 15 * 60 * 1000;

/** 排他が必要とする永続化の最小の形（テストのため / testing.md §5）。 */
export interface ReconciliationLockStorage {
  get(key: string): Promise<ReconciliationHolder | undefined>;
  put(key: string, value: ReconciliationHolder): Promise<void>;
  delete(key: string): Promise<void>;
}

/** `acquire()` の要求。 */
export interface ReconciliationAcquireRequest {
  runKey: string;
  engineVersion: string;
  nowMs: number;
}

/** `acquire()` の応答。断るときは**何が走っているか**を返す。 */
export type ReconciliationAcquireResult =
  | { acquired: true; holder: ReconciliationHolder; tookOverStale: boolean }
  | { acquired: false; holder: ReconciliationHolder };

/**
 * 排他の本体。DO の外でも動く。
 *
 * `InspectionGate`（P2-03）と同じ形。読み込みは 1 回だけ走り、以後は
 * メモリ上の状態を見る。
 */
export class ReconciliationGate {
  #holder: ReconciliationHolder | null | undefined;
  #loading: Promise<void> | undefined;

  constructor(private readonly storage: ReconciliationLockStorage) {}

  /**
   * 実行の保持を取る。
   *
   * ── 断る条件 ────────────────────────────────────────────
   * **期限内の保持が居る**なら断る。誰が持っていても断る（`InspectionLock`
   * と違い、同じ実行者の再要求という概念が無い）。ただし：
   *
   *   - 同じ `runKey` の再要求は通す。**Queue の再送**（同じメッセージが
   *     2 回届く）で自分の保持に締め出されないため。
   *   - 期限を過ぎた保持は奪う。落ちた実行に永久に塞がれない（冒頭の注記）。
   *
   * ── `await` を挟まずに確定させる ────────────────────────
   * 判定してから代入するまでに `await` を置くと、その隙に届いた 2 本目が
   * 同じ「空いている」を読んで両方が保持を取る。永続化はそのあと。
   */
  async acquire(
    request: ReconciliationAcquireRequest,
  ): Promise<ReconciliationAcquireResult> {
    if (this.#holder === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }

    const current = this.#holder ?? null;
    let tookOverStale = false;
    if (current !== null) {
      const expired = request.nowMs - current.startedAtMs >= RECONCILIATION_LEASE_MS;
      if (!expired && current.runKey !== request.runKey) {
        return { acquired: false, holder: current };
      }
      tookOverStale = expired;
    }

    const holder: ReconciliationHolder = {
      runKey: request.runKey,
      engineVersion: request.engineVersion,
      startedAtMs: request.nowMs,
    };
    this.#holder = holder;

    await this.storage.put(RECONCILIATION_LOCK_STORAGE_KEY, holder);
    return { acquired: true, holder, tookOverStale };
  }

  /**
   * 保持を手放す。**完走・失敗のどちらでも呼ぶ。**
   *
   * **自分の `runKey` でなければ何もしない。** 期限切れで奪われたあとに
   * 遅れて届いた解放要求が、いま走っている実行の保持を消さないようにする。
   *
   * @returns 手放したら `true`。
   */
  async release(runKey: string): Promise<boolean> {
    if (this.#holder === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }
    const current = this.#holder ?? null;
    if (current === null || current.runKey !== runKey) return false;

    this.#holder = null;
    await this.storage.delete(RECONCILIATION_LOCK_STORAGE_KEY);
    return true;
  }

  /** いま走っている実行。**取らない。** */
  async peek(): Promise<ReconciliationHolder | null> {
    if (this.#holder === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }
    return this.#holder ?? null;
  }

  async #load(): Promise<void> {
    this.#holder = (await this.storage.get(RECONCILIATION_LOCK_STORAGE_KEY)) ?? null;
  }
}

/**
 * Durable Object 本体。経路は 3 本。
 *
 *   POST /acquire   保持を取る（取れなければ 409）
 *   POST /release   保持を手放す
 *   GET  /peek      いまの保持を見る
 *
 * **外部へ公開する API ではない。** `env.RECONCILIATION_LOCK` を持つ
 * Worker からしか届かない。
 */
export class ReconciliationLock {
  readonly #gate: ReconciliationGate;

  constructor(state: DurableObjectState) {
    this.#gate = new ReconciliationGate({
      get: (key) => state.storage.get<ReconciliationHolder>(key),
      put: (key, value) => state.storage.put(key, value),
      delete: async (key) => {
        await state.storage.delete(key);
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/acquire") {
      const body = await readAcquire(request);
      if (body === null) return new Response(null, { status: 400 });

      const result = await this.#gate.acquire(body);
      // **409 で返す。** 呼び出し側は Run を `SKIPPED` にして ack する（§5.2）。
      return Response.json(result, { status: result.acquired ? 200 : 409 });
    }

    if (request.method === "POST" && pathname === "/release") {
      const body = await readRelease(request);
      if (body === null) return new Response(null, { status: 400 });

      return Response.json({ released: await this.#gate.release(body.runKey) });
    }

    if (request.method === "GET" && pathname === "/peek") {
      return Response.json({ holder: await this.#gate.peek() });
    }

    return new Response(null, { status: 404 });
  }
}

/** DO へ渡す URL のホストは無意味。経路だけを見る。 */
export const RECONCILIATION_LOCK_ORIGIN = "https://reconciliation-lock.invalid";

/**
 * インスタンス名。**粒度は施設 × 業務日**（architecture.md §4）。
 *
 * 組織 ID を含めるのは名前空間を分けるため（`inspectionLockName()` と同じ）。
 * **シャード番号は含めない**（architecture.md §1）。
 */
export function reconciliationLockName(
  organizationId: string,
  propertyId: string,
  businessDate: string,
): string {
  return `${organizationId}:${propertyId}:${businessDate}`;
}

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readAcquire(request: Request): Promise<ReconciliationAcquireRequest | null> {
  const body = await readJson(request);
  if (body === null) return null;
  const { runKey, engineVersion, nowMs } = body;
  if (typeof runKey !== "string" || runKey === "") return null;
  if (typeof engineVersion !== "string" || engineVersion === "") return null;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return null;
  return { runKey, engineVersion, nowMs };
}

async function readRelease(request: Request): Promise<{ runKey: string } | null> {
  const body = await readJson(request);
  if (body === null) return null;
  const { runKey } = body;
  if (typeof runKey !== "string" || runKey === "") return null;
  return { runKey };
}
