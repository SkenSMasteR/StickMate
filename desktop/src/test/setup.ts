import { afterEach, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { cleanup } from "@testing-library/react";
import { installBackend, resetBackend } from "./backend";

class Observer {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

vi.stubGlobal("ResizeObserver", Observer);
vi.stubGlobal("crypto", webcrypto);
vi.stubGlobal("IntersectionObserver", Observer);
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false
}));

Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.scrollIntoView = () => {};

interface PointerInit extends MouseEventInit {
  pointerId?: number;
  pointerType?: string;
  pressure?: number;
  isPrimary?: boolean;
}

class JsdomPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  pressure: number;
  isPrimary: boolean;

  constructor(type: string, init: PointerInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
    this.pressure = init.pressure ?? (init.buttons ? 0.5 : 0);
    this.isPrimary = init.isPrimary ?? true;
  }
}

vi.stubGlobal("PointerEvent", JsdomPointerEvent);

beforeEach(() => {
  resetBackend();
  installBackend("main");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});