import { AnimatedLegendList, type AnimatedLegendListProps } from "@legendapp/list/reanimated";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView as RNKeyboardAvoidingView,
  Platform,
  View,
  type LayoutChangeEvent,
  type ViewProps,
} from "react-native";
import {
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

import { isExpoGo } from "./expoGo";

import type {
  IKeyboardState,
  KeyboardAvoidingViewProps,
  KeyboardControllerModule,
  KeyboardEventsModule,
  KeyboardProviderProps,
  KeyboardStickyViewProps,
} from "react-native-keyboard-controller";

type NativeKeyboard = typeof import("react-native-keyboard-controller");
type NativeLegendKeyboard = typeof import("@legendapp/list/keyboard");
type NativeKeyboardAwareLegendList = NativeLegendKeyboard["KeyboardAwareLegendList"];
type NativeUseKeyboardChatComposerInset = NativeLegendKeyboard["useKeyboardChatComposerInset"];
type NativeUseKeyboardScrollToEnd = NativeLegendKeyboard["useKeyboardScrollToEnd"];
type AnchoredEndSpaceConfig = NonNullable<
  Parameters<NativeKeyboardAwareLegendList>[0]["anchoredEndSpace"]
>;

/**
 * `react-native-keyboard-controller` and `@legendapp/list/keyboard` both touch
 * native modules while their JS modules are evaluated. Expo Go does not ship
 * either module, so they must never be required there. Everything below is a
 * JS fallback that keeps the same public surface while the native builds keep
 * using the real implementations.
 */
const nativeKeyboard: NativeKeyboard | null = isExpoGo()
  ? null
  : (require("react-native-keyboard-controller") as NativeKeyboard);
const nativeLegendKeyboard: NativeLegendKeyboard | null = isExpoGo()
  ? null
  : (require("@legendapp/list/keyboard") as NativeLegendKeyboard);

const FALLBACK_KEYBOARD_DURATION_MS = 250;

function keyboardEventDuration(event: { readonly duration?: number }): number {
  return typeof event.duration === "number" && event.duration > 0
    ? event.duration
    : FALLBACK_KEYBOARD_DURATION_MS;
}

function readFallbackKeyboardState(): IKeyboardState {
  const metrics = Keyboard.metrics();
  return {
    isVisible: Keyboard.isVisible(),
    height: metrics?.height ?? 0,
    duration: FALLBACK_KEYBOARD_DURATION_MS,
    timestamp: Date.now(),
    target: 0,
    type: "default",
    appearance: "light",
  };
}

function useFallbackKeyboardState<T = IKeyboardState>(selector?: (state: IKeyboardState) => T): T {
  const [state, setState] = useState<IKeyboardState>(readFallbackKeyboardState);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const update = (isVisible: boolean, height: number, duration: number) => {
      setState((current) => ({
        ...current,
        isVisible,
        height,
        duration,
        timestamp: Date.now(),
      }));
    };
    const show = Keyboard.addListener(showEvent, (event) => {
      update(true, event.endCoordinates.height, keyboardEventDuration(event));
    });
    const hide = Keyboard.addListener(hideEvent, (event) => {
      update(false, 0, keyboardEventDuration(event));
    });

    setState(readFallbackKeyboardState());
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return selector ? selector(state) : (state as T);
}

const fallbackKeyboardEvents: KeyboardEventsModule = {
  addListener(name, listener) {
    const rnEventName =
      Platform.OS === "android"
        ? name === "keyboardWillShow"
          ? "keyboardDidShow"
          : name === "keyboardWillHide"
            ? "keyboardDidHide"
            : name
        : name;
    const subscription = Keyboard.addListener(rnEventName, (event) => {
      listener({
        height: event.endCoordinates.height,
        duration: keyboardEventDuration(event),
        timestamp: Date.now(),
        target: 0,
        type: "default",
        appearance: "light",
      });
    });
    return subscription;
  },
};

const fallbackKeyboardController = {
  dismiss: async () => {
    Keyboard.dismiss();
  },
} as KeyboardControllerModule;

function FallbackKeyboardProvider({ children }: KeyboardProviderProps) {
  return <>{children}</>;
}

const FallbackKeyboardStickyView = forwardRef<View, KeyboardStickyViewProps>(
  function FallbackKeyboardStickyView({ offset, enabled = true, style, children, ...props }, ref) {
    const translateY = useRef(new Animated.Value(offset?.closed ?? 0)).current;
    const closedOffset = offset?.closed ?? 0;
    const openedOffset = offset?.opened ?? 0;

    useEffect(() => {
      if (!enabled) {
        translateY.setValue(closedOffset);
        return;
      }

      const animateTo = (toValue: number, duration: number) => {
        Animated.timing(translateY, {
          toValue,
          duration,
          useNativeDriver: true,
        }).start();
      };
      const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
      const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
      const show = Keyboard.addListener(showEvent, (event) => {
        animateTo(-event.endCoordinates.height + openedOffset, keyboardEventDuration(event));
      });
      const hide = Keyboard.addListener(hideEvent, (event) => {
        animateTo(closedOffset, keyboardEventDuration(event));
      });

      if (Keyboard.isVisible()) {
        translateY.setValue(-(Keyboard.metrics()?.height ?? 0) + openedOffset);
      } else {
        translateY.setValue(closedOffset);
      }

      return () => {
        show.remove();
        hide.remove();
      };
    }, [closedOffset, enabled, openedOffset, translateY]);

    return (
      <Animated.View ref={ref} {...props} style={[style, { transform: [{ translateY }] }]}>
        {children}
      </Animated.View>
    );
  },
);

const FallbackKeyboardAvoidingView = forwardRef<View, KeyboardAvoidingViewProps>(
  function FallbackKeyboardAvoidingView(
    { behavior, automaticOffset: _automaticOffset, enabled = true, ...props },
    ref,
  ) {
    return (
      <RNKeyboardAvoidingView
        ref={ref as unknown as Ref<RNKeyboardAvoidingView>}
        {...props}
        enabled={enabled}
        behavior={behavior === "translate-with-padding" ? "padding" : behavior}
      />
    );
  },
);

type FallbackKeyboardAwareLegendListProps<ItemT> = Omit<
  AnimatedLegendListProps<ItemT>,
  "anchoredEndSpace" | "contentInsetEndAdjustment" | "renderScrollComponent"
> & {
  readonly adjustedInsetCompensation?: number;
  readonly anchoredEndSpace?: AnchoredEndSpaceConfig;
  readonly applyWorkaroundForContentInsetHitTestBug?: boolean;
  readonly contentInsetEndAdjustment?: SharedValue<number>;
  readonly contentInsetEndStaticAdjustment?: number;
  readonly freeze?: boolean | SharedValue<boolean>;
  readonly keyboardLiftBehavior?: "always" | "whenAtEnd" | "persistent" | "never";
  readonly keyboardOffset?: number;
};

function FallbackKeyboardAwareLegendListInner<ItemT>(
  props: FallbackKeyboardAwareLegendListProps<ItemT>,
  forwardedRef: Ref<LegendListRef>,
) {
  const {
    adjustedInsetCompensation: _adjustedInsetCompensation,
    anchoredEndSpace,
    applyWorkaroundForContentInsetHitTestBug: _applyWorkaround,
    contentInsetEndAdjustment,
    contentInsetEndStaticAdjustment = 0,
    freeze: _freeze,
    keyboardLiftBehavior: _keyboardLiftBehavior,
    keyboardOffset: _keyboardOffset,
    ...rest
  } = props;
  const fallbackAdjustment = useSharedValue(0);
  const adjustment = contentInsetEndAdjustment ?? fallbackAdjustment;
  const [dynamicEndAdjustment, setDynamicEndAdjustment] = useState(() => adjustment.value);

  useEffect(() => {
    setDynamicEndAdjustment(adjustment.value);
  }, [adjustment]);

  useAnimatedReaction(
    () => adjustment.value,
    (value) => {
      runOnJS(setDynamicEndAdjustment)(value);
    },
    [adjustment],
  );

  const resolvedAnchoredEndSpace = useMemo(
    () =>
      anchoredEndSpace
        ? {
            ...anchoredEndSpace,
            includeInEndInset: true,
          }
        : undefined,
    [anchoredEndSpace],
  );

  const List = AnimatedLegendList as unknown as ComponentType<
    AnimatedLegendListProps<ItemT> & {
      readonly anchoredEndSpace?: AnchoredEndSpaceConfig;
      readonly contentInsetEndAdjustment?: number;
      readonly ref?: Ref<LegendListRef>;
    }
  >;

  return createElement(List, {
    ref: forwardedRef,
    ...rest,
    ...(resolvedAnchoredEndSpace ? { anchoredEndSpace: resolvedAnchoredEndSpace } : {}),
    contentInsetEndAdjustment: contentInsetEndStaticAdjustment + dynamicEndAdjustment,
  });
}

const FallbackKeyboardAwareLegendList = forwardRef(
  FallbackKeyboardAwareLegendListInner,
) as unknown as NativeKeyboardAwareLegendList;

const fallbackUseKeyboardChatComposerInset: NativeUseKeyboardChatComposerInset = (
  listRef,
  composerRef,
  initialHeight = 0,
  heightAdjustment = 0,
) => {
  const contentInsetEndAdjustment = useSharedValue(Math.max(0, initialHeight + heightAdjustment));
  const lastHeightRef = useRef<number | undefined>(undefined);
  const reportHeight = useCallback(
    (rawHeight: number) => {
      const height = Math.max(0, rawHeight + heightAdjustment);
      if (Number.isFinite(height) && height !== lastHeightRef.current) {
        lastHeightRef.current = height;
        contentInsetEndAdjustment.value = height;
      }
    },
    [contentInsetEndAdjustment, heightAdjustment, listRef],
  );

  useLayoutEffect(() => {
    composerRef.current?.measure((_x, _y, _width, height) => {
      reportHeight(height);
    });
  }, [composerRef, reportHeight]);

  const onComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      reportHeight(event.nativeEvent.layout.height);
    },
    [reportHeight],
  );

  return { contentInsetEndAdjustment, onComposerLayout };
};

