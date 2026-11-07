export type ShortcutOverrides = Record<string, string | null>;

export interface ShortcutBinding {
  id: string;
  keys: string | null;
}

export type ProfileResult =
  | { ok: true; overrides: ShortcutOverrides }
  | { ok: false; error: string; detail: string };

const modifierOrder = ["ctrl", "alt", "shift"];

const namedKeys = [
  "space",
  "escape",
  "enter",
  "tab",
  "delete",
  "backspace",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright"
];

const singleKey = /^[a-z0-9,.\-=\/;\[\]'\\`]$/;

const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/;

const displayNames: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  space: "Space",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  delete: "Delete",
  backspace: "Backspace",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right"
};

export function parseCombo(value: string): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const parts = value.toLowerCase().split("+");
  if (parts.length > 4) {
    return null;
  }
  const key = parts[parts.length - 1];
  if (!namedKeys.includes(key) && !singleKey.test(key) && !functionKey.test(key)) {
    return null;
  }
  const held = parts.slice(0, -1);
  const ordered = modifierOrder.filter((name) => held.includes(name));
  if (ordered.length !== held.length) {
    return null;
  }
  return [...ordered, key].join("+");
}

export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => displayNames[part] ?? part.toUpperCase())
    .join("+");
}

export function comboFromEvent(event: KeyboardEvent): string | null {
  const key = event.key === " " ? "space" : event.key.toLowerCase();
  if (key === "control" || key === "alt" || key === "shift" || key === "meta") {
    return null;
  }
  const ctrl = event.ctrlKey || event.metaKey ? "ctrl+" : "";
  const alt = event.altKey ? "alt+" : "";
  const shift = event.shiftKey ? "shift+" : "";
  return parseCombo(`${ctrl}${alt}${shift}${key}`);
}

export function conflictsFor(
  bindings: ShortcutBinding[],
  combo: string,
  id: string
): string[] {
  return bindings
    .filter((item) => item.id !== id && item.keys === combo)
    .map((item) => item.id);
}

export function validateProfile(
  text: string,
  defaults: ShortcutBinding[]
): ProfileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "shortcuts.error.file", detail: "" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "shortcuts.error.file", detail: "" };
  }
  const profile = parsed as { version?: unknown; overrides?: unknown };
  const raw = profile.overrides;
  if (
    profile.version !== 1 ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return { ok: false, error: "shortcuts.error.file", detail: "" };
  }
  const overrides: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!defaults.some((item) => item.id === id)) {
      return { ok: false, error: "shortcuts.error.unknown", detail: id };
    }
    if (value === null) {
      overrides[id] = null;
      continue;
    }
    if (typeof value !== "string") {
      return { ok: false, error: "shortcuts.error.combo", detail: id };
    }
    const combo = parseCombo(value);
    if (combo === null) {
      return { ok: false, error: "shortcuts.error.combo", detail: `${id} ${value}` };
    }
    overrides[id] = combo;
  }
  const taken = new Map<string, string>();
  for (const item of defaults) {
    const value = overrides[item.id];
    const combo = value === undefined ? item.keys : value;
    if (combo === null) {
      continue;
    }
    const owner = taken.get(combo);
    if (owner !== undefined) {
      return { ok: false, error: "shortcuts.error.duplicate", detail: combo };
    }
    taken.set(combo, item.id);
  }
  return { ok: true, overrides };
}