/**
 * 検査開始の排他制御（Durable Object）。
 *
 * task:  docs/tasks/P2-03.md
 * 仕様:  docs/PK-SPEC-P0.md §19.9 / docs/PK-SPEC-P2.md §4.2
 * ルール: .claude/rules/architecture.md §4
 *
 * ── なぜ D1 の一意制約だけでは足りないのか ───────────────
 * `inspection` には `(organizationId, taskId, round)` の一意制約がある。
 * 2 人が同時に「検査を開始」を押せば、後から INSERT した側が制約で落ちる。
 * **落ちること自体は正しいが、それでは遅い。** 検査開始は項目の展開
 * （チェックリストのスナップショット）を伴うので、2 人ぶんの書き込みが
 * 走ってから片方が巻き戻る。DO はインスタンスごとに単一スレッドで動くため、
 * 2 人目は書き込みを始める前に断られる。
 *
 * **一意制約を外さないこと。** DO は速い断り方であって、唯一の防波堤ではない。
 * DO の呼び出しに失敗した経路（binding 未設定・障害）でも重複は作らせない。
 *
 * ── インスタンスの粒度 = タスク ─────────────────────────
 * 名前は `inspectionLockName()` が組み立てる。**組織 ID を必ず名前に含める。**
 * `taskId` は自己記述 ID なので組織を跨いだ衝突は起きないが、名前空間を
 * 組織で分けておくと、名前だけを見て取り違えを検出できる。
 *
 * ── ラウンドを状態に持つ ────────────────────────────────
 * 差戻し → 再清掃 → 再検査（§4.6）で同じタスクを何度も検査する。
 * 保持しているのは「いま開いている検査」であって「このタスクは検査済み」
 * ではない。**完了時に `release()` を呼ぶこと。** 呼ばれなければ次の
 * ラウンドが開始できない…とはならないように、`round` が進んだ要求は
 * 前のラウンドの保持を引き継いで奪う（下記 `acquire()` の注記）。
 */

/**
 * 保持している検査。**この形を変えるときは互換に注意する。**
 * DO のストレージは移行の仕組みを持たない（古い形が残ったまま起動する）。
 */
export interface InspectionHolder {
  round: number;
  /** 検査担当者の `membership.id`。 */
  inspectorId: string;
  /** 保持を取った時刻（epoch ミリ秒）。**サーバー時刻。** */
  startedAtMs: number;
}

/** 保持の置き場。**キーを変えると保持中の検査が消える。** */
export const LOCK_STORAGE_KEY = "holder";

/**
 * 排他が必要とする永続化の最小の形。
 *
 * `DurableObjectStorage` をそのまま要求しない。**テストのため**
 * （同時開始の検証を workerd 無しで回す / testing.md §5）。
 */
export interface LockStorage {
  get(key: string): Promise<InspectionHolder | undefined>;
  put(key: string, value: InspectionHolder): Promise<void>;
  delete(key: string): Promise<void>;
}

/** `acquire()` の要求。 */
export interface AcquireRequest {
  round: number;
  inspectorId: string;
  nowMs: number;
}

/** `acquire()` の応答。断るときは**誰が保持しているか**を返す。 */
export type AcquireResult =
  | { acquired: true; holder: InspectionHolder }
  | { acquired: false; holder: InspectionHolder };

/**
 * 排他の本体。DO の外でも動く。
 *
 * `DocumentCounter`（P0-17）と同じ形にしてある。読み込みは 1 回だけ走り、
 * 以後はメモリ上の状態を見る（DO はインスタンスが生きている限りメモリを保つ）。
 */
export class InspectionGate {
  #holder: InspectionHolder | null | undefined;
  #loading: Promise<void> | undefined;

  constructor(private readonly storage: LockStorage) {}