const fallbackUseKeyboardScrollToEnd: NativeUseKeyboardScrollToEnd = ({
  freeze: freezeProp,
  listRef,
}) => {
  const internalFreeze = useSharedValue(false);
  const freeze = freezeProp ?? internalFreeze;
  const scrollMessageToEnd = useCallback(
    async ({ animated, closeKeyboard }: { animated: boolean; closeKeyboard: boolean }) => {
      const current = listRef.current;
      if (!current) {
        return;
      }
      freeze.set(true);
      try {
        const dismissPromise = closeKeyboard ? Promise.resolve(Keyboard.dismiss()) : undefined;
        await Promise.all([current.scrollToEnd({ animated }), dismissPromise]);
      } finally {
        freeze.set(false);
      }
    },
    [freeze, listRef],
  );

  return { freeze, scrollMessageToEnd };
};

export const KeyboardProvider: ComponentType<KeyboardProviderProps> =
  nativeKeyboard?.KeyboardProvider ?? FallbackKeyboardProvider;

export const KeyboardController: KeyboardControllerModule =
  nativeKeyboard?.KeyboardController ?? fallbackKeyboardController;

export const KeyboardEvents: KeyboardEventsModule =
  nativeKeyboard?.KeyboardEvents ?? fallbackKeyboardEvents;

