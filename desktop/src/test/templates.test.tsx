import { describe, expect, test } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import Templates from "@/app/hub/Templates";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import { docRename } from "@/lib/document";
import type { Document } from "@/lib/document";
import { store } from "./backend";
import { cache, server } from "./backend/templates";

let opened: string[] = [];

function mount(): RenderResult {
  opened = [];
  return render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <WorkspaceProvider>
          <Toaster />
          <Templates
            onOpened={(id) => {
              opened.push(id);
            }}
          />
        </WorkspaceProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
}

function card(name: string): HTMLElement {
  const found = screen.getByText(name).parentElement;
  if (!found) {
    throw new Error("template card is not mounted");
  }
  return found;
}

async function useTemplate(name: string): Promise<void> {
  await act(async () => {
    within(card(name)).getByRole("button", { name: "Use template" }).click();
  });
}

async function clickCard(name: string): Promise<void> {
  await act(async () => {
    screen.getByText(name).click();
  });
}

function patchManifest(change: (value: Record<string, unknown>) => void): void {
  const path = "ball/manifest.json";
  const value = JSON.parse(server.files[path]) as Record<string, unknown>;
  change(value);
  server.files[path] = JSON.stringify(value);
}

function patchProject(change: (doc: Document) => void): void {
  const path = "ball/project.json";
  const doc = JSON.parse(server.files[path]) as Document;
  change(doc);
  server.files[path] = JSON.stringify(doc);
}

function stored(id: string): Document {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found.doc;
}

