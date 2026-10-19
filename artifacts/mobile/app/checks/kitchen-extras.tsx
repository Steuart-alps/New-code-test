/**
 * KitchenTrack probe calibration and weekly management review, opened from
 * the Kitchen screen. Submits signed records through the device outbox;
 * drafts, edits and settings stay on the website. Gated behind
 * hasService("kitchentrack") like the Kitchen screen.
 */
import React, { useState } from 'react';
import { Platform, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { KitchenProbeCheck } from '@/components/KitchenProbeCheck';
import { KitchenWeeklyReview } from '@/components/KitchenWeeklyReview';

type ActiveTab = 'probe' | 'weekly';

export default function KitchenExtrasScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ tab?: string }>();
  const { hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [activeTab, setActiveTab] = useState<ActiveTab>(params.tab === 'weekly' ? 'weekly' : 'probe');
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['kitchen-probe-checks'] }),
        queryClient.invalidateQueries({ queryKey: ['kitchen-probe-config'] }),
        queryClient.invalidateQueries({ queryKey: ['kitchen-weekly-reviews'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  if (!hasService('kitchentrack')) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>KitchenTrack</Text>
        <Text style={[styles.gatedText, { color: colors.mutedForeground }]}>
          KitchenTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 40 }}
      bottomOffset={20}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: '#eab30833' }]}>
              <Feather name="thermometer" size={14} color="#facc15" />
              <Text style={[styles.moduleBadgeText, { color: '#facc15' }]}>KitchenTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Probe & weekly checks</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {([
          { key: 'probe' as const, label: 'Probe calibration', icon: 'thermometer' as const },
          { key: 'weekly' as const, label: 'Weekly review', icon: 'clipboard' as const },
        ]).map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tabButton, activeTab === tab.key && { borderBottomColor: colors.primary }]}
            onPress={() => setActiveTab(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.key }}
            testID={`kitchen-extras-tab-${tab.key}`}
          >
            <Feather name={tab.icon} size={16} color={activeTab === tab.key ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.tabLabel, { color: activeTab === tab.key ? colors.primary : colors.mutedForeground }]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Both stay mounted so switching tabs keeps what has been typed. */}
      <View style={styles.content}>
        <View style={activeTab === 'probe' ? undefined : styles.hidden}><KitchenProbeCheck /></View>
        <View style={activeTab === 'weekly' ? undefined : styles.hidden}><KitchenWeeklyReview /></View>
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          These are whole-business records, as on the website. Save drafts, edit submitted records and change probe names on the website.
        </Text>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  gated: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  gatedTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  gatedText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCenter: { alignItems: 'center', gap: 6 },
  moduleBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  moduleBadgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, marginTop: 8, marginHorizontal: 16 },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabLabel: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  hidden: { display: 'none' },
  hint: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 16, lineHeight: 16 },
});
