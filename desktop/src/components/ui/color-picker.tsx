"use client";

import {
  ColorPicker as ArkColorPicker,
  parseColor as parseColorArk,
  useColorPicker as useArkColorPicker,
  useColorPickerContext as useArkColorPickerContext,
} from "@ark-ui/react/color-picker";
import { ark } from "@ark-ui/react/factory";
import { Portal } from "@ark-ui/react/portal";
import { CheckIcon, PipetteIcon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";

export const parseColor = parseColorArk;
export const useColorPicker = useArkColorPicker;
export const useColorPickerContext = useArkColorPickerContext;
export const ColorPickerContext = ArkColorPicker.Context;

export interface ColorPickerProps
  extends Omit<
    React.ComponentProps<typeof ArkColorPicker.Root>,
    "defaultValue" | "value"
  > {
  /**
   * The default value of the color picker.
   */
  defaultValue?: string;
  /**
   * The value of the color picker.
   */
  value?: string;
}

const colorPickerRootClassName = cn("group/color-picker", "flex w-fit gap-2");

export const ColorPicker = (props: ColorPickerProps) => {
  const {
    value,
    defaultValue,
    positioning = {
      placement: "top-start",
    },
    lazyMount = true,
    unmountOnExit = true,
    className,
    children,
    ...rest
  } = props;

  return (
    <ArkColorPicker.Root
      className={cn(colorPickerRootClassName, className)}
      data-slot="color-picker"
      defaultValue={defaultValue ? parseColor(defaultValue) : undefined}
      lazyMount={lazyMount}
      positioning={positioning}
      unmountOnExit={unmountOnExit}
      value={value === undefined ? undefined : parseColor(value)}
      {...rest}
    >
      {children}
      <ArkColorPicker.HiddenInput aria-hidden="true" />
    </ArkColorPicker.Root>
  );
};

export const ColorPickerRootProvider = (
  props: React.ComponentProps<typeof ArkColorPicker.RootProvider>
) => {
  const {
    lazyMount = true,
    unmountOnExit = true,
    className,
    children,
    ...rest
  } = props;

  return (
    <ArkColorPicker.RootProvider
      className={cn(colorPickerRootClassName, className)}
      data-slot="color-picker"
      lazyMount={lazyMount}
      unmountOnExit={unmountOnExit}
      {...rest}
    >
      {children}
      <ArkColorPicker.HiddenInput aria-hidden="true" />
    </ArkColorPicker.RootProvider>
  );
};

export const ColorPickerLabel = (
  props: React.ComponentProps<typeof ArkColorPicker.Label>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.Label
      className={cn("font-medium text-sm", className)}
      data-slot="color-picker-label"
      {...rest}
    />
  );
};

export const ColorPickerControl = (
  props: React.ComponentProps<typeof ArkColorPicker.Control>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.Control
      className={cn("flex flex-row items-center gap-2", className)}
      data-slot="color-picker-control"
      {...rest}
    />
  );
};

export const ColorPickerTrigger = (
  props: React.ComponentProps<typeof ArkColorPicker.Trigger>
) => <ArkColorPicker.Trigger data-slot="color-picker-trigger" {...props} />;

export const ColorPickerTransparencyGrid = (
  props: React.ComponentProps<typeof ArkColorPicker.TransparencyGrid>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.TransparencyGrid
      className={cn(
        "size-full rounded-[inherit]",
        "bg-[image:repeating-conic-gradient(hsl(var(--border))_0_25%,transparent_0_50%)] bg-[length:8px_8px]",
        className
      )}
      {...rest}
    />
  );
};

