import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ReportPanel from "@/editor/ReportPanel";
import { I18nProvider } from "@/i18n";
import {
  REPORT_LIMIT,
  clearFlaReport,
  flaReportLine,
  flaReportText,
  getFlaReport,
  recordFlaReport
} from "@/lib/fla-report";

function mount(): void {
  render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ReportPanel />
    </I18nProvider>
  );
}

describe("animate report store", () => {
  beforeEach(() => {
    clearFlaReport();
  });

  test("records nothing when the exchange lost no features", () => {
    expect(recordFlaReport("export", "C:/x/Clean.fla", [])).toBeNull();
    expect(getFlaReport()).toHaveLength(0);
  });

  test("keeps the newest exchange first and the list inside its limit", () => {
    for (let index = 0; index <= REPORT_LIMIT; index += 1) {
      recordFlaReport("import", `C:/x/Project ${index}.fla`, ["1 mask layer was skipped"]);
    }
    const list = getFlaReport();
    expect(list).toHaveLength(REPORT_LIMIT);
    expect(list[0].name).toBe(`C:/x/Project ${REPORT_LIMIT}.fla`);
    expect(list[1].name).toBe(`C:/x/Project ${REPORT_LIMIT - 1}.fla`);
  });

  test("drops the stored entries it cannot understand", async () => {
    const kept = {
      id: "a",
      kind: "import",
      name: "C:/x/tut.fla",
      at: 5,
      lines: ["1 guide layer was skipped"]
    };
    window.localStorage.setItem(
      "stickmate.fla.report",
      JSON.stringify([
        kept,
        { id: "b", kind: "maybe", name: "x", at: 1, lines: [] },
        { id: "c", kind: "export", name: "y", at: "nope", lines: [] },
        "junk"
      ])
    );
    vi.resetModules();
    const stored = await import("@/lib/fla-report");
    expect(stored.getFlaReport()).toEqual([kept]);
  });

  test("writes every line out for the clipboard", () => {
    recordFlaReport("import", "C:/x/tut.fla", [
      "6577 library symbols were not imported",
      "460 custom easing curves were imported as linear"
    ]);
    recordFlaReport("export", "C:/x/Bounce.fla", ["blend modes are not exported"]);
    expect(flaReportText(getFlaReport())).toBe(
      [
        "Export C:/x/Bounce.fla",
        "- blend modes are not exported",
        "",
        "Import C:/x/tut.fla",
        "- 6577 library symbols were not imported",
        "- 460 custom easing curves were imported as linear"
      ].join("\n")
    );
  });

  test("lifts the count out of a line that carries one", () => {
    expect(flaReportLine("6577 library symbols were not imported")).toEqual({
      count: "6577",
      text: "library symbols were not imported"
    });
    expect(flaReportLine("blend modes are not exported")).toEqual({
      count: null,
      text: "blend modes are not exported"
    });
  });
});

describe("animate report panel", () => {
  beforeEach(() => {
    clearFlaReport();
  });

  test("says so when nothing was reported", () => {
    mount();
    expect(screen.getByText("No Animate exchanges reported yet")).toBeTruthy();
    expect(screen.getByLabelText("Copy report").hasAttribute("disabled")).toBe(true);
  });

  test("lists each exchange with its per feature counts", () => {
    recordFlaReport("import", "C:/x/tut.fla", [
      "6577 library symbols were not imported",
      "3 mask layers were imported as plain layers"
    ]);
    recordFlaReport("export", "C:/x/Bounce.fla", ["blend modes are not exported"]);
    mount();
    expect(screen.getByText("Import")).toBeTruthy();
    expect(screen.getByText("Export")).toBeTruthy();
    expect(screen.getByText("C:/x/tut.fla")).toBeTruthy();
    expect(screen.getByText("library symbols were not imported")).toBeTruthy();
    expect(screen.getByText("6577")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("blend modes are not exported")).toBeTruthy();
  });

  test("copies the whole report and clears it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    recordFlaReport("import", "C:/x/tut.fla", ["1 camera layer was skipped"]);
    mount();
    fireEvent.click(screen.getByLabelText("Copy report"));
    expect(writeText).toHaveBeenCalledWith(
      ["Import C:/x/tut.fla", "- 1 camera layer was skipped"].join("\n")
    );
    fireEvent.click(screen.getByLabelText("Clear report"));
    expect(getFlaReport()).toHaveLength(0);
    expect(screen.getByText("No Animate exchanges reported yet")).toBeTruthy();
  });
});
