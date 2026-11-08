import { describe, expect, test } from "vitest";
import {
  MAX_NAME_LENGTH,
  MAX_PRESETS,
  defaultPresetName,
  defaultSettings,
  mergePresets,
  sanitizePresets,
  sanitizeSettings
} from "@/lib/export-presets";
import type { ExportPreset } from "@/lib/export-presets";
import type { ExportSettings } from "@/lib/export";

function preset(
  id: string,
  name = id,
  updatedAt = 1000,
  settings: Partial<ExportSettings> = {}
): ExportPreset {
  return { id, name, updatedAt, settings: { ...defaultSettings, ...settings } };
}

function names(list: ExportPreset[]): string[] {
  return list.map((item) => item.name);
}

describe("export preset sanitisation", () => {
  test("a valid preset round trips unchanged", () => {
    const list = [preset("a", "Web", 5000, { format: "canvasjs", fps: 60 })];
    expect(sanitizePresets(list)).toEqual(list);
  });

  test("non arrays and junk entries are dropped", () => {
    expect(sanitizePresets(undefined)).toEqual([]);
    expect(sanitizePresets("preset")).toEqual([]);
    expect(sanitizePresets([null, 7, [], "a"])).toEqual([]);
  });

  test("a preset needs an id and a non empty name", () => {
    expect(sanitizePresets([{ ...preset(" "), name: "Ok" }])).toEqual([]);
    expect(sanitizePresets([{ ...preset("a"), name: "   " }])).toEqual([]);
    expect(sanitizePresets([{ ...preset("a"), id: 42 }])).toEqual([]);
  });

  test("names are trimmed and capped", () => {
    const [only] = sanitizePresets([{ ...preset("a"), name: "  Web  " }]);
    expect(only?.name).toBe("Web");
    const [long] = sanitizePresets([{ ...preset("a"), name: "n".repeat(200) }]);
    expect(long?.name.length).toBe(MAX_NAME_LENGTH);
  });

  test("duplicate ids and duplicate names keep the first entry", () => {
    const kept = sanitizePresets([preset("a", "First"), preset("a", "Second"), preset("b", "first")]);
    expect(names(kept)).toEqual(["First"]);
  });

  test("the list is capped", () => {
    const kept = sanitizePresets(
      Array.from({ length: MAX_PRESETS + 10 }, (_, index) => preset(`p${index}`))
    );
    expect(kept).toHaveLength(MAX_PRESETS);
    expect(kept[0]?.id).toBe("p0");
  });

  test("settings outside the dialog controls are rejected", () => {
    expect(sanitizeSettings({ ...defaultSettings, format: "gif" })).toBeNull();
    expect(sanitizeSettings({ ...defaultSettings, rangeKind: "clip" })).toBeNull();
    expect(sanitizeSettings({ ...defaultSettings, scale: 3 })).toBeNull();
    expect(sanitizeSettings({ ...defaultSettings, fps: 0 })).toBeNull();
    expect(sanitizeSettings({ ...defaultSettings, fps: 61 })).toBeNull();
    expect(sanitizeSettings({ ...defaultSettings, loop: "yes" })).toBeNull();
    expect(sanitizeSettings({ ...defaultSettings, start: Number.NaN })).toBeNull();
    expect(sanitizeSettings({ ...defaultSettings, start: 9, end: 4 })).toBeNull();
    expect(sanitizeSettings(null)).toBeNull();
  });

  test("settings numbers are rounded and scene ids capped", () => {
    const sceneId = "s".repeat(200);
    const cleaned = sanitizeSettings({ ...defaultSettings, sceneId, fps: 23.6, start: 1.4, end: 8.6 });
    expect(cleaned?.fps).toBe(24);
    expect(cleaned?.start).toBe(1);
    expect(cleaned?.end).toBe(9);
    expect(cleaned?.sceneId.length).toBeLessThanOrEqual(64);
  });

  test("a preset with unusable settings is dropped", () => {
    expect(sanitizePresets([{ ...preset("a"), settings: { fps: 500 } }])).toEqual([]);
  });

  test("a generated name describes the settings", () => {
    expect(defaultPresetName(defaultSettings)).toBe("HTML5 · Whole · 100% · 24 fps");
    expect(
      defaultPresetName({
        ...defaultSettings,
        format: "canvasjs",
        rangeKind: "frames",
        start: 2,
        end: 7,
        scale: 0.5,
        fps: 30,
        transparent: true
      })
    ).toBe("Canvas JS · Frames 2 to 7 · 50% · 30 fps · alpha");
  });
});

