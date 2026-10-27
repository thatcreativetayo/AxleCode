import type { SelectableMarkdownTextProps } from "@axle/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";
import { isExpoGo } from "../lib/expoGo";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@axle/mobile-markdown-text/types";

type NativeRendererModule = typeof import("@axle/mobile-markdown-text/renderer");

/**
 * The selectable markdown renderer is backed by nitro markdown. Expo Go does
 * not ship the nitro module, so report the native renderer as unavailable and
 * let callers use the JS markdown fallback instead.
 */
const nativeRenderer: NativeRendererModule | null = isExpoGo()
  ? null
  : (require("@axle/mobile-markdown-text/renderer") as NativeRendererModule);

export function hasNativeSelectableMarkdownText(): boolean {
  return nativeRenderer !== null;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  const NativeSelectableMarkdownText = nativeRenderer?.SelectableMarkdownText;
  if (!NativeSelectableMarkdownText) {
    return null;
  }
  return <NativeSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
