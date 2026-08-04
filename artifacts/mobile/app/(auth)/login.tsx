import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const passwordRef = useRef<TextInput>(null);

  async function handleLogin() {
    if (!email.trim() || !password) return;
    setError('');
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Sign-in failed. Please try again.',
      );
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  const disabled = !email.trim() || !password || loading;

  return (
    <View style={[styles.root, { backgroundColor: colors.navy }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          {/* Brand header */}
          <View
            style={[
              styles.header,
              {
                paddingTop:
                  Platform.OS === 'web' ? 80 : insets.top + 48,
              },
            ]}
          >
            <View
              style={[
                styles.shieldWrap,
                { backgroundColor: colors.primary },
              ]}
            >
              <Feather name="shield" size={22} color="#ffffff" />
            </View>
            <Text style={styles.brandName}>ComplyTrack</Text>
            <Text style={styles.tagline}>
              Health &amp; Safety — field edition
            </Text>
          </View>

          {/* White card */}
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.background,
                paddingBottom:
                  Platform.OS === 'web' ? 48 : insets.bottom + 32,
              },
            ]}
          >
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>
              Sign in
            </Text>
            <Text
              style={[styles.cardSub, { color: colors.mutedForeground }]}
            >
              Access your compliance dashboard
            </Text>

            {/* Email */}
            <Text style={[styles.label, { color: colors.foreground }]}>
              Email address
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                  color: colors.foreground,
                },
              ]}
              value={email}
              onChangeText={setEmail}
              placeholder="you@yourcompany.com"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              testID="email-input"
            />

            {/* Password */}
            <Text
              style={[
                styles.label,
                { color: colors.foreground, marginTop: 16 },
              ]}
            >
              Password
            </Text>
            <View
              style={[
                styles.passwordWrap,
                { borderColor: colors.border, backgroundColor: colors.background },
              ]}
            >
              <TextInput
                ref={passwordRef}
                style={[styles.passwordInput, { color: colors.foreground }]}
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry={!showPw}
                autoCapitalize="none"
                returnKeyType="go"
                onSubmitEditing={handleLogin}
                testID="password-input"
              />
              <TouchableOpacity
                style={styles.eyeBtn}
                onPress={() => setShowPw((v) => !v)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather
                  name={showPw ? 'eye-off' : 'eye'}
                  size={18}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
            </View>

            {/* Error */}
            {!!error && (
              <View
                style={[
                  styles.errorBox,
                  { borderLeftColor: colors.destructive },
                ]}
              >
                <Text
                  style={[styles.errorText, { color: colors.destructive }]}
                >
                  {error}
                </Text>
              </View>
            )}

            {/* Submit */}
            <TouchableOpacity
              style={[
                styles.btn,
                { backgroundColor: colors.navy },
                disabled && styles.btnDisabled,
              ]}
              onPress={handleLogin}
              disabled={disabled}
              testID="sign-in-btn"
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.btnText}>Sign in</Text>
              )}
            </TouchableOpacity>

            <Text
              style={[styles.footer, { color: colors.mutedForeground }]}
            >
              ComplyTrack by ALPS Consulting
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 40,
  },
  shieldWrap: {
    width: 52,
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  brandName: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
    letterSpacing: -0.5,
    marginBottom: 6,
  },
  tagline: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.55)',
    fontFamily: 'Inter_400Regular',
  },
  card: {
    flex: 1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 32,
  },
  cardTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  cardSub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    marginBottom: 28,
  },
  label: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    marginBottom: 7,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  passwordWrap: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 4,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  eyeBtn: { paddingHorizontal: 14 },
  errorBox: {
    borderLeftWidth: 3,
    backgroundColor: '#fef2f2',
    padding: 12,
    borderRadius: 4,
    marginTop: 16,
  },
  errorText: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  btn: {
    height: 52,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  btnDisabled: { opacity: 0.55 },
  btnText: {
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  footer: {
    textAlign: 'center',
    marginTop: 24,
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
});
