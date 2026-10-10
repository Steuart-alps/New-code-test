import React, { useMemo, useRef, useState } from 'react';
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
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { isInvalidMobileLoginChallenge } from '@/lib/api';
import {
  defaultWebPasskeySetupUrl,
  nativePasskeysAvailable,
  PasskeyFlowError,
} from '@/lib/passkeys';
import { passkeyFailureNeedsSetup } from '@/lib/passkeyErrors';

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login, loginWithPasskey } = useAuth();
  const passkeysAvailable = useMemo(() => nativePasskeysAvailable(), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [usingRecoveryCode, setUsingRecoveryCode] = useState(false);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  // Which first factor produced pendingToken. After a passkey there is no
  // email or password on screen, only the authenticator-code step.
  const [pendingVia, setPendingVia] = useState<'password' | 'passkey' | null>(null);
  // Shown when the phone had no passkey to offer: how to add one.
  const [passkeyHelp, setPasskeyHelp] = useState<{ webSetupUrl: string | null } | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);

  const viaPasskey = pendingVia === 'passkey';

  function restartLogin() {
    setPendingToken(null);
    setPendingVia(null);
    setCode('');
    setUsingRecoveryCode(false);
  }

  async function handleLogin() {
    if (!viaPasskey && (!email.trim() || !password)) return;
    if (pendingToken && !code.trim()) return;
    setError('');
    setPasskeyHelp(null);
    setLoading(true);
    try {
      const result = await login(
        email.trim().toLowerCase(),
        password,
        pendingToken ?? undefined,
        pendingToken ? code.trim() : undefined,
      );
      if (result.pendingToken) {
        setPendingToken(result.pendingToken);
        setPendingVia('password');
        setLoading(false);
        setTimeout(() => codeRef.current?.focus(), 100);
        return;
      }
      if (result.requires2faSetup) {
        setSetupUrl(result.setupUrl ?? null);
        setLoading(false);
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Sign-in failed. Please try again.';
      if (isInvalidMobileLoginChallenge(err)) {
        restartLogin();
      }
      setError(
        message,
      );
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  async function handlePasskey() {
    setError('');
    setPasskeyHelp(null);
    setLoading(true);
    try {
      const result = await loginWithPasskey();
      if (result.pendingToken) {
        setPendingToken(result.pendingToken);
        setPendingVia('passkey');
        setCode('');
        setUsingRecoveryCode(false);
        setTimeout(() => codeRef.current?.focus(), 100);
        return;
      }
      if (result.requires2faSetup) {
        setSetupUrl(result.setupUrl ?? null);
      }
    } catch (err: unknown) {
      if (err instanceof PasskeyFlowError) {
        if (passkeyFailureNeedsSetup(err.reason)) {
          setPasskeyHelp({ webSetupUrl: err.webSetupUrl ?? defaultWebPasskeySetupUrl() });
          if (err.reason !== 'cancelled') setError(err.message);
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : 'Passkey sign-in failed. Please try again.');
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  const disabled =
    loading
    || (pendingToken !== null ? !code.trim() : !email.trim() || !password);

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
               {setupUrl ? 'Set up two-factor authentication' : 'Sign in'}
             </Text>
             <Text
              style={[styles.cardSub, { color: colors.mutedForeground }]}
            >
               {setupUrl
                 ? 'Your ComplyTrack account requires two-factor authentication. Set it up in the web dashboard, then return here to sign in.'
                 : 'Access your compliance dashboard'}
            </Text>
             {setupUrl && (
               <TouchableOpacity
                 style={[styles.primaryButton, { backgroundColor: colors.primary }]}
                 onPress={() => Linking.openURL(setupUrl).catch(() => undefined)}
               >
                 <Text style={styles.primaryButtonText}>Open web setup</Text>
               </TouchableOpacity>
             )}

             {!setupUrl && <>
            {viaPasskey && (
              <View style={styles.passkeyConfirmed} testID="passkey-confirmed">
                <Feather name="check-circle" size={16} color={colors.primary} />
                <Text style={[styles.passkeyConfirmedText, { color: colors.foreground }]}>
                  Passkey accepted. Enter your authenticator code to finish signing in.
                </Text>
              </View>
            )}
            {!viaPasskey && <>{/* Email */}
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
              editable={!pendingToken}
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
                editable={!pendingToken}
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
            </>}

             {/* 2FA code */}
             {pendingToken && (
              <>
                <Text
                  style={[
                    styles.label,
                    { color: colors.foreground, marginTop: viaPasskey ? 0 : 16 },
                  ]}
                >
                  {usingRecoveryCode ? 'Recovery code' : 'Verification code'}
                </Text>
                <TextInput
                  ref={codeRef}
                  style={[
                    styles.input,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                      color: colors.foreground,
                    },
                  ]}
                  value={code}
                  onChangeText={(value) => setCode(
                    usingRecoveryCode
                      ? value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 14)
                      : value.replace(/\D/g, '').slice(0, 6),
              )}
                  placeholder={usingRecoveryCode ? 'XXXX-XXXX-XXXX' : '6-digit authenticator code'}
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType={usingRecoveryCode ? 'default' : 'number-pad'}
                  autoCapitalize={usingRecoveryCode ? 'characters' : 'none'}
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={handleLogin}
                  testID="totp-input"
                />
                <Text
                  style={[styles.cardSub, { color: colors.mutedForeground, marginTop: 6, marginBottom: 0 }]}
                >
                   {usingRecoveryCode
                     ? 'Enter one of the recovery codes you saved when you enabled two-factor authentication.'
                     : 'Two-factor authentication is enabled on this account. Enter the code from your authenticator app.'}
                </Text>
                 <TouchableOpacity
                   onPress={() => {
                     setUsingRecoveryCode((value) => !value);
                     setCode('');
                     setError('');
                     setTimeout(() => codeRef.current?.focus(), 50);
                   }}
                   style={{ marginTop: 10 }}
                 >
                   <Text style={{ color: colors.primary, fontWeight: '600' }}>
                     {usingRecoveryCode ? 'Use authenticator code' : 'Use a recovery code'}
                   </Text>
                 </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      const focusPassword = !viaPasskey;
                      restartLogin();
                      setError('');
                      if (focusPassword) setTimeout(() => passwordRef.current?.focus(), 50);
                    }}
                    style={{ marginTop: 10 }}
                    testID="restart-login-btn"
                  >
                    <Text style={{ color: colors.mutedForeground, fontWeight: '600' }}>
                      Sign in again
                    </Text>
                  </TouchableOpacity>
              </>
            )}

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

            {passkeysAvailable && !pendingToken && (
              <TouchableOpacity
                style={[
                  styles.passkeyBtn,
                  { borderColor: colors.navy },
                  loading && styles.btnDisabled,
                ]}
                onPress={handlePasskey}
                disabled={loading}
                testID="passkey-sign-in-btn"
              >
                <Feather name="key" size={18} color={colors.navy} />
                <Text style={[styles.passkeyBtnText, { color: colors.navy }]}>
                  Sign in with a passkey
                </Text>
              </TouchableOpacity>
            )}

            {passkeyHelp && !pendingToken && (
              <View
                style={[styles.helpBox, { borderColor: colors.border }]}
                testID="passkey-help"
              >
                <Text style={[styles.helpTitle, { color: colors.foreground }]}>
                  No passkey on this phone?
                </Text>
                <Text style={[styles.helpText, { color: colors.mutedForeground }]}>
                  Sign in with your email and password, then add a passkey from the Profile
                  tab. Or open ComplyTrack Settings in this phone&apos;s browser and add one
                  there: it is saved to your phone&apos;s password manager and works in this
                  app too. You will still enter your authenticator code each time.
                </Text>
                {passkeyHelp.webSetupUrl && (
                  <TouchableOpacity
                    onPress={() => Linking.openURL(passkeyHelp.webSetupUrl!).catch(() => undefined)}
                    style={{ marginTop: 10 }}
                    testID="passkey-web-setup-btn"
                  >
                    <Text style={{ color: colors.primary, fontWeight: '600' }}>
                      Add a passkey on the web
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            <Text
              style={[styles.footer, { color: colors.mutedForeground }]}
            >
              ComplyTrack by ALPS Consulting
            </Text>
             </>}
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
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    marginBottom: 24,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
  },
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
  passkeyBtn: {
    height: 52,
    borderRadius: 4,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 12,
  },
  passkeyBtnText: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  passkeyConfirmed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  passkeyConfirmedText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  helpBox: {
    borderWidth: 1,
    borderRadius: 4,
    padding: 14,
    marginTop: 16,
  },
  helpTitle: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 6,
  },
  helpText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'Inter_400Regular',
  },
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
