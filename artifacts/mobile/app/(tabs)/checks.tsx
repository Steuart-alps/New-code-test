import React from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';

interface CheckModule {
  id: string;
  label: string;
  subtitle: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  iconColor: string;
  checks: string[];
}

const MODULES: CheckModule[] = [
  {
    id: 'fire',
    label: 'FireTrack',
    subtitle: 'Fire safety logbook',
    icon: 'alert-triangle',
    iconColor: '#f97316',
    checks: [
      'Alarm test',
      'Emergency lights',
      'Extinguisher check',
      'Fire doors',
      'Fire drill',
    ],
  },
  {
    id: 'water',
    label: 'LegionellaTrack',
    subtitle: 'Water safety (L8 / HSG274)',
    icon: 'droplet',
    iconColor: '#0ea5e9',
    checks: [
      'Cold water temperature',
      'Hot water temperature',
      'Sentinel outlet flush',
      'Shower head clean',
      'Tank inspection',
    ],
  },
  {
    id: 'kitchen',
    label: 'KitchenTrack',
    subtitle: 'Food safety diary',
    icon: 'thermometer',
    iconColor: '#eab308',
    checks: ['Temperature log', 'Delivery check', 'Corrective actions'],
  },
  {
    id: 'cleaning',
    label: 'Cleaning',
    subtitle: 'Kitchen cleaning schedule',
    icon: 'check-circle',
    iconColor: '#14b8a6',
    checks: ['Tick off today\u2019s cleaning tasks'],
  },
  {
    id: 'incident',
    label: 'IncidentTrack',
    subtitle: 'Accident & incident log',
    icon: 'alert-octagon',
    iconColor: '#ef4444',
    checks: [
      'Accident',
      'Near miss',
      'Dangerous occurrence',
      'RIDDOR reportable',
    ],
  },
  {
    id: 'pat',
    label: 'PATtrack',
    subtitle: 'Portable appliance testing',
    icon: 'zap',
    iconColor: '#6366f1',
    checks: ['Pick appliance', 'Pass / fail', 'Test date', 'Notes'],
  },
];

export default function ChecksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingBottom: Platform.OS === 'web' ? 34 : 24,
      }}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: colors.navy, paddingTop: topPad + 16 },
        ]}
      >
        <Text style={styles.headerTitle}>Compliance Checks</Text>
        <Text style={styles.headerSub}>Select a module to log a check</Text>
      </View>

      <View style={styles.content}>
        {MODULES.map((mod) => (
          <TouchableOpacity
            key={mod.id}
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => router.push(`/checks/${mod.id}` as any)}
            activeOpacity={0.75}
          >
            <View
              style={[
                styles.iconWrap,
                { backgroundColor: mod.iconColor + '1a' },
              ]}
            >
              <Feather name={mod.icon} size={24} color={mod.iconColor} />
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                {mod.label}
              </Text>
              <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>
                {mod.subtitle}
              </Text>
              <View style={styles.checksList}>
                {mod.checks.map((c) => (
                  <View key={c} style={styles.checkItem}>
                    <View
                      style={[
                        styles.checkDot,
                        { backgroundColor: mod.iconColor },
                      ]}
                    />
                    <Text
                      style={[styles.checkText, { color: colors.mutedForeground }]}
                    >
                      {c}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
            <Feather
              name="chevron-right"
              size={20}
              color={colors.mutedForeground}
            />
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  headerTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
    marginBottom: 4,
  },
  headerSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    fontFamily: 'Inter_400Regular',
  },
  content: { padding: 16, gap: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 14,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardBody: { flex: 1 },
  cardTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 2,
  },
  cardSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginBottom: 10,
  },
  checksList: { gap: 4 },
  checkItem: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  checkDot: { width: 5, height: 5, borderRadius: 3 },
  checkText: { fontSize: 12, fontFamily: 'Inter_400Regular' },
});