describe("export preset merge", () => {
  test("additions from both sides are kept", () => {
    const merged = mergePresets([preset("a")], [preset("b")], []);
    expect(names(merged.data)).toEqual(["a", "b"]);
    expect(merged.contested).toBe(false);
  });

  test("an identical edit is not treated as a conflict", () => {
    const merged = mergePresets([preset("a", "Web")], [preset("a", "Web")], []);
    expect(merged.data).toEqual([preset("a", "Web")]);
    expect(merged.contested).toBe(false);
  });

  test("a preset neither side touched survives", () => {
    const merged = mergePresets([preset("a")], [preset("a")], [preset("a")]);
    expect(merged.data).toEqual([preset("a")]);
  });

  test("the newer edit of a shared preset wins", () => {
    const base = [preset("a", "Old", 100)];
    const merged = mergePresets(
      [preset("a", "Mine", 200)],
      [preset("a", "Theirs", 300)],
      base
    );
    expect(names(merged.data)).toEqual(["Theirs"]);
    expect(merged.contested).toBe(false);
  });

  test("the local side wins a tie", () => {
    const merged = mergePresets(
      [preset("a", "Mine", 200)],
      [preset("a", "Theirs", 200)],
      [preset("a", "Old", 100)]
    );
    expect(names(merged.data)).toEqual(["Mine"]);
  });

  test("an untouched remote edit is applied", () => {
    const merged = mergePresets(
      [preset("a", "Old", 100)],
      [preset("a", "Theirs", 300)],
      [preset("a", "Old", 100)]
    );
    expect(names(merged.data)).toEqual(["Theirs"]);
  });

  test("deleting a preset on one side deletes it when the other side left it alone", () => {
    const base = [preset("a", "Old"), preset("b", "Keep")];
    const merged = mergePresets([preset("a", "Old"), preset("b", "Keep")], [preset("a", "Old")], base);
    expect(names(merged.data)).toEqual(["Old"]);
    const dropped = mergePresets([preset("b", "Keep")], [], base);
    expect(dropped.data).toEqual([]);
  });

  test("an edit resurrects a preset the other side deleted", () => {
    const base = [preset("a", "Old", 100)];
    const merged = mergePresets([preset("a", "Mine", 200)], [], base);
    expect(names(merged.data)).toEqual(["Mine"]);
    const other = mergePresets([], [preset("a", "Theirs", 200)], base);
    expect(names(other.data)).toEqual(["Theirs"]);
  });

  test("a preset unknown locally but untouched remotely stays deleted", () => {
    const base = [preset("a", "Old")];
    expect(mergePresets([], [preset("a", "Old")], base).data).toEqual([]);
  });

  test("invalid entries and duplicates cannot enter through a merge", () => {
    const merged = mergePresets(
      [{ ...preset("a"), settings: { fps: 900 } } as unknown as ExportPreset, preset("b", "Same")],
      [preset("c", "same"), preset("b", "Same")],
      []
    );
    expect(names(merged.data)).toEqual(["Same"]);
  });

  test("a merge never exceeds the cap", () => {
    const ours = Array.from({ length: MAX_PRESETS }, (_, index) => preset(`o${index}`));
    const theirs = Array.from({ length: MAX_PRESETS }, (_, index) => preset(`t${index}`));
    const merged = mergePresets(ours, theirs, []);
    expect(merged.data).toHaveLength(MAX_PRESETS);
    expect(names(merged.data)).toEqual(names(ours));
  });
});
