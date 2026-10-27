import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  type ComponentType,
  type FC,
  type ReactNode,
} from "react";
import {
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import type {
  CustomRenderers,
  LinkPressHandler,
  MarkdownNode,
  MarkdownProps,
  NodeRendererProps,
  NodeStyleOverrides,
  ParserOptions,
  PartialMarkdownTheme,
  StylingStrategy,
} from "react-native-nitro-markdown";
import type { Token, Tokens } from "marked";

import { isExpoGo } from "./expoGo";

export type {
  CustomRenderer,
  CustomRenderers,
  EnhancedRendererProps,
  LinkPressHandler,
  MarkdownNode,
  MarkdownProps,
  NodeRendererProps,
  NodeStyleOverrides,
  ParserOptions,
  PartialMarkdownTheme,
  StylingStrategy,
} from "react-native-nitro-markdown";

type NativeMarkdownModule = typeof import("react-native-nitro-markdown");

/**
 * `react-native-nitro-markdown` evaluates `react-native-nitro-modules` at
 * module scope, which throws in Expo Go. Keep the native package lazy and fall
 * back to a small `marked`-powered renderer that speaks the same public API.
 */
const nativeMarkdownModule: NativeMarkdownModule | null = isExpoGo()
  ? null
  : (require("react-native-nitro-markdown") as NativeMarkdownModule);

type MarkdownTheme = {
  colors: {
    text: string | undefined;
    textMuted: string | undefined;
    heading: string | undefined;
    link: string | undefined;
    code: string | undefined;
    codeBackground: string | undefined;
    codeLanguage: string | undefined;
    blockquote: string | undefined;
    border: string | undefined;
    surface: string | undefined;
    surfaceLight: string | undefined;
    accent: string | undefined;
    tableBorder: string | undefined;
    tableHeader: string | undefined;
    tableHeaderText: string | undefined;
    tableRowEven: string | undefined;
    tableRowOdd: string | undefined;
  };
  spacing: {
    xs: number;
    s: number;
    m: number;
    l: number;
    xl: number;
  };
  fontSizes: {
    xs: number;
    s: number;
    m: number;
    l: number;
    xl: number;
    h1: number;
    h2: number;
    h3: number;
    h4: number;
    h5: number;
    h6: number;
  };
  fontFamilies: {
    regular: string | undefined;
    heading: string | undefined;
    mono: string | undefined;
  };
  headingWeight?: TextStyle["fontWeight"];
  borderRadius: {
    s: number;
    m: number;
    l: number;
  };
  showCodeLanguage: boolean;
};

const DEFAULT_THEME: MarkdownTheme = {
  colors: {
    text: "#0f172a",
    textMuted: "#64748b",
    heading: "#0f172a",
    link: "#2563eb",
    code: "#0f172a",
    codeBackground: "#f1f5f9",
    codeLanguage: "#94a3b8",
    blockquote: "#cbd5f5",
    border: "#e2e8f0",
    surface: "#ffffff",
    surfaceLight: "#f8fafc",
    accent: "#2563eb",
    tableBorder: "#e2e8f0",
    tableHeader: "#f8fafc",
    tableHeaderText: "#64748b",
    tableRowEven: "transparent",
    tableRowOdd: "#f8fafc",
  },
  spacing: { xs: 4, s: 8, m: 12, l: 16, xl: 24 },
  fontSizes: {
    xs: 12,
    s: 14,
    m: 16,
    l: 18,
    xl: 22,
    h1: 32,
    h2: 26,
    h3: 22,
    h4: 18,
    h5: 16,
    h6: 14,
  },
  fontFamilies: {
    regular: Platform.select({
      ios: "Avenir Next",
      android: "sans-serif",
      default: undefined,
    }),
    heading: Platform.select({
      ios: "Avenir Next",
      android: "sans-serif-medium",
      default: undefined,
    }),
    mono: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },
  headingWeight: undefined,
  borderRadius: { s: 6, m: 10, l: 14 },
  showCodeLanguage: false,
};

const MINIMAL_THEME: MarkdownTheme = {
  ...DEFAULT_THEME,
  colors: {
    ...DEFAULT_THEME.colors,
    text: undefined,
    textMuted: undefined,
    heading: undefined,
    code: undefined,
    codeBackground: "transparent",
    surface: "transparent",
    surfaceLight: "transparent",
    tableHeader: "transparent",
    tableHeaderText: undefined,
    tableRowEven: "transparent",
    tableRowOdd: "transparent",
  },
  spacing: { xs: 0, s: 0, m: 0, l: 0, xl: 0 },
  fontFamilies: { regular: undefined, heading: undefined, mono: undefined },
  borderRadius: { s: 0, m: 0, l: 0 },
};

function mergeThemes(base: MarkdownTheme, partial?: PartialMarkdownTheme): MarkdownTheme {
  if (!partial) {
    return base;
  }
  return {
    colors: { ...base.colors, ...partial.colors },
    spacing: { ...base.spacing, ...partial.spacing },
    fontSizes: { ...base.fontSizes, ...partial.fontSizes },
    fontFamilies: { ...base.fontFamilies, ...partial.fontFamilies },
    borderRadius: { ...base.borderRadius, ...partial.borderRadius },
    headingWeight: partial.headingWeight ?? base.headingWeight,
    showCodeLanguage: partial.showCodeLanguage ?? base.showCodeLanguage,
  };
}

type BaseStyles = ReturnType<typeof createBaseStyles>;

const createBaseStyles = (theme: MarkdownTheme) =>
  StyleSheet.create({
    container: {
      width: "100%",
      maxWidth: "100%",
      flexShrink: 1,
    },
    document: {
      width: "100%",
      maxWidth: "100%",
      flexShrink: 1,
    },
    errorText: {
      color: "#f87171",
      fontSize: 14,
      fontFamily: theme.fontFamilies.mono ?? "monospace",
    },
    text: {
      color: theme.colors.text,
      fontSize: theme.fontSizes.m,
      lineHeight: theme.fontSizes.m * 1.6,
      fontFamily: theme.fontFamilies.regular,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    bold: {
      fontWeight: "700",
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    italic: {
      fontStyle: "italic",
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    strikethrough: {
      textDecorationLine: "line-through",
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    paragraph: {
      width: "100%",
      maxWidth: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      flexShrink: 1,
      marginBottom: theme.spacing.l,
    },
    paragraphInListItem: {
      marginBottom: 0,
      marginTop: 0,
    },
    heading: {
      color: theme.colors.heading,
      fontWeight: theme.headingWeight ?? "700",
      marginTop: theme.spacing.xl,
      marginBottom: theme.spacing.m,
      fontFamily: theme.fontFamilies.heading,
      letterSpacing: -0.2,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    h1: {
      fontSize: theme.fontSizes.h1,
      lineHeight: theme.fontSizes.h1 * 1.3,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: theme.spacing.s,
      letterSpacing: -0.6,
    },
    h2: {
      fontSize: theme.fontSizes.h2,
      lineHeight: theme.fontSizes.h2 * 1.3,
      letterSpacing: -0.4,
    },
    h3: {
      fontSize: theme.fontSizes.h3,
      lineHeight: theme.fontSizes.h3 * 1.3,
    },
    h4: {
      fontSize: theme.fontSizes.h4,
      lineHeight: theme.fontSizes.h4 * 1.3,
    },
    h5: {
      fontSize: theme.fontSizes.h5,
      lineHeight: theme.fontSizes.h5 * 1.3,
    },
    h6: {
      fontSize: theme.fontSizes.h6,
      lineHeight: theme.fontSizes.h6 * 1.3,
      color: theme.colors.textMuted,
    },
    link: {
      color: theme.colors.link,
      textDecorationLine: "underline",
      textDecorationColor: theme.colors.link,
      fontFamily: theme.fontFamilies.regular,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    codeInline: {
      fontFamily: theme.fontFamilies.mono ?? "monospace",
      fontSize: theme.fontSizes.s,
      color: theme.colors.code,
      backgroundColor: theme.colors.codeBackground,
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.s,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    codeBlock: {
      backgroundColor: theme.colors.codeBackground,
      borderRadius: theme.borderRadius.m,
      padding: theme.spacing.l,
      marginVertical: theme.spacing.m,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    codeBlockText: {
      fontFamily: theme.fontFamilies.mono ?? "monospace",
      fontSize: theme.fontSizes.s,
      color: theme.colors.text,
      lineHeight: theme.fontSizes.s * 1.5,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    blockquote: {
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.blockquote,
      paddingLeft: theme.spacing.l,
      marginVertical: theme.spacing.m,
      backgroundColor: theme.colors.surfaceLight,
      paddingVertical: theme.spacing.m,
      paddingRight: theme.spacing.m,
      borderRadius: theme.borderRadius.s,
    },
    horizontalRule: {
      height: 1,
      backgroundColor: theme.colors.border,
      marginVertical: theme.spacing.xl,
    },
    list: {
      marginBottom: theme.spacing.m,
    },
    listNested: {
      marginLeft: theme.spacing.s,
      marginBottom: 0,
    },
    listItem: {
      flexDirection: "row",
      marginBottom: theme.spacing.s,
      alignItems: "flex-start",
    },
    listBullet: {
      color: theme.colors.accent,
      fontSize: theme.fontSizes.m,
      lineHeight: theme.fontSizes.m * 1.6,
      marginRight: theme.spacing.s,
      minWidth: 22,
      textAlign: "center",
      fontFamily: theme.fontFamilies.regular,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    listItemContent: {
      flex: 1,
      minWidth: 0,
    },
    taskListItem: {
      flexDirection: "row",
      alignItems: "flex-start",
      marginBottom: theme.spacing.s,
    },
    taskCheckbox: {
      width: 18,
      height: 18,
      borderRadius: 4,
      borderWidth: 2,
      borderColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
      marginRight: theme.spacing.s,
      marginTop: 2,
    },
    taskCheckboxChecked: {
      backgroundColor: theme.colors.accent,
    },
    taskCheckboxText: {
      color: theme.colors.surface,
      fontSize: 12,
      lineHeight: 12,
      fontWeight: "700",
      fontFamily: theme.fontFamilies.regular,
    },
    taskContent: {
      flex: 1,
      minWidth: 0,
    },
    imageContainer: {
      marginVertical: theme.spacing.m,
      alignItems: "center",
    },
    image: {
      width: "100%",
      minHeight: 160,
      borderRadius: theme.borderRadius.m,
      backgroundColor: theme.colors.surface,
    },
    imageCaption: {
      color: theme.colors.textMuted,
      fontSize: theme.fontSizes.xs,
      marginTop: theme.spacing.s,
      fontStyle: "italic",
      textAlign: "center",
      fontFamily: theme.fontFamilies.regular,
    },
    table: {
      borderWidth: 1,
      borderColor: theme.colors.tableBorder,
      borderRadius: theme.borderRadius.s,
      marginVertical: theme.spacing.m,
      overflow: "hidden",
    },
    tableRow: {
      flexDirection: "row",
      alignItems: "stretch",
    },
    tableHeaderRow: {
      backgroundColor: theme.colors.tableHeader,
    },
    tableRowOdd: {
      backgroundColor: theme.colors.tableRowOdd,
    },
    tableRowEven: {
      backgroundColor: theme.colors.tableRowEven,
    },
    tableCell: {
      flex: 1,
      paddingHorizontal: theme.spacing.s,
      paddingVertical: theme.spacing.xs,
      borderRightWidth: 1,
      borderBottomWidth: 1,
      borderColor: theme.colors.tableBorder,
    },
    tableCellLast: {
      borderRightWidth: 0,
    },
    tableCellText: {
      color: theme.colors.text,
      fontSize: theme.fontSizes.s,
      lineHeight: theme.fontSizes.s * 1.5,
      fontFamily: theme.fontFamilies.regular,
    },
    tableHeaderText: {
      color: theme.colors.tableHeaderText,
      fontWeight: "600",
    },
  });

type RenderContextValue = {
  readonly renderers: CustomRenderers;
  readonly theme: MarkdownTheme;
  readonly styles: NodeStyleOverrides | undefined;
  readonly onLinkPress: LinkPressHandler | undefined;
  readonly baseStyles: BaseStyles;
};

const RenderContext = createContext<RenderContextValue | null>(null);

function useRenderContext(): RenderContextValue {
  const context = useContext(RenderContext);
  if (!context) {
    throw new Error("Markdown renderer used outside of a Markdown component");
  }
  return context;
}

const INLINE_NODE_TYPES = new Set<MarkdownNode["type"]>([
  "text",
  "bold",
  "italic",
  "strikethrough",
  "link",
  "code_inline",
  "soft_break",
  "line_break",
  "html_inline",
  "math_inline",
]);

function getTextContent(node: MarkdownNode): string {
  if (node.content) {
    return node.content;
  }
  return node.children?.map(getTextContent).join("") ?? "";
}

function getFlattenedText(node: MarkdownNode): string {
  if (
    node.type === "text" ||
    node.type === "code_inline" ||
    node.type === "math_inline" ||
    node.type === "html_inline"
  ) {
    return node.content ?? "";
  }
  if (node.type === "code_block" || node.type === "math_block" || node.type === "html_block") {
    return (node.content ?? node.children?.map(getFlattenedText).join("") ?? "").trim() + "\n\n";
  }
  if (node.type === "line_break") return "\n";
  if (node.type === "soft_break") return " ";
  if (node.type === "horizontal_rule") return "---\n\n";
  if (node.type === "image") return node.alt || node.title || "";

  const childrenText = node.children?.map(getFlattenedText).join("") ?? "";
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
      return childrenText.trim() + "\n\n";
    case "list_item":
    case "task_list_item":
      return childrenText.trim() + "\n";
    case "list":
      return childrenText + "\n";
    case "table_row":
      return childrenText + "\n";
    case "table_cell":
      return childrenText + " | ";
    default:
      return childrenText;
  }
}

type AllocateOffset = () => number;

function withOffsets(node: MarkdownNode, allocateOffset: AllocateOffset): MarkdownNode {
  return {
    ...node,
    beg: allocateOffset(),
    end: allocateOffset(),
  };
}

function convertInlineTokens(
  tokens: Token[] | undefined,
  allocateOffset: AllocateOffset,
): MarkdownNode[] {
  return (tokens ?? [])
    .map((token) => convertToken(token, allocateOffset, true))
    .filter((node): node is MarkdownNode => node !== null);
}

function convertBlockTokens(
  tokens: Token[] | undefined,
  allocateOffset: AllocateOffset,
): MarkdownNode[] {
  return (tokens ?? [])
    .map((token) => convertToken(token, allocateOffset, false))
    .filter((node): node is MarkdownNode => node !== null);
}

function convertToken(
  token: Token,
  allocateOffset: AllocateOffset,
  inline: boolean,
): MarkdownNode | null {
  switch (token.type) {
    case "space":
    case "def":
      return null;

    case "paragraph":
      return withOffsets(
        {
          type: "paragraph",
          children: convertInlineTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "heading":
      return withOffsets(
        {
          type: "heading",
          level: token.depth,
          children: convertInlineTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "code":
      return withOffsets(
        {
          type: "code_block",
          content: token.text,
          language: token.lang?.trim().split(/\s+/)[0] || undefined,
        },
        allocateOffset,
      );

    case "blockquote":
      return withOffsets(
        {
          type: "blockquote",
          children: convertBlockTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "hr":
      return withOffsets({ type: "horizontal_rule" }, allocateOffset);

    case "list":
      return withOffsets(
        {
          type: "list",
          ordered: token.ordered,
          start: typeof token.start === "number" ? token.start : 1,
          children: (token.items as Token[])
            .map((item: Token) => convertToken(item, allocateOffset, false))
            .filter((node): node is MarkdownNode => node !== null),
        },
        allocateOffset,
      );

    case "list_item":
      return withOffsets(
        {
          type: token.task ? "task_list_item" : "list_item",
          ...(token.task ? { checked: token.checked === true } : {}),
          children: convertBlockTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "table":
      return convertTableToken(token as Tokens.Table, allocateOffset);

    case "html":
      return withOffsets(
        {
          type: token.block ? "html_block" : "html_inline",
          content: token.text,
        },
        allocateOffset,
      );

    case "strong":
      return withOffsets(
        {
          type: "bold",
          children: convertInlineTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "em":
      return withOffsets(
        {
          type: "italic",
          children: convertInlineTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "del":
      return withOffsets(
        {
          type: "strikethrough",
          children: convertInlineTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "codespan":
      return withOffsets({ type: "code_inline", content: token.text }, allocateOffset);

    case "link":
      return withOffsets(
        {
          type: "link",
          href: token.href,
          ...(token.title ? { title: token.title } : {}),
          children: convertInlineTokens(token.tokens, allocateOffset),
        },
        allocateOffset,
      );

    case "image":
      return withOffsets(
        {
          type: "image",
          href: token.href,
          alt: token.text,
          ...(token.title ? { title: token.title } : {}),
        },
        allocateOffset,
      );

    case "br":
      return withOffsets({ type: "line_break" }, allocateOffset);

    case "escape":
      return withOffsets({ type: "text", content: token.text }, allocateOffset);

    case "text":
      if (!inline && token.tokens && token.tokens.length > 0) {
        return withOffsets(
          {
            type: "paragraph",
            children: convertInlineTokens(token.tokens, allocateOffset),
          },
          allocateOffset,
        );
      }
      return withOffsets({ type: "text", content: token.text }, allocateOffset);

    case "tag":
      return withOffsets({ type: "html_inline", content: token.text }, allocateOffset);

    default:
      return null;
  }
}

function convertTableToken(token: Tokens.Table, allocateOffset: AllocateOffset): MarkdownNode {
  const convertCell = (cell: (typeof token.header)[number], isHeader: boolean): MarkdownNode =>
    withOffsets(
      {
        type: "table_cell",
        isHeader,
        ...(cell.align ? { align: cell.align } : {}),
        children:
          cell.tokens && cell.tokens.length > 0
            ? convertInlineTokens(cell.tokens, allocateOffset)
            : [withOffsets({ type: "text", content: cell.text }, allocateOffset)],
      },
      allocateOffset,
    );

  const headRow = withOffsets(
    {
      type: "table_row",
      children: token.header.map((cell) => convertCell(cell, true)),
    },
    allocateOffset,
  );
  const bodyRows = token.rows.map((row) =>
    withOffsets(
      {
        type: "table_row",
        children: row.map((cell) => convertCell(cell, false)),
      },
      allocateOffset,
    ),
  );

  return withOffsets(
    {
      type: "table",
      children: [
        withOffsets({ type: "table_head", children: [headRow] }, allocateOffset),
        withOffsets({ type: "table_body", children: bodyRows }, allocateOffset),
      ],
    },
    allocateOffset,
  );
}

function parseMarkdownWithMarked(markdown: string, options?: ParserOptions): MarkdownNode {
  const marked = require("marked") as typeof import("marked");
  const tokens = marked.lexer(markdown, {
    gfm: options?.gfm ?? true,
    async: false,
  });
  let offset = 0;
  const allocateOffset = () => {
    const value = offset;
    offset += 1;
    return value;
  };
  const children = convertBlockTokens(tokens, allocateOffset);
  return withOffsets({ type: "document", children }, allocateOffset);
}

function cloneMarkdownNode(node: MarkdownNode): MarkdownNode {
  return {
    ...node,
    children: node.children?.map(cloneMarkdownNode),
  };
}

function DefaultLink(props: {
  readonly href: string;
  readonly children: ReactNode;
  readonly style?: StyleProp<TextStyle>;
}) {
  const { baseStyles, onLinkPress } = useRenderContext();
  return (
    <Text
      style={[baseStyles.link, props.style]}
      onPress={() => {
        void (async () => {
          const shouldOpen = (await Promise.resolve(onLinkPress?.(props.href))) !== false;
          if (!shouldOpen) {
            return;
          }
          try {
            await Linking.openURL(props.href);
          } catch {
            // Ignore unsupported URLs, matching the native renderer.
          }
        })();
      }}
    >
      {props.children}
    </Text>
  );
}

function DefaultImage(props: {
  readonly url: string;
  readonly alt?: string;
  readonly title?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { baseStyles } = useRenderContext();
  return (
    <View style={[baseStyles.imageContainer, props.style]}>
      <Image
        source={{ uri: props.url }}
        style={baseStyles.image}
        resizeMode="contain"
        accessibilityLabel={props.alt}
      />
      {props.title ? <Text style={baseStyles.imageCaption}>{props.title}</Text> : null}
    </View>
  );
}

function DefaultTable(props: { readonly node: MarkdownNode }) {
  const { baseStyles, styles } = useRenderContext();
  const head = props.node.children?.find((child) => child.type === "table_head");
  const body = props.node.children?.find((child) => child.type === "table_body");
  const rows = [...(head?.children ?? []), ...(body?.children ?? [])];

  return (
    <View style={[baseStyles.table, styles?.table]}>
      {rows.map((row, rowIndex) => (
        <View
          key={rowIndex}
          style={[
            baseStyles.tableRow,
            rowIndex === 0 && baseStyles.tableHeaderRow,
            rowIndex > 0 && (rowIndex % 2 === 0 ? baseStyles.tableRowEven : baseStyles.tableRowOdd),
          ]}
        >
          {row.children?.map((cell, cellIndex) => (
            <View
              key={cellIndex}
              style={[
                baseStyles.tableCell,
                cellIndex === (row.children?.length ?? 0) - 1 && baseStyles.tableCellLast,
              ]}
            >
              <Text style={[baseStyles.tableCellText, cell.isHeader && baseStyles.tableHeaderText]}>
                {getTextContent(cell)}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const NodeRendererComponent: FC<NodeRendererProps> = ({
  node,
  depth,
  inListItem,
  parentIsText = false,
}) => {
  const { renderers, baseStyles, styles } = useRenderContext();

  const renderChildren = (
    children?: MarkdownNode[],
    childInListItem = false,
    childParentIsText = false,
  ): ReactNode => {
    if (!children || children.length === 0) {
      return null;
    }

    const elements: ReactNode[] = [];
    let currentInlineGroup: MarkdownNode[] = [];

    const flushInlineGroup = () => {
      if (currentInlineGroup.length === 0) {
        return;
      }

      if (childParentIsText) {
        elements.push(
          <Text key={`inline-group-${elements.length}`}>
            {currentInlineGroup.map((child, index) => (
              <NodeRenderer
                key={`${child.type}-${index}`}
                node={child}
                depth={depth + 1}
                inListItem={childInListItem}
                parentIsText
              />
            ))}
          </Text>,
        );
      } else {
        elements.push(
          <Text key={`inline-group-${elements.length}`} style={baseStyles.text}>
            {currentInlineGroup.map((child, index) => (
              <NodeRenderer
                key={`${child.type}-${index}`}
                node={child}
                depth={depth + 1}
                inListItem={childInListItem}
                parentIsText
              />
            ))}
          </Text>,
        );
      }
      currentInlineGroup = [];
    };

    children.forEach((child, index) => {
      if (INLINE_NODE_TYPES.has(child.type)) {
        currentInlineGroup.push(child);
        return;
      }

      flushInlineGroup();
      elements.push(
        <NodeRenderer
          key={`${child.type}-${index}`}
          node={child}
          depth={depth + 1}
          inListItem={childInListItem}
          parentIsText={childParentIsText}
        />,
      );
    });

    flushInlineGroup();
    return elements;
  };

  const customRenderer = renderers[node.type];
  if (customRenderer) {
    const childrenRendered = renderChildren(node.children, inListItem, parentIsText);
    const baseProps = {
      node,
      children: childrenRendered,
      Renderer: NodeRenderer,
    };
    const enhancedProps = {
      ...baseProps,
      ...(node.type === "heading" && {
        level: (node.level ?? 1) as 1 | 2 | 3 | 4 | 5 | 6,
      }),
      ...(node.type === "link" && {
        href: node.href ?? "",
        title: node.title,
      }),
      ...(node.type === "image" && {
        url: node.href ?? "",
        alt: node.alt,
        title: node.title,
      }),
      ...(node.type === "code_block" && {
        content: getTextContent(node),
        language: node.language,
      }),
      ...(node.type === "code_inline" && {
        content: node.content ?? "",
      }),
      ...(node.type === "list" && {
        ordered: node.ordered ?? false,
        start: node.start,
      }),
      ...(node.type === "task_list_item" && {
        checked: node.checked ?? false,
      }),
    };
    const result = customRenderer(enhancedProps);
    if (result !== undefined) {
      return result as ReactNode;
    }
  }

  switch (node.type) {
    case "document":
      return (
        <View style={[baseStyles.document, styles?.document]}>
          {renderChildren(node.children, false, false)}
        </View>
      );

    case "heading": {
      const level = Math.min(6, Math.max(1, node.level ?? 1));
      return (
        <Text
          style={[
            baseStyles.heading,
            level === 1 && baseStyles.h1,
            level === 2 && baseStyles.h2,
            level === 3 && baseStyles.h3,
            level === 4 && baseStyles.h4,
            level === 5 && baseStyles.h5,
            level === 6 && baseStyles.h6,
            styles?.heading,
          ]}
        >
          {renderChildren(node.children, inListItem, true)}
        </Text>
      );
    }

    case "paragraph":
      return (
        <View
          style={[
            baseStyles.paragraph,
            inListItem && baseStyles.paragraphInListItem,
            styles?.paragraph,
          ]}
        >
          {renderChildren(node.children, inListItem, false)}
        </View>
      );

    case "text":
      if (parentIsText) {
        return <Text>{node.content}</Text>;
      }
      return <Text style={[baseStyles.text, styles?.text]}>{node.content}</Text>;

    case "bold":
      return (
        <Text style={[baseStyles.bold, styles?.bold]}>
          {renderChildren(node.children, inListItem, true)}
        </Text>
      );

    case "italic":
      return (
        <Text style={[baseStyles.italic, styles?.italic]}>
          {renderChildren(node.children, inListItem, true)}
        </Text>
      );

    case "strikethrough":
      return (
        <Text style={[baseStyles.strikethrough, styles?.strikethrough]}>
          {renderChildren(node.children, inListItem, true)}
        </Text>
      );

    case "link":
      return (
        <DefaultLink href={node.href ?? ""} style={styles?.link}>
          {renderChildren(node.children, inListItem, true)}
        </DefaultLink>
      );

    case "image":
      return (
        <DefaultImage
          url={node.href ?? ""}
          alt={node.alt}
          title={node.title}
          style={styles?.image}
        />
      );

    case "code_inline":
      return (
        <Text
          style={[
            baseStyles.codeInline,
            styles?.code_inline ?? (styles as { readonly code?: TextStyle } | undefined)?.code,
          ]}
        >
          {node.content}
        </Text>
      );

    case "code_block":
      return (
        <View
          style={[
            baseStyles.codeBlock,
            styles?.code_block ??
              (styles as { readonly codeBlock?: ViewStyle } | undefined)?.codeBlock,
          ]}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
            <Text style={baseStyles.codeBlockText} selectable>
              {getTextContent(node)}
            </Text>
          </ScrollView>
        </View>
      );

    case "blockquote":
      return (
        <View style={[baseStyles.blockquote, styles?.blockquote]}>
          {renderChildren(node.children, inListItem, false)}
        </View>
      );

    case "horizontal_rule":
      return (
        <View
          style={[
            baseStyles.horizontalRule,
            styles?.horizontal_rule ?? (styles as { readonly hr?: ViewStyle } | undefined)?.hr,
          ]}
        />
      );

    case "line_break":
      return <Text>{"\n"}</Text>;

    case "soft_break":
      return <Text> </Text>;

    case "math_inline": {
      const content = getTextContent(node)
        .replace(/^\$+|\$+$/g, "")
        .trim();
      return content ? <Text style={styles?.math_inline}>{content}</Text> : null;
    }

    case "math_block":
      return (
        <View style={styles?.math_block}>
          <Text style={baseStyles.codeBlockText}>{getTextContent(node)}</Text>
        </View>
      );

    case "list":
      return (
        <View style={[baseStyles.list, depth > 0 && baseStyles.listNested, styles?.list]}>
          {node.children?.map((child, index) => {
            if (child.type === "task_list_item") {
              return (
                <NodeRenderer
                  key={index}
                  node={child}
                  depth={depth + 1}
                  inListItem
                  parentIsText={false}
                />
              );
            }
            return (
              <View key={index} style={[baseStyles.listItem, styles?.list_item]}>
                <Text style={baseStyles.listBullet}>
                  {node.ordered ? `${(node.start ?? 1) + index}.` : "•"}
                </Text>
                <View style={baseStyles.listItemContent}>
                  <NodeRenderer node={child} depth={depth + 1} inListItem parentIsText={false} />
                </View>
              </View>
            );
          })}
        </View>
      );

    case "list_item":
      return <>{renderChildren(node.children, true, false)}</>;

    case "task_list_item":
      return (
        <View style={[baseStyles.taskListItem, styles?.task_list_item]}>
          <View style={[baseStyles.taskCheckbox, node.checked && baseStyles.taskCheckboxChecked]}>
            {node.checked ? <Text style={baseStyles.taskCheckboxText}>✓</Text> : null}
          </View>
          <View style={baseStyles.taskContent}>{renderChildren(node.children, true, false)}</View>
        </View>
      );

    case "table":
      return <DefaultTable node={node} />;

    case "table_head":
    case "table_body":
    case "table_row":
    case "table_cell":
      return null;

    case "html_block":
      return null;

    case "html_inline":
      return <Text>{node.content}</Text>;

    default:
      return null;
  }
};

const NodeRenderer = memo(
  NodeRendererComponent,
  (previousProps, nextProps) =>
    previousProps.node === nextProps.node &&
    previousProps.depth === nextProps.depth &&
    previousProps.inListItem === nextProps.inListItem &&
    previousProps.parentIsText === nextProps.parentIsText,
) as FC<NodeRendererProps>;

function MarkdownFallback({
  children,
  options,
  plugins,
  sourceAst,
  astTransform,
  onParsingInProgress,
  onParseComplete,
  onError,
  renderers,
  theme: userTheme,
  styles,
  stylingStrategy = "opinionated",
  style,
  onLinkPress,
}: MarkdownProps) {
  const parserOptionGfm = options?.gfm;
  const parserOptionMath = options?.math;
  const parserOptionHtml = options?.html;

  const parseResult = useMemo(() => {
    try {
      const sortedPlugins = plugins
        ? [...plugins].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        : undefined;
      let markdown = children;
      if (!sourceAst && sortedPlugins) {
        for (const plugin of sortedPlugins) {
          if (plugin.beforeParse) {
            const transformed = plugin.beforeParse(markdown);
            if (typeof transformed === "string") {
              markdown = transformed;
            }
          }
        }
      }

      let ast = sourceAst
        ? cloneMarkdownNode(sourceAst)
        : parseMarkdownWithMarked(markdown, {
            gfm: parserOptionGfm,
            math: parserOptionMath,
            html: parserOptionHtml,
          });

      if (sortedPlugins) {
        for (const plugin of sortedPlugins) {
          if (plugin.afterParse) {
            const transformed = plugin.afterParse(ast);
            if (transformed && typeof transformed.type === "string") {
              ast = transformed;
            }
          }
        }
      }

      if (astTransform) {
        const transformed = astTransform(ast);
        if (transformed && typeof transformed.type === "string") {
          ast = transformed;
        }
      }

      return { ast };
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)), "parse");
      return { ast: null };
    }
  }, [
    children,
    parserOptionGfm,
    parserOptionMath,
    parserOptionHtml,
    sourceAst,
    astTransform,
    plugins,
    onError,
  ]);

  useEffect(() => {
    onParsingInProgress?.();
  }, [children, parserOptionGfm, parserOptionMath, parserOptionHtml, onParsingInProgress]);

  useEffect(() => {
    if (!parseResult.ast || !onParseComplete) {
      return;
    }
    onParseComplete({
      raw: children,
      ast: parseResult.ast,
      text: getFlattenedText(parseResult.ast),
    });
  }, [children, onParseComplete, parseResult.ast]);

  const theme = useMemo(
    () => mergeThemes(stylingStrategy === "minimal" ? MINIMAL_THEME : DEFAULT_THEME, userTheme),
    [stylingStrategy, userTheme],
  );
  const baseStyles = useMemo(() => createBaseStyles(theme), [theme]);

  const contextValue = useMemo<RenderContextValue>(
    () => ({
      renderers: renderers ?? {},
      theme,
      styles,
      onLinkPress,
      baseStyles,
    }),
    [renderers, theme, styles, onLinkPress, baseStyles],
  );

  if (!parseResult.ast) {
    return (
      <View style={[baseStyles.container, style]}>
        <Text style={baseStyles.errorText}>Error parsing markdown</Text>
      </View>
    );
  }

  return (
    <RenderContext.Provider value={contextValue}>
      <View style={[baseStyles.container, style]}>
        <NodeRenderer node={parseResult.ast} depth={0} inListItem={false} />
      </View>
    </RenderContext.Provider>
  );
}

export const Markdown: ComponentType<MarkdownProps> =
  nativeMarkdownModule?.Markdown ?? MarkdownFallback;