describe("github templates", () => {
  test("the catalog renders one card per published template", async () => {
    mount();
    await screen.findByText("Bouncing ball");
    expect(screen.getByText("Blank stage")).toBeTruthy();
    expect(screen.getByText("Walk cycle")).toBeTruthy();
    expect(
      screen.getByText("A tweened ball you can play right away.")
    ).toBeTruthy();
    expect(screen.getByText(/1280 × 720 · 24 fps · v1\.0\.0/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Use template" })).toHaveLength(3);
    expect(screen.queryByText("Offline. Showing saved templates.")).toBeNull();
  });

  test("browsing fetches previews and never a project file", async () => {
    mount();
    await screen.findByText("Bouncing ball");
    await waitFor(() =>
      expect(card("Bouncing ball").querySelector("img")).not.toBeNull()
    );
    const images = [...document.querySelectorAll("img")];
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
    }
    expect(server.requests).toContain("catalog.json");
    expect(server.requests).toContain("ball/manifest.json");
    expect(server.requests).toContain("ball/preview.svg");
    expect(server.requests.some((path) => path.endsWith("project.json"))).toBe(false);
    expect(store.size).toBe(0);
  });

  test("clicking anywhere on a card creates a new project", async () => {
    mount();
    await screen.findByText("Blank stage");
    await clickCard("Blank stage");
    await waitFor(() => expect(opened).toHaveLength(1));
    const created = stored(opened[0]);
    expect(created.name).toBe("Blank stage");
    expect(created.width).toBe(1920);
    expect(created.height).toBe(1080);
    expect(created.fps).toBe(30);
    expect(created.scenes[0].layers[0].name).toBe("Layer 1");
    expect(store.size).toBe(1);
  });

  test("using a template downloads the project once and keeps its keyframes", async () => {
    const original = server.files["ball/project.json"];
    mount();
    await screen.findByText("Bouncing ball");
    await useTemplate("Bouncing ball");
    await waitFor(() => expect(opened).toHaveLength(1));
    const created = stored(opened[0]);
    const layer = created.scenes[0].layers[0];
    expect(layer.name).toBe("Ball");
    expect(layer.length).toBe(25);
    expect(layer.keys.map((key) => key.frame)).toEqual([0, 12, 24]);
    expect(layer.keys[1].transform.y).toBe(400);
    expect(layer.keys[0].tween).toBe(true);
    expect(created.id).not.toBe("d0");
    expect(
      server.requests.filter((path) => path === "ball/project.json")
    ).toHaveLength(1);
    expect(server.files["ball/project.json"]).toBe(original);
    expect(cache.get("ball/project.json")).toBe(original);
  });

  test("two uses create two independent projects", async () => {
    mount();
    await screen.findByText("Bouncing ball");
    await useTemplate("Bouncing ball");
    await waitFor(() => expect(opened).toHaveLength(1));
    await useTemplate("Bouncing ball");
    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[0]).not.toBe(opened[1]);
    expect(store.size).toBe(2);
    await act(async () => {
      await docRename(opened[0], "My ball");
    });
    expect(stored(opened[0]).name).toBe("My ball");
    expect(stored(opened[1]).name).toBe("Bouncing ball");
    expect(stored(opened[1]).scenes[0].layers[0].keys).toHaveLength(3);
    expect(JSON.parse(cache.get("ball/project.json") as string).id).toBe("d0");
  });

  test("offline browsing falls back to the cached catalog and project", async () => {
    const view = mount();
    await screen.findByText("Bouncing ball");
    await useTemplate("Bouncing ball");
    await waitFor(() => expect(opened).toHaveLength(1));
    const first = opened[0];
    view.unmount();
    server.online = false;
    server.files = {};
    mount();
    await screen.findByText("Offline. Showing saved templates.");
    await screen.findByText("Bouncing ball");
    expect(within(card("Bouncing ball")).getByText("Available offline")).toBeTruthy();
    expect(within(card("Blank stage")).queryByText("Available offline")).toBeNull();
    await useTemplate("Bouncing ball");
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).not.toBe(first);
    expect(stored(opened[0]).scenes[0].layers[0].keys).toHaveLength(3);
    expect(store.size).toBe(2);
  });

  test("an empty cache without network fails and retry recovers", async () => {
    server.online = false;
    mount();
    await screen.findByText("Templates could not be loaded");
    await screen.findByText("Error: templates could not be loaded");
    expect(store.size).toBe(0);
    server.online = true;
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await screen.findByText("Bouncing ball");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Use template" })).toHaveLength(3);
  });

  test("a manifest path that leaves the folder is rejected", async () => {
    patchManifest((value) => {
      value.preview = "../../evil.svg";
    });
    mount();
    await screen.findByText("Error: template ball is invalid");
    await screen.findByText("Templates could not be loaded");
    expect(screen.queryByText("Bouncing ball")).toBeNull();
    expect(server.requests.some((path) => path.includes(".."))).toBe(false);
    expect(store.size).toBe(0);
  });

  test("an oversized project is rejected before it is parsed", async () => {
    server.files["ball/project.json"] = "x".repeat(8 * 1024 * 1024 + 1);
    mount();
    await screen.findByText("Bouncing ball");
    await useTemplate("Bouncing ball");
    await screen.findByText("Error: template file is too large");
    expect(opened).toHaveLength(0);
    expect(store.size).toBe(0);
    expect(cache.has("ball/project.json")).toBe(false);
  });

  test("a template that needs a newer app version cannot be used", async () => {
    patchManifest((value) => {
      value.min_app_version = "9.0.0";
    });
    mount();
    await screen.findByText("Bouncing ball");
    expect(within(card("Bouncing ball")).getByText("Needs a newer app version")).toBeTruthy();
    const button = within(card("Bouncing ball")).getByRole("button", {
      name: "Use template"
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    await clickCard("Bouncing ball");
    await waitFor(() =>
      expect(screen.getAllByText("Needs a newer app version").length).toBeGreaterThan(1)
    );
    expect(server.requests).not.toContain("ball/project.json");
    expect(store.size).toBe(0);
    expect(opened).toHaveLength(0);
  });

  test("a project without scenes is rejected", async () => {
    patchProject((doc) => {
      doc.scenes = [];
    });
    mount();
    await screen.findByText("Bouncing ball");
    await useTemplate("Bouncing ball");
    await screen.findByText("Error: template project is invalid");
    expect(store.size).toBe(0);
    expect(opened).toHaveLength(0);
  });

  test("a project with an invalid shape is rejected", async () => {
    patchProject((doc) => {
      doc.scenes[0].layers[0].keys[0].shapes = [
        {
          kind: "Polygon",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          sides: 2,
          fill: "#000000",
          stroke: "#000000",
          width: 2
        }
      ];
    });
    mount();
    await screen.findByText("Bouncing ball");
    await useTemplate("Bouncing ball");
    await screen.findByText("Error: polygon needs at least 3 sides");
    expect(store.size).toBe(0);
    expect(opened).toHaveLength(0);
  });

  test("a project that disagrees with its manifest is rejected", async () => {
    patchProject((doc) => {
      doc.width = 640;
    });
    mount();
    await screen.findByText("Bouncing ball");
    await useTemplate("Bouncing ball");
    await screen.findByText("Error: template project does not match its manifest");
    expect(store.size).toBe(0);
    expect(opened).toHaveLength(0);
  });
});