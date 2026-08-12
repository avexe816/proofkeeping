/**
 * 請求書・領収書・日報の連番採番（Durable Object）。
 *
 * task:  docs/tasks/P0-17.md
 * 仕様:  docs/PK-SPEC-P0.md §19.9
 * ルール: .claude/rules/architecture.md §4 / .claude/rules/billing.md §5
 *
 * ── なぜ D1 ではないのか ────────────────────────────────
 * §19.9 の MUST。D1 のトランザクションだけでは並列採番で欠番・重複が
 * 起きないことを保証できない。DO はインスタンスごとに単一スレッドで動く。
 *
 * ── インスタンスの粒度 = 組織 × 文書種別 × 年度 ─────────
 * 名前は `documentSequencerName()`（@pk/billing）が組み立てる。
 * **年度が名前に入っていることが「会計年度の切替でリセットする」の
 * 実装そのもの。** リセット API を作らないこと（過去年度のカウンタを
 * 初期化できる経路になる）。
 *
 * ── 欠番は許す。重複は許さない ──────────────────────────
 * カウンタは**同期的に**進め、その後で永続化する。永続化に失敗した
 * 番号は使われないまま飛ぶ（欠番）。billing.md §5 は
 * 「取消時も欠番のまま残す」と定めており、欠番は業務上許容される。
 * 逆順（永続化してから進める）にすると、同時に届いた 2 件が
 * 同じ値を読んで**同じ番号を 2 回払い出す。** これは許容できない。
 *
 * ── 戻す API を作らない ─────────────────────────────────
 * 取消・削除で番号を返却する経路を作らない。返却できると、返却と
 * 採番が競合したときに重複が生まれる。
 */

import type { DocumentType } from "@pk/billing";

/** 永続化された連番の置き場。**キーを変えると採番が 1 からやり直しになる。** */
export const SEQUENCE_STORAGE_KEY = "lastNumber";

/**
 * カウンタが必要とする永続化の最小の形。
 *
 * `DurableObjectStorage` をそのまま要求しない。**この形にしてあるのは
 * テストのため。** 500 並列の検証（testing.md §5）を workerd 無しで回す。
 */
export interface SequenceStorage {
  get(key: string): Promise<number | undefined>;
  put(key: string, value: number): Promise<void>;
}

/**
 * 採番の本体。DO の外でも動く。
 *
 * `load()` は 1 度だけ走る。以後はメモリ上のカウンタを進める
 * （DO はインスタンスが生きている限りメモリを保つ）。
 */
export class DocumentCounter {
  #last: number | undefined;
  #loading: Promise<void> | undefined;

  constructor(private readonly storage: SequenceStorage) {}

  /**
   * 次の番号を払い出す。**1 から始まる。**
   *
   * 読み込みが済んでいなければ待つ。読み込みは 1 回しか走らない
   * （`#loading` を共有する）ので、同時に届いた要求が別々に読み込んで
   * 同じ値から始める状態は起きない。
   */
  async issue(): Promise<number> {
    if (this.#last === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }

    // ここから `await` を挟まずに確定させる。挟むと、その隙に届いた
    // 次の要求が同じ値を読んで重複する。
    const next = (this.#last ?? 0) + 1;
    this.#last = next;

    await this.storage.put(SEQUENCE_STORAGE_KEY, next);
    return next;
  }

  /** 直近に払い出した番号。まだ 1 件も出していなければ 0。**進めない。** */
  async peek(): Promise<number> {
    if (this.#last === undefined) {
      this.#loading ??= this.#load();
      await this.#loading;
    }
    return this.#last ?? 0;
  }

  async #load(): Promise<void> {
    this.#last = (await this.storage.get(SEQUENCE_STORAGE_KEY)) ?? 0;
  }
}

/** 採番の応答。**形は `packages/contracts` ではなく DO の内部契約。** */
export interface IssuedSequence {
  sequence: number;
}

/**
 * Durable Object 本体。
 *
 * 経路は 2 本だけ。
 *
 *   POST /issue   次の番号を払い出す
 *   GET  /peek    直近の番号を見る（進めない）
 *
 * **HTTP の形にしているのは DO の呼び出し規約がそうだから**であって、
 * 外部へ公開する API ではない。`env.DOCUMENT_SEQUENCER` を持つ
 * Worker からしか届かない。
 */
export class DocumentSequencer {
  readonly #counter: DocumentCounter;

  constructor(state: DurableObjectState) {
    this.#counter = new DocumentCounter({
      get: (key) => state.storage.get<number>(key),
      put: (key, value) => state.storage.put(key, value),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/issue") {
      const sequence = await this.#counter.issue();
      return Response.json({ sequence } satisfies IssuedSequence);
    }

    if (request.method === "GET" && pathname === "/peek") {
      const sequence = await this.#counter.peek();
      return Response.json({ sequence } satisfies IssuedSequence);
    }

    return new Response(null, { status: 404 });
  }
}

/** 文書種別ごとの経路を組み立てる側が使う。DO へ渡す URL のホストは無意味。 */
export const SEQUENCER_ORIGIN = "https://document-sequencer.invalid";

/** `DocumentType` を受け取るのは呼び出し側の型を締めるため。DO は名前しか見ない。 */
export type SequencerDocumentType = DocumentType;
