import { useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COUNTRIES } from "@/lib/countries";
import { colors, fonts } from "@/constants/theme";

export function CountrySelector({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const selected = COUNTRIES.find((c) => c.code === value);
  const matches = COUNTRIES.filter((c) =>
    `${c.name} ${c.code}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <View style={{ gap: 8, marginBottom: 16 }}>
      <Text style={{ color: colors.muted, fontSize: 14 }}>
        Country / region
      </Text>
      <Pressable
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Country or region: ${selected?.name ?? value}. Change country.`}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
        style={{
          minHeight: 48,
          borderRadius: 8,
          borderColor: colors.accent,
          borderWidth: 1,
          padding: 12,
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 16 }}>
          {selected?.name ?? value} · Change
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="fade"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,.75)",
            padding: 16,
            paddingTop: insets.top + 16,
            paddingBottom: insets.bottom + 16,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <View
            accessibilityViewIsModal
            style={{
              width: "100%",
              maxWidth: 560,
              height: Math.max(
                180,
                Math.min(600, height - insets.top - insets.bottom - 32),
              ),
              flexShrink: 1,
              borderRadius: 16,
              padding: 16,
              backgroundColor: colors.background,
              gap: 12,
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
            >
              <Text
                style={{
                  flex: 1,
                  color: colors.ink,
                  fontFamily: fonts.sansSemiBold,
                  fontSize: 20,
                }}
              >
                Where do you watch?
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
                style={{
                  minHeight: 44,
                  minWidth: 44,
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: colors.accent, fontSize: 16 }}>Done</Text>
              </Pressable>
            </View>
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              placeholder="Search country or region"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Search country or region"
              style={{
                minHeight: 48,
                padding: 12,
                fontSize: 16,
                color: colors.ink,
                backgroundColor: colors.surface,
                borderRadius: 8,
              }}
            />
            <FlatList
              data={matches}
              keyExtractor={(c) => c.code}
              keyboardShouldPersistTaps="handled"
              style={{ flex: 1 }}
              ListEmptyComponent={
                <Text style={{ color: colors.muted }}>
                  No matching countries or regions.
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: value === item.code }}
                  onPress={() => {
                    onChange(item.code);
                    setOpen(false);
                  }}
                  style={{
                    minHeight: 48,
                    justifyContent: "center",
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.surface,
                  }}
                >
                  <Text
                    style={{
                      color: item.code === value ? colors.accent : colors.ink,
                      fontSize: 16,
                    }}
                  >
                    {item.name}
                    {item.code === value ? " ✓" : ""}
                  </Text>
                </Pressable>
              )}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