export const useKeyboardState: NativeKeyboard["useKeyboardState"] =
  nativeKeyboard?.useKeyboardState ?? useFallbackKeyboardState;

export const KeyboardStickyView: NativeKeyboard["KeyboardStickyView"] =
  nativeKeyboard?.KeyboardStickyView ??
  (FallbackKeyboardStickyView as unknown as NativeKeyboard["KeyboardStickyView"]);

export const KeyboardAvoidingView: NativeKeyboard["KeyboardAvoidingView"] =
  nativeKeyboard?.KeyboardAvoidingView ??
  (FallbackKeyboardAvoidingView as unknown as NativeKeyboard["KeyboardAvoidingView"]);

export const KeyboardAwareLegendList: NativeKeyboardAwareLegendList =
  nativeLegendKeyboard?.KeyboardAwareLegendList ?? FallbackKeyboardAwareLegendList;

export const useKeyboardChatComposerInset: NativeUseKeyboardChatComposerInset =
  nativeLegendKeyboard?.useKeyboardChatComposerInset ?? fallbackUseKeyboardChatComposerInset;

export const useKeyboardScrollToEnd: NativeUseKeyboardScrollToEnd =
  nativeLegendKeyboard?.useKeyboardScrollToEnd ?? fallbackUseKeyboardScrollToEnd;

export type { KeyboardStickyViewProps };
