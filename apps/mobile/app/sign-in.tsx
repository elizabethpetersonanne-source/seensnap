import * as AppleAuthentication from "expo-apple-authentication";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { safeReturnPath } from "@/lib/return-path";
import { SSLogo } from "@/components/branding/ss-logo";
import { colors, fonts, radii, rules, spacing } from "@/constants/theme";
import { DEV_AUTH_ENABLED, useAuth } from "@/lib/auth";

export default function SignInScreen() {
  const { isExpoGo, isLoading, googleAvailable, signInDemo, signInWithGoogle, signInWithApple, signInWithDevEmail } =
    useAuth();
  const {returnTo}=useLocalSearchParams<{returnTo?:string}>();
  const hasSharedDestination=!!safeReturnPath(returnTo);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [devEmail, setDevEmail] = useState("");
  const [devMode, setDevMode] = useState(false);


  useEffect(() => {
    if (Platform.OS === "ios" && !isExpoGo) {
      void AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false));
    }
  }, [isExpoGo]);

  async function handleDemoSignIn() {
    setError(null);
    try {
      await signInDemo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo sign-in failed. Please try again.");
    }
  }

  async function handleGoogleSignIn() {
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
    }
  }

  async function handleAppleSignIn() {
    setError(null);
    try {
      await signInWithApple();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apple sign-in failed");
    }
  }

  async function handleDevEmailSignIn() {
    setError(null);
    try {
      await signInWithDevEmail(devEmail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test sign-in failed");
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <View style={styles.inner}>
        {/* Welcome — large centered logo + editorial eyebrow line */}
        <View style={styles.header}>
          <SSLogo variant="gold" size={96} style={styles.logo} />
          <Text style={styles.welcome}>Welcome to SeenSnap</Text>
          {hasSharedDestination?<Text style={{color:colors.muted,fontSize:16,textAlign:"center"}}>Sign in to open what was shared with you.</Text>:null}
        </View>

        {/* Auth actions */}
        <View style={styles.actions}>
          {error ? <Text style={styles.error}>{error}</Text> : null}

          {isExpoGo && DEV_AUTH_ENABLED ? (
            <Pressable
              accessibilityRole="button"
              disabled={isLoading}
              onPress={() => void handleDemoSignIn()}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnLabel}>
                {isLoading ? "Loading..." : "Continue in Demo Mode"}
              </Text>
            </Pressable>
          ) : (
            <>
              {appleAvailable ? (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                  cornerRadius={radii.sm}
                  style={styles.appleBtn}
                  onPress={() => void handleAppleSignIn()}
                />
              ) : null}
              {googleAvailable ? <Pressable
                accessibilityRole="button"
                disabled={isLoading}
                onPress={() => void handleGoogleSignIn()}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && styles.pressed,
                  appleAvailable && styles.secondaryBtnOffset,
                ]}
              >
                <Text style={styles.secondaryBtnLabel}>
                  {isLoading ? "Connecting..." : "Continue with Google"}
                </Text>
              </Pressable> : null}
            </>
          )}

          {/* Dev / Expo Go: create or sign into a real test account via /auth/dev */}
          {DEV_AUTH_ENABLED ? (devMode ? (
            <View style={styles.devBox}>
              <Text style={styles.devLabel}>TEST ACCOUNT</Text>
              <TextInput
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="you@example.com"
                placeholderTextColor={colors.muted2}
                value={devEmail}
                onChangeText={setDevEmail}
                style={styles.devInput}
              />
              <Pressable
                accessibilityRole="button"
                disabled={isLoading || !devEmail.trim()}
                onPress={() => void handleDevEmailSignIn()}
                style={({ pressed }) => [
                  styles.devPrimaryBtn,
                  (isLoading || !devEmail.trim()) && styles.devPrimaryBtnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.devPrimaryBtnLabel}>
                  {isLoading ? "Working..." : "Continue with test email"}
                </Text>
              </Pressable>
              <Text style={styles.devHint}>
                A new email creates a fresh account; a returning email signs you back in.
              </Text>
            </View>
          ) : (
            <Pressable
              onPress={() => setDevMode(true)}
              hitSlop={8}
              style={styles.devToggle}
            >
              <Text style={styles.devToggleText}>Use a test email instead</Text>
            </Pressable>
          )) : null}
        </View>

        {!appleAvailable && !googleAvailable && !DEV_AUTH_ENABLED ? <Text style={styles.error}>Sign-in is unavailable in this build. Please try reopening the app or contact SeenSnap support.</Text> : null}
        {/* Legal */}
        <Text style={styles.legal}>
          By continuing you agree to SeenSnap's{" "}
          <Text accessibilityRole="link" style={{ textDecorationLine: "underline" }} onPress={() => void Linking.openURL(process.env.EXPO_PUBLIC_TERMS_URL || "https://seensnap.app/terms").catch(() => setError("Couldn't open the terms. Please try again."))}>Terms of Service</Text>
          {" and "}<Text accessibilityRole="link" style={{ textDecorationLine: "underline" }} onPress={() => void Linking.openURL(process.env.EXPO_PUBLIC_PRIVACY_URL || "https://seensnap.app/privacy").catch(() => setError("Couldn't open the privacy policy. Please try again."))}>Privacy Policy</Text>.
        </Text>
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flexGrow: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: 48,
  },
  inner: {
    gap: spacing.xl,
    width: "100%",
    maxWidth: 420,
  },
  header: {
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  logo: {
    alignSelf: "center",
  },
  welcome: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 13,
    letterSpacing: 3,
    color: colors.accent,
    textTransform: "uppercase",
    textAlign: "center",
  },
  actions: {
    gap: spacing.sm,
  },
  error: {
    fontFamily: fonts.sans,
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  appleBtn: {
    width: "100%",
    height: 52,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingVertical: 16,
    alignItems: "center",
  },
  pressed: {
    opacity: 0.88,
  },
  primaryBtnLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.paperInk,
    fontSize: 11,
    letterSpacing: 1.0,
    textTransform: "uppercase",
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.sm,
    paddingVertical: 16,
    alignItems: "center",
  },
  secondaryBtnOffset: {
    marginTop: 2,
  },
  secondaryBtnLabel: {
    fontFamily: fonts.monoSemiBold,
    color: colors.ink,
    fontSize: 11,
    letterSpacing: 1.0,
    textTransform: "uppercase",
  },
  legal: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted2,
    textAlign: "center",
  },
  devToggle: {
    alignSelf: "center",
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  devToggleText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.4,
    color: colors.muted2,
    textDecorationLine: "underline",
  },
  devBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: rules.gold,
    backgroundColor: "rgba(255,230,0,0.04)",
    gap: spacing.sm,
  },
  devLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 9,
    letterSpacing: 1.8,
    color: colors.accent,
  },
  devInput: {
    borderWidth: 1,
    borderColor: rules.default,
    borderRadius: radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    backgroundColor: colors.background,
  },
  devPrimaryBtn: {
    backgroundColor: colors.ink,
    borderRadius: radii.sm,
    paddingVertical: 14,
    alignItems: "center",
  },
  devPrimaryBtnDisabled: {
    opacity: 0.4,
  },
  devPrimaryBtnLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    letterSpacing: 1.0,
    color: colors.background,
    textTransform: "uppercase",
  },
  devHint: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted2,
  },
});
