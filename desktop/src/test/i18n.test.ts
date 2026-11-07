import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import mk from "@/i18n/mk.json";

describe("translation catalogs", () => {
  it("keeps English and Macedonian key sets identical", () => {
    expect(Object.keys(mk).sort()).toEqual(Object.keys(en).sort());
  });

  it("has no empty translations", () => {
    for (const catalog of [en, mk]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), key).not.toBe("");
      }
    }
  });
});