import type { MockExtension } from "../backend";

export interface MockMonitor {
  name: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
  workArea: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
}

export function mockMonitor(
  x: number,
  y: number,
  width: number,
  height: number,
  scaleFactor = 1
): MockMonitor {
  return {
    name: `Mock monitor ${x}`,
    position: { x, y },
    size: { width, height },
    scaleFactor,
    workArea: {
      position: { x, y },
      size: { width, height: Math.max(1, height - 40) }
    }
  };
}

export const dockingState = {
  created: [] as Array<{ label: string; options: Record<string, unknown> }>,
  destroyed: [] as string[],
  positions: {} as Record<string, { x: number; y: number }>,
  sizes: {} as Record<string, { width: number; height: number }>,
  monitors: [mockMonitor(0, 0, 1920, 1080)] as MockMonitor[],
  failCreate: false
};

export function reset(): void {
  dockingState.created = [];
  dockingState.destroyed = [];
  dockingState.positions = {};
  dockingState.sizes = {};
  dockingState.monitors = [mockMonitor(0, 0, 1920, 1080)];
  dockingState.failCreate = false;
}

function coords(value: unknown): { x: number; y: number } {
  const wrapped = value as { position?: { x: number; y: number } } | null;
  if (wrapped && wrapped.position) {
    return wrapped.position;
  }
  return value as { x: number; y: number };
}

function dims(value: unknown): { width: number; height: number } {
  const wrapped = value as { size?: { width: number; height: number } } | null;
  if (wrapped && wrapped.size) {
    return wrapped.size;
  }
  return value as { width: number; height: number };
}

export const handlers: MockExtension = () => ({
  "plugin:webview|create_webview_window": (args) => {
    if (dockingState.failCreate) {
      throw new Error("window creation denied");
    }
    const options = (args.options ?? {}) as Record<string, unknown>;
    dockingState.created.push({ label: options.label as string, options });
    return null;
  },
  "plugin:window|available_monitors": () => dockingState.monitors,
  "plugin:window|destroy": (args) => {
    const label = args.label as string;
    dockingState.destroyed.push(label);
    dockingState.created = dockingState.created.filter(
      (item) => item.label !== label
    );
    delete dockingState.positions[label];
    delete dockingState.sizes[label];
    return null;
  },
  "plugin:window|set_position": (args) => {
    dockingState.positions[args.label as string] = coords(args.value);
    return null;
  },
  "plugin:window|outer_position": (args) =>
    dockingState.positions[args.label as string] ?? { x: 0, y: 0 },
  "plugin:window|set_size": (args) => {
    dockingState.sizes[args.label as string] = dims(args.value);
    return null;
  },
  "plugin:window|outer_size": (args) =>
    dockingState.sizes[args.label as string] ?? { width: 420, height: 520 },
  "plugin:window|set_title": () => null
});