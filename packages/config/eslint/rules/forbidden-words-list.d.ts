/**
 * `forbidden-words-list.js` の型。
 *
 * task: docs/tasks/P0-15.md
 *
 * 実体が `.js` なのは、語彙表そのものが禁止語を含み、`.ts` にすると
 * CI の forbidden-words ジョブが自分自身を検出して落ちるため
 * （`no-forbidden-words.js` の冒頭注記）。TypeScript 側から型付きで
 * 読めるよう、宣言だけをここに置く。
 */

/** `[禁止語, 置換]` の並び。 */
export declare const FORBIDDEN: readonly (readonly [string, string])[];
