/**
 * loader / action から Workers の binding を取り出すための context。
 *
 * task: docs/tasks/P0-14.md
 *
 * React Router v8 の `loadContext` は `RouterContextProvider` で、
 * 任意のオブジェクトではなく `createContext()` で作った鍵で出し入れする。
 * **鍵の定義はここ 1 か所。** Worker のエントリ（`src/index.ts`）が値を入れ、
 * loader / action が `getCloudflare(context)` で取り出す。
 */

import type { Env } from "@pk/db";
import { createContext, type RouterContextProvider } from "react-router";

/**
 * リクエストの寿命に関わる操作。
 *
 * **`ExecutionContext` を直に使っていない。** Hono が同梱する型と
 * `@cloudflare/workers-types` の型は版がずれる（後者には `tracing` /
 * `abort` が増えている）。ここで要るのは `waitUntil` だけなので、
 * 使う分だけを構造として宣言し、版のずれを持ち込まない。
 */
export interface RequestLifecycle {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CloudflareBindings {
  env: Env;
  ctx: RequestLifecycle;
}

/**
 * loader / action が受け取る `context` の型。
 *
 * React Router は `Readonly<RouterContextProvider>` として渡す（値を
 * 差し替えられるのは Worker のエントリだけ）。読み出しはできる。
 */
export type LoadContext = Readonly<RouterContextProvider>;

/** Worker のエントリだけが `set()` する。 */
export const cloudflareContext = createContext<CloudflareBindings>();

/** loader / action から binding を取り出す。 */
export function getCloudflare(context: LoadContext): CloudflareBindings {
  return context.get(cloudflareContext);
}

/** binding のうち `Env` だけが要る場合の短縮形。 */
export function getEnv(context: LoadContext): Env {
  return getCloudflare(context).env;
}
