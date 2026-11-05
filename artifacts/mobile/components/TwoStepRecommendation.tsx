import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { canRequestBusinessDeletion, webAccountSecurityUrl, webSignInSecuritySettingsUrl } from '@/lib/links';

// "Remind me later" hides the prompt for this long, per user on this device.
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const snoozeKey = (userId: number) => `complytrack:two-step-prompt-snoozed:${userId}`;

interface MeTwoStep {
  user?: { totpEnabled?: boolean };
  twoFactorRequired?: boolean;
}

/**
 * Home-screen prompt for anyone signed in without two-step sign-in where their
 * business has not made it required (the web's dashboard prompt). Setup
 * happens on the web, so the buttons open the web pages.
 */
export function TwoStepRecommendation() {
  const colors = useColors();
  const { user, isOffline } = useAuth();
  const [snoozed, setSnoozed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    AsyncStorage.getItem(snoozeKey(user.id))
      .then((value) => { if (!cancelled) setSnoozed(Number(value) > Date.now()); })
      .catch(() => { if (!cancelled) setSnoozed(false); });
    return () => { cancelled = true; };
  }, [user?.id]);

  const me = useQuery<MeTwoStep>({
    queryKey: ['auth-me-two-step', user?.id],
    queryFn: () => apiFetch('/api/auth/me'),
    enabled: !!user && !isOffline && snoozed === false,
  });

  if (!user || snoozed !== false || !me.data) return null;
  if (me.data.user?.totpEnabled !== false || me.data.twoFactorRequired !== false) return null;
  const owner = canRequestBusinessDeletion(user.role);
  const open = (url: string) => { Linking.openURL(url).catch(() => undefined); };
  const remindLater = () => {
    setSnoozed(true);
    AsyncStorage.setItem(snoozeKey(user.id), String(Date.now() + SNOOZE_MS)).catch(() => undefined);
  };

  return (
    <View
      testID="two-step-recommendation"
      style={[styles.panel, { backgroundColor: colors.warning + '14', borderColor: colors.warning + '66' }]}
    >
      <View style={styles.headingRow}>
        <Feather name="shield" size={16} color={colors.warning} />
        <Text style={[styles.heading, { color: colors.foreground }]} accessibilityRole="header">
          We strongly recommend turning on two-step sign-in
        </Text>
      </View>
      <Text style={[styles.meta, { color: colors.mutedForeground }]}>
        ComplyTrack holds sensitive information, such as staff injury and incident records and people's
        personal details. With two-step sign-in, a code from your phone stops anyone who has guessed or
        stolen your password. You set it up on the ComplyTrack website.
      </Text>
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.navy }]}
          onPress={() => open(webAccountSecurityUrl())}
          accessibilityRole="link"
        >
          <Text style={styles.buttonText}>Turn on two-step sign-in</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={remindLater} accessibilityRole="button">
          <Text style={[styles.secondary, { color: colors.mutedForeground }]}>Remind me later</Text>
        </TouchableOpacity>
      </View>
      {owner && (
        <TouchableOpacity onPress={() => open(webSignInSecuritySettingsUrl())} accessibilityRole="link">
          <Text style={[styles.secondary, { color: colors.foreground, textDecorationLine: 'underline' }]}>
            Require it for everyone in your business
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: 8, padding: 12, marginHorizontal: 16, marginTop: 12, gap: 8 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { fontSize: 14, fontFamily: 'Inter_600SemiBold', flex: 1 },
  meta: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginTop: 4 },
  button: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  buttonText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  secondary: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
