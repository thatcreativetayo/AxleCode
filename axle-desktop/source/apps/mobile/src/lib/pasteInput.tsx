import type { ComponentType, ReactNode } from "react";
import { View, type ViewProps } from "react-native";

import type { PasteEventPayload } from "expo-paste-input";

import { isExpoGo } from "./expoGo";

type NativePasteInput = typeof import("expo-paste-input");

/**
 * `expo-paste-input` renders a custom native view. Its module can be evaluated
 * safely (Expo's `requireNativeView` catches a missing module), but rendering
 * the wrapper in Expo Go would fail. Fall back to a plain View, which keeps the
 * composer usable; only the paste-image gesture is lost there.
 */
const nativePasteInput: NativePasteInput | null = isExpoGo()
  ? null
  : (require("expo-paste-input") as NativePasteInput);

export interface TextInputWrapperProps extends ViewProps {
  readonly onPaste?: (payload: PasteEventPayload) => void;
  readonly children?: ReactNode;
}

function TextInputWrapperFallback({
  onPaste: _onPaste,
  children,
  ...props
}: TextInputWrapperProps) {
  return <View {...props}>{children}</View>;
}

export const TextInputWrapper: ComponentType<TextInputWrapperProps> =
  nativePasteInput?.TextInputWrapper ?? TextInputWrapperFallback;
