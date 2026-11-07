import type { MockExtension } from "../backend";

export const channelState = { channel: "stable", writes: 0 };

export function reset(): void {
  channelState.channel = "stable";
  channelState.writes = 0;
}

export const handlers: MockExtension = () => ({
  set_update_channel: (args) => {
    const channel = args.channel as string;
    if (channel !== "stable" && channel !== "nightly") {
      throw new Error(`unknown update channel ${channel}`);
    }
    channelState.channel = channel;
    channelState.writes += 1;
    return null;
  }
});