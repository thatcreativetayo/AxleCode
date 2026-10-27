import { requireNativeView } from "expo";
import {
  Pressable,
  Text,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";

import { isExpoGo } from "../lib/expoGo";

interface NativeHeaderButtonProps extends ViewProps {
  readonly label: string;
  readonly systemImage: "gearshape" | "square.and.pencil";
  readonly onTriggered: (event: NativeSyntheticEvent<Record<string, never>>) => void;
}

const NativeHeaderButton = requireNativeView<NativeHeaderButtonProps>("T3NativeControls");

export function T3HeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: NativeHeaderButtonProps["systemImage"];
  readonly onPress: () => void;
  readonly style?: StyleProp<ViewStyle>;
}) {
  if (isExpoGo()) {
    return (
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        onPress={props.onPress}
        style={[
          { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
          props.style,
        ]}
      >
        <Text style={{ fontSize: 20 }}>{props.icon === "gearshape" ? "⚙" : "✎"}</Text>
      </Pressable>
    );
  }

  return (
    <NativeHeaderButton
      label={props.accessibilityLabel}
      onTriggered={props.onPress}
      style={[{ width: 44, height: 44 }, props.style]}
      systemImage={props.icon}
    />
  );
}
