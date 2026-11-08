import { usePrefs } from "@/lib/prefs";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import Picker from "@/components/color-field";
import NumberField from "./NumberField";
import { Section } from "./SidePanel";
import { useWorkspace } from "./workspace";

function Toggle({
  id,
  label,
  active,
  onToggle
}: {
  id: string;
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-view-toggle={id}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "h-7 w-full border px-2 text-left text-xs",
        active
          ? "border-border bg-accent text-accent-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      {label}
    </button>
  );
}

export default function ViewPanel() {
  const { t } = useI18n();
  const { tab, actions } = useWorkspace();
  const prefs = usePrefs();
  const view = prefs.prefs.view;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Section title={t("view.onion")}>
        <Toggle
          id="onion"
          label={t("view.onion")}
          active={tab?.onion ?? false}
          onToggle={actions.toggleOnion}
        />
        <Toggle
          id="trace"
          label={t("view.trace")}
          active={view.onionMode === "trace"}
          onToggle={() =>
            actions.setView({ onionMode: view.onionMode === "trace" ? "ghost" : "trace" })
          }
        />
        <NumberField
          label={t("view.frames")}
          value={tab?.onionRange ?? 1}
          min={1}
          max={5}
          onCommit={(value) => actions.setOnionRange(value)}
        />
        <NumberField
          label={t("view.opacity")}
          value={Math.round(view.onionOpacity * 100)}
          min={5}
          max={100}
          step={5}
          onCommit={(value) => actions.setView({ onionOpacity: value / 100 })}
        />
      </Section>
      <Section title={t("view.guides")}>
        <Toggle
          id="grid"
          label={t("view.grid")}
          active={view.grid}
          onToggle={() => actions.setView({ grid: !view.grid })}
        />
        <NumberField
          label={t("view.gridSize")}
          value={view.gridSize}
          min={4}
          max={400}
          onCommit={(value) => actions.setView({ gridSize: value })}
        />
        <Toggle
          id="rulers"
          label={t("view.rulers")}
          active={view.rulers}
          onToggle={() => actions.setView({ rulers: !view.rulers })}
        />
        <Toggle
          id="safeAreas"
          label={t("view.safe")}
          active={view.safeAreas}
          onToggle={() => actions.setView({ safeAreas: !view.safeAreas })}
        />
      </Section>
      <Section title={t("view.canvas")}>
        <Toggle
          id="checkerboard"
          label={t("view.checkerboard")}
          active={view.checkerboard}
          onToggle={() => actions.setView({ checkerboard: !view.checkerboard })}
        />
        <div className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-muted-foreground">{t("view.backdrop")}</span>
          <Picker
            value={view.backdrop}
            label={t("view.backdrop")}
            square
            onChange={(value) => actions.setView({ backdrop: value })}
          />
        </div>
      </Section>
    </div>
  );
}
