import type { MockExtension } from "../backend";

export const server = {
  online: true,
  revision: 0,
  data: {} as Record<string, unknown>
};

export function reset(): void {
  server.online = true;
  server.revision = 0;
  server.data = {};
}

export const handlers: MockExtension = () => ({
  prefs_get: () => {
    if (!server.online) {
      throw new Error("offline");
    }
    return { revision: server.revision, data: structuredClone(server.data) };
  },
  prefs_put: (args) => {
    if (!server.online) {
      throw new Error("offline");
    }
    const base = args.baseRevision as number;
    if (base !== server.revision) {
      return { conflict: true, revision: server.revision };
    }
    server.revision += 1;
    server.data = structuredClone(args.data as Record<string, unknown>);
    return { conflict: false, revision: server.revision };
  }
});