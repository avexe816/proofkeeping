/**
 * シード投入を受ける条件を固定する。
 *
 * task:  なし（staging 環境の構築 / 人間の指示）
 * 判断:  DECISIONS #189
 *
 * ── ここで何を守っているか ──────────────────────────────
 * `/api/v1/dev/seed` は**無認証で組織とユーザーを作る**経路。
 * local だけの間は「Cloudflare 上に存在しない」ことが守りだった。
 * staging へ開いた以上、**開き方そのものをテストで固定する。**
 *
 * とくに次の 2 つが崩れると、公開 URL に無認証の経路が生える。
 *   - production / preview が鍵の有無に関わらず 404 であること
 *   - staging が**鍵を置いていなければ** 404 であること（既定は閉）
 */

import { describe, expect, it } from "vitest";

import type { Env } from "@pk/db";

import { isSeedAllowed } from "./dev.js";

const TOKEN = "seed-token-0123456789abcdef";

describe("isSeedAllowed", () => {
  describe("local", () => {
    it("鍵が無くても受ける（初期データが無いとログインできないため）", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "local", STAGING_SEED_TOKEN: "" }, undefined)).toBe(true);
    });

    it("鍵を渡されても受ける（local は要求しない）", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "local", STAGING_SEED_TOKEN: "" }, "whatever")).toBe(true);
    });
  });

  describe("staging", () => {
    it("鍵が設定され、同じ値が提示されたら受ける", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: TOKEN }, TOKEN)).toBe(true);
    });

    it("**鍵が未設定なら受けない。** 既定は閉じている", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: "" }, TOKEN)).toBe(false);
    });

    it("空白だけの鍵は「未設定」として扱う", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: "   " }, "   ")).toBe(
        false,
      );
    });

    it("鍵が提示されなければ受けない", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: TOKEN }, undefined)).toBe(
        false,
      );
    });

    it("空文字の提示では受けない", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: TOKEN }, "")).toBe(false);
    });

    it("値が違えば受けない", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: TOKEN }, "wrong")).toBe(
        false,
      );
    });

    it("前方一致では受けない（長さが違う）", () => {
      expect(
        isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: TOKEN }, TOKEN.slice(0, -1)),
      ).toBe(false);
    });

    it("末尾に 1 文字足しても受けない", () => {
      expect(isSeedAllowed({ ENVIRONMENT: "staging", STAGING_SEED_TOKEN: TOKEN }, `${TOKEN}x`)).toBe(
        false,
      );
    });
  });

  describe("production / preview は鍵の有無に関わらず 404", () => {
    for (const environment of ["production", "preview"] as const) {
      it(`${environment}: 正しい鍵を提示しても受けない`, () => {
        expect(isSeedAllowed({ ENVIRONMENT: environment, STAGING_SEED_TOKEN: TOKEN }, TOKEN)).toBe(
          false,
        );
      });

      it(`${environment}: 鍵が未設定でも受けない`, () => {
        expect(isSeedAllowed({ ENVIRONMENT: environment, STAGING_SEED_TOKEN: "" }, undefined)).toBe(
          false,
        );
      });
    }

    it("知らない環境名も受けない（既定は閉）", () => {
      expect(
        isSeedAllowed(
          { ENVIRONMENT: "sandbox" as Env["ENVIRONMENT"], STAGING_SEED_TOKEN: TOKEN },
          TOKEN,
        ),
      ).toBe(false);
    });
  });
});
