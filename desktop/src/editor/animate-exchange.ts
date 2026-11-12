import { useCallback } from "react";
import { toast } from "sonner";
import { exportAnimate, importAnimate } from "@/lib/fla";

export function useAnimateExchange(options: {
  activeId: string | null;
  name: string | null;
  open: (id: string) => Promise<unknown>;
  reveal?: () => void;
}): { importFlow: () => Promise<void>; exportFlow: () => Promise<void> } {
  const { activeId, name, open, reveal } = options;

  const importFlow = useCallback(async () => {
    try {
      const result = await importAnimate();
      if (!result) {
        return;
      }
      if (result.notes.length > 0) {
        reveal?.();
      }
      toast.success(result.name);
      await open(result.id);
    } catch (error) {
      toast.error(String(error));
    }
  }, [open, reveal]);

  const exportFlow = useCallback(async () => {
    if (!activeId || !name) {
      return;
    }
    try {
      const result = await exportAnimate(activeId, name);
      if (!result) {
        return;
      }
      if (result.warnings.length > 0) {
        reveal?.();
      }
      toast.success(result.path);
    } catch (error) {
      toast.error(String(error));
    }
  }, [activeId, name, reveal]);

  return { importFlow, exportFlow };
}
