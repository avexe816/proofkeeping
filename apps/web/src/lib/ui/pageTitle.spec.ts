/**
 * タブの題名（人間の指示 2026-08-22）。
 *
 * ここが守るのは 2 つ。**リンクの文字をそのまま出すこと**と、
 * **知らない経路で名前をでっち上げないこと。**
 */

import { describe, expect, it } from "vitest";

import { ja } from "../../locales/index.js";
import { NAV_ITEMS } from "../../ui/navigation.js";

import { documentTitle, pageTitleKey } from "./pageTitle.js";

describe("pageTitleKey", () => {
  it("サイドバーのリンクと同じ文字を引く", () => {
    expect(pageTitleKey("/app/dashboard")).toBe("nav.dashboard");
    expect(pageTitleKey("/app/settings/staff")).toBe("nav.staff");
  });

  it("**いちばん長く一致した項目が勝つ**（設定の入口に飲まれない）", () => {
    // `/app/settings/rooms` は `/app/settings` にも当たる。
    expect(pageTitleKey("/app/settings/rooms")).toBe("nav.rooms");
    expect(pageTitleKey("/app/settings/room-types")).toBe("nav.roomTypes");
  });

  it("子画面は親の名前を出す（`/app/settings/integrations/{id}/mappings`）", () => {
    const key = pageTitleKey("/app/settings/integrations/int_1/mappings");
    expect(key).not.toBeNull();
  });

  it("施設 ID を含む経路も引ける（プレースホルダの手前で照合する）", () => {
    expect(pageTitleKey("/app/p/o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH/board")).toBe("nav.board");
  });

  it("**知らない経路では `null`**（推測で名前を作らない）", () => {
    for (const pathname of ["/login", "/m/today", "/", "/platform/login"]) {
      expect(pageTitleKey(pathname), pathname).toBeNull();
    }
  });

  it("`/app/settings` そのものは設定の入口の名前", () => {
    expect(pageTitleKey("/app/settings")).toBe("nav.settings");
  });
});

describe("documentTitle", () => {
  it("画面名を先に、ブランドを後ろに置く（狭いタブで先に読めるように）", () => {
    const title = documentTitle("/app/dashboard");
    expect(title.startsWith(ja["nav.dashboard"])).toBe(true);
    expect(title.endsWith(ja["app.brand"])).toBe(true);
  });

  it("知らない経路では既定の題名", () => {
    expect(documentTitle("/login")).toBe(ja["app.title"]);
  });

  it("**すべての `READY` な項目に題名がある**（文言の付け忘れを止める）", () => {
    for (const item of NAV_ITEMS) {
      if (item.status !== "READY") continue;
      expect(ja[item.key], item.key).toBeTruthy();
    }
  });
});
