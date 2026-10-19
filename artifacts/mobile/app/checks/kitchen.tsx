import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { KitchenTemperatureForm } from '@/components/KitchenTemperatureForm';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';

export default function KitchenCheckScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  if (!hasService('kitchentrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.title, { color: colors.foreground }]}>KitchenTrack</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          KitchenTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="arrow-left" size={22} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>KitchenTrack</Text>
        <View style={{ width: 22 }} />
      </View>
      {/* Probe calibration and the weekly review live on their own screen. */}
      <TouchableOpacity
        style={[styles.link, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={() => router.push('/checks/kitchen-extras' as any)}
        accessibilityRole="button"
        testID="kitchen-open-extras"
      >
        <Feather name="clipboard" size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.linkTitle, { color: colors.foreground }]}>Probe calibration & weekly review</Text>
          <Text style={[styles.linkSub, { color: colors.mutedForeground }]}>Monthly probe checks and the manager’s weekly review</Text>
        </View>
        <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
      </TouchableOpacity>
      <KitchenTemperatureForm />
    </View>
  );
}

const styles = StyleSheet.create({
  gated: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  linkTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  linkSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
});