export const ColorPickerContent = (
  props: React.ComponentProps<typeof ArkColorPicker.Content>
) => {
  const { className, ...rest } = props;

  return (
    <Portal>
      <ArkColorPicker.Positioner data-slot="color-picker-positioner">
        <ArkColorPicker.Content
          className={cn(
            "z-50 flex w-64 flex-col gap-3 p-3",
            "rounded-lg border bg-popover text-popover-foreground shadow-md",
            "origin-[var(--transform-origin)] outline-none",
            "data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in",
            "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out",
            "motion-reduce:animate-none",
            className
          )}
          data-slot="color-picker-content"
          {...rest}
        />
      </ArkColorPicker.Positioner>
    </Portal>
  );
};

export const ColorPickerView = (
  props: React.ComponentProps<typeof ArkColorPicker.View>
) => {
  const { className, ...rest } = props;
  return (
    <ArkColorPicker.View
      className={cn("flex w-full flex-col gap-3", className)}
      data-slot="color-picker-view"
      {...rest}
    />
  );
};

export const ColorPickerSlider = (
  props: React.ComponentProps<typeof ArkColorPicker.ChannelSlider>
) => {
  const { className, children, ...rest } = props;

  return (
    <ArkColorPicker.ChannelSlider
      className={cn(
        "relative flex touch-none select-none items-center",
        "data-[orientation=horizontal]:h-3 data-[orientation=horizontal]:w-full",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-32 data-[orientation=vertical]:w-3 data-[orientation=vertical]:flex-col",
        "group-data-[disabled]/color-picker:pointer-events-none group-data-[disabled]/color-picker:opacity-50",
        className
      )}
      data-slot="color-picker-channel-slider"
      {...rest}
    >
      {children}

      <ArkColorPicker.ChannelSliderTrack
        className={cn(
          "grow overflow-hidden rounded-full",
          "data-[orientation=horizontal]:h-3 data-[orientation=horizontal]:w-full",
          "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-3"
        )}
        data-slot="color-picker-channel-slider-track"
      />
      <ArkColorPicker.ChannelSliderThumb
        className={cn(
          "-translate-x-1/2 -translate-y-1/2 relative size-4 shrink-0 rounded-full",
          "border-2 border-white bg-white shadow-sm ring-1 ring-black/10",
          "dark:border-background dark:ring-white/20",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "origin-left data-[orientation=vertical]:origin-bottom"
        )}
        data-slot="color-picker-channel-slider-thumb"
      />
    </ArkColorPicker.ChannelSlider>
  );
};

interface ColorPickerEyeDropperTrigger
  extends React.ComponentProps<typeof ArkColorPicker.EyeDropperTrigger>,
    Pick<ButtonProps, "size" | "variant"> {}

export const ColorPickerEyeDropperTrigger = (
  props: ColorPickerEyeDropperTrigger
) => {
  const { variant = "outline", size = "icon", children, ...rest } = props;

  return (
    <ArkColorPicker.EyeDropperTrigger
      data-slot="color-picker-eye-dropper"
      {...rest}
      asChild
    >
      <Button aria-label="Sample color" size={size} variant={variant}>
        {children ?? <PipetteIcon aria-hidden="true" />}
      </Button>
    </ArkColorPicker.EyeDropperTrigger>
  );
};

export const ColorPickerSwatchGroup = (
  props: React.ComponentProps<typeof ArkColorPicker.SwatchGroup>
) => {
  const { className, ...rest } = props;
  return (
    <ArkColorPicker.SwatchGroup
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-slot="color-picker-swatch-group"
      {...rest}
    />
  );
};

export const ColorPickerSwatchTrigger = (
  props: React.ComponentProps<typeof ArkColorPicker.SwatchTrigger>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.SwatchTrigger
      className={cn(
        "relative flex size-6 items-center justify-center rounded-md",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "data-[state=checked]:ring-2 data-[state=checked]:ring-ring data-[state=checked]:ring-offset-2 data-[state=checked]:ring-offset-background",
        className
      )}
      data-slot="color-picker-swatch-trigger"
      {...rest}
    />
  );
};