  /**
   * 検査の保持を取る。
   *
   * ── 断る条件 ────────────────────────────────────────────
   * 同じラウンドを**別の検査者**が保持している場合だけ断る。
   *
   *   - 同じ検査者・同じラウンドの再要求は通す。オフラインの再送や
   *     画面の再読み込みで「自分が始めた検査に入れない」を作らないため。
   *   - `round` が進んだ要求は通す。差戻し後の再検査（§4.6）は別の
   *     検査者が担当しうる。前のラウンドで `release()` が呼ばれずに
   *     残った保持が、次のラウンドを永久に塞ぐ状態を作らない。
   *   - `round` が戻った要求は断る。**古い要求の遅れて届いた再送**で、
   *     いま進んでいる検査を奪わせない。
   *
   * ── `await` を挟まずに確定させる ────────────────────────
   * 判定してから代入するまでに `await` を置くと、その隙に届いた 2 人目が
   * 同じ「空いている」を読んで両方が保持を取る。永続化はそのあと。
   */
  async acquire(request: AcquireRequest): Promise<AcquireResult> {
    if (this.#holder === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }

    const current = this.#holder ?? null;
    if (current !== null) {
      const sameInspector = current.inspectorId === request.inspectorId;
      const sameRound = current.round === request.round;
      if (sameRound && !sameInspector) return { acquired: false, holder: current };
      if (current.round > request.round) return { acquired: false, holder: current };
      if (sameRound && sameInspector) return { acquired: true, holder: current };
    }

    const holder: InspectionHolder = {
      round: request.round,
      inspectorId: request.inspectorId,
      startedAtMs: request.nowMs,
    };
    this.#holder = holder;

    await this.storage.put(LOCK_STORAGE_KEY, holder);
    return { acquired: true, holder };
  }

  /**
   * 保持を手放す。検査の完了・中止で呼ぶ。
   *
   * **自分が保持しているラウンドでなければ何もしない。** 遅れて届いた
   * 古い完了要求が、いま進んでいる検査の保持を消さないようにする。
   *
   * @returns 手放したら `true`。
   */
  async release(round: number): Promise<boolean> {
    if (this.#holder === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }
    const current = this.#holder ?? null;
    if (current === null || current.round !== round) return false;

    this.#holder = null;
    await this.storage.delete(LOCK_STORAGE_KEY);
    return true;
  }

  /** いま保持している検査。**取らない。** */
  async peek(): Promise<InspectionHolder | null> {
    if (this.#holder === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }
    return this.#holder ?? null;
  }

  async #load(): Promise<void> {
    this.#holder = (await this.storage.get(LOCK_STORAGE_KEY)) ?? null;
  }
}

/**
 * Durable Object 本体。経路は 3 本。
 *
 *   POST /acquire   保持を取る（取れなければ 409）
 *   POST /release   保持を手放す
 *   GET  /peek      いまの保持を見る
 *
 * **HTTP の形にしているのは DO の呼び出し規約がそうだから**であって、
 * 外部へ公開する API ではない。`env.INSPECTION_LOCK` を持つ Worker から
 * しか届かない。
 */
export class InspectionLock {
  readonly #gate: InspectionGate;

  constructor(state: DurableObjectState) {
    this.#gate = new InspectionGate({
      get: (key) => state.storage.get<InspectionHolder>(key),
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
      // **409 で返す。** 呼び出し側は `INSPECTION_ALREADY_STARTED`（§4.2）へ写す。
      return Response.json(result, { status: result.acquired ? 200 : 409 });
    }

    if (request.method === "POST" && pathname === "/release") {
      const body = await readRelease(request);
      if (body === null) return new Response(null, { status: 400 });

      return Response.json({ released: await this.#gate.release(body.round) });
    }

    if (request.method === "GET" && pathname === "/peek") {
      return Response.json({ holder: await this.#gate.peek() });
    }

    return new Response(null, { status: 404 });
  }
}

/** DO へ渡す URL のホストは無意味。経路だけを見る。 */
export const INSPECTION_LOCK_ORIGIN = "https://inspection-lock.invalid";

/**
 * インスタンス名。**粒度はタスク**（architecture.md §4）。
 *
 * 組織 ID を含めるのは名前空間を分けるため（冒頭の注記）。
 */
export function inspectionLockName(organizationId: string, taskId: string): string {
  return `${organizationId}:${taskId}`;
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

async function readAcquire(request: Request): Promise<AcquireRequest | null> {
  const body = await readJson(request);
  if (body === null) return null;
  const { round, inspectorId, nowMs } = body;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) return null;
  if (typeof inspectorId !== "string" || inspectorId === "") return null;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return null;
  return { round, inspectorId, nowMs };
}

async function readRelease(request: Request): Promise<{ round: number } | null> {
  const body = await readJson(request);
  if (body === null) return null;
  const { round } = body;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) return null;
  return { round };
}