export const ColorPickerSwatch = (
  props: React.ComponentProps<typeof ArkColorPicker.Swatch>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.Swatch
      className={cn(
        "size-full shrink-0 overflow-hidden rounded-[inherit] border border-border",
        className
      )}
      data-slot="color-picker-swatch"
      {...rest}
    />
  );
};

export const ColorPickerSwatchIndicator = (
  props: React.ComponentProps<typeof ArkColorPicker.SwatchIndicator>
) => {
  const { className, children, ...rest } = props;

  return (
    <ArkColorPicker.SwatchIndicator
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-white",
        "[&_svg]:size-3",
        className
      )}
      data-slot="color-picker-swatch-indicator"
      {...rest}
    >
      {children ?? <CheckIcon aria-hidden="true" />}
    </ArkColorPicker.SwatchIndicator>
  );
};

export const ColorPickerValue = (
  props: React.ComponentProps<typeof ArkColorPicker.ValueText>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.ValueText
      className={cn("font-medium text-sm", className)}
      data-slot="color-picker-value"
      {...rest}
    />
  );
};

export const ColorPickerValueSwatch = (
  props: React.ComponentProps<typeof ArkColorPicker.ValueSwatch>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.ValueSwatch
      className={cn(
        "relative size-4 shrink-0 overflow-hidden rounded-full border border-border",
        className
      )}
      data-slot="color-picker-value-swatch"
      {...rest}
    />
  );
};

interface ColorPickerAreaProps
  extends React.ComponentProps<typeof ArkColorPicker.Area> {
  /**
   * Lays a dot grid over the area, to read positions against.
   */
  showDots?: boolean;
}

export const ColorPickerArea = (props: ColorPickerAreaProps) => {
  const { className, showDots = false, children, ...rest } = props;

  return (
    <ArkColorPicker.Area
      className={cn(
        "relative h-40 w-full touch-none overflow-hidden rounded-md border border-border",
        {
          "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-[radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] after:bg-[length:8px_8px]":
            showDots,
        },
        className
      )}
      data-slot="color-picker-area"
      {...rest}
    >
      <ArkColorPicker.AreaBackground
        className="size-full rounded-[inherit]"
        data-slot="color-picker-area-background"
      />

      {children}
    </ArkColorPicker.Area>
  );
};

export const ColorPickerAreaThumb = (
  props: React.ComponentProps<typeof ArkColorPicker.AreaThumb>
) => {
  const { className, ...rest } = props;

  return (
    <ArkColorPicker.AreaThumb
      className={cn(
        "size-4 rounded-full border-2 border-white shadow-sm ring-1 ring-black/10",
        "dark:border-background dark:ring-white/20",
        "outline-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-60",
        className
      )}
      data-slot="color-picker-area-thumb"
      {...rest}
    />
  );
};

export const ColorPickerInput = (
  props: Partial<React.ComponentProps<typeof ArkColorPicker.ChannelInput>>
) => {
  const { channel = "hex", ...rest } = props;

  return (
    <ArkColorPicker.ChannelInput
      channel={channel}
      data-slot="color-picker-input"
      {...rest}
    />
  );
};

export const ColorPickerSwatchPreview = (
  props: React.ComponentProps<typeof ark.div>
) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        "pointer-events-none relative size-4 shrink-0 overflow-hidden rounded-full border border-border",
        "group-data-[size=lg]/input-group:size-5",
        "group-data-[size=md]/input-group:size-4",
        "group-data-[size=sm]/input-group:size-3.5",
        className
      )}
      data-slot="color-picker-input-swatch"
      {...rest}
    >
      <ArkColorPicker.TransparencyGrid
        className={cn(
          "size-full rounded-[inherit]",
          "bg-[image:repeating-conic-gradient(hsl(var(--border))_0_25%,transparent_0_50%)] bg-[length:8px_8px]"
        )}
      />
      <ArkColorPicker.ValueSwatch className="z-[1] size-full" />
    </ark.div>
  );
};
