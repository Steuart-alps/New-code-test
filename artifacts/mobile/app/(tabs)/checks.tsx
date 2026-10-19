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
import { useAuth } from '@/lib/auth';
import { aquaTrackAccess } from '@/components/aqua-track-logic';
import { MANAGE_ITEMS, visibleManageItems } from '@/components/manage-items';

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
    id: 'daily',
    label: 'DailyTrack',
    subtitle: 'AM / PM opening and closing checks',
    icon: 'clipboard',
    iconColor: '#14b8a6',
    checks: ['Morning checklist', 'Evening checklist'],
  },
  {
    id: 'fire',
    label: 'FireTrack',
    subtitle: 'Fire safety logbook',
    icon: 'alert-triangle',
    iconColor: '#f97316',
    checks: [
      'Weekly alarm test',
      'Monthly lighting flick test',
      'Extinguisher check',
      'Fire doors',
      'Fire drill (with night staff)',
      'Alarm, extinguisher and lighting services',
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
    id: 'hot-tub',
    label: 'HotTubTrack',
    subtitle: 'Hot-tub water safety checks',
    icon: 'droplet',
    iconColor: '#06b6d4',
    checks: ['Water chemistry', 'Temperature', 'Cover inspection'],
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
    checks: ['Daily, weekly and monthly schedules'],
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
  {
    id: 'pest',
    label: 'PestTrack',
    subtitle: 'Pest activity & contractor visits',
    icon: 'crosshair',
    iconColor: '#b45309',
    checks: ['Pick site', 'Log a sighting', 'Contractor visit', 'Recent activity'],
  },
  {
    id: 'bike',
    label: 'BikeTrack',
    subtitle: 'Bike hire, safety checks & services',
    icon: 'navigation',
    iconColor: '#0d9488',
    checks: ['Pick site', 'Fleet status', 'Hire with pre-ride check', 'Return', 'Log a service'],
  },
  {
    id: 'green',
    label: 'GreenTrack',
    subtitle: 'Pre-use checks, defects & fuel logs',
    icon: 'tool',
    iconColor: '#6f8750',
    checks: ['Choose machine', 'Check safety points', 'Sign off', 'Report defects & log fuel'],
  },
  {
    id: 'tree',
    label: 'TreeTrack',
    subtitle: 'Tree inspection logbook',
    icon: 'feather',
    iconColor: '#16a34a',
    checks: ['Choose site', 'Record inspection', "What's due", 'Recent inspections'],
  },
  {
    id: 'room',
    label: 'RoomTrack',
    subtitle: 'Daily room housekeeping checks',
    icon: 'home',
    iconColor: '#0284c7',
    checks: ['Pick site', 'Clean / tidy / to standard', 'Notes', 'Recent checks'],
  },
  {
    id: 'aqua',
    label: 'AquaTrack',
    subtitle: 'Pool checks, sessions, surveillance, first aid & incidents',
    icon: 'droplet',
    iconColor: '#0ea5e9',
    checks: ['Pool water quality', 'Swim sessions', 'Lifeguard surveillance', 'First-aid kit', 'Incidents'],
  },
  {
    id: 'premises',
    label: 'PremisesTrack',
    subtitle: 'Premises inspections',
    icon: 'home',
    iconColor: '#64748b',
    checks: ['Pick site', 'Findings & hazards', 'Action required / taken', 'Next inspection due'],
  },
  {
    id: 'safe-track',
    label: 'SafeTrack',
    subtitle: 'Risk assessments & safety documents',
    icon: 'shield',
    iconColor: '#6366f1',
    checks: ['Risk assessments', 'SOPs', 'Staff handbook', 'Acknowledge required reading'],
  },
];

export default function ChecksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, hasService } = useAuth();
  const manageCount = visibleManageItems(MANAGE_ITEMS, user?.role, hasService).length;
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const aquaAccess = aquaTrackAccess(hasService);
  const visibleModules = MODULES.filter(
    (mod) =>
      (mod.id !== 'incident' || hasService('incidenttrack')) &&
      (mod.id !== 'pat' || hasService('pattrack')) &&
      (mod.id !== 'pest' || hasService('pesttrack')) &&
      (mod.id !== 'bike' || hasService('biketrack')) &&
      (mod.id !== 'green' || hasService('greentrack')) &&
      (mod.id !== 'premises' || hasService('premisestrack')) &&
      (mod.id !== 'tree' || hasService('treetrack')) &&
      (mod.id !== 'room' || hasService('roomtrack')) &&
      (mod.id !== 'aqua' || aquaAccess.any),
  );

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
        {manageCount > 0 ? (
          <TouchableOpacity
            testID="checks-manage"
            accessibilityRole="button"
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'center' }]}
            onPress={() => router.push('/manage' as any)}
            activeOpacity={0.75}
          >
            <View style={[styles.iconWrap, { backgroundColor: colors.navy + '1a' }]}>
              <Feather name="briefcase" size={24} color={colors.navy} />
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Manage and look up</Text>
              <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>Actions, certificates, tasks, registers and training</Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        ) : null}
        {visibleModules.map((mod) => (
          <TouchableOpacity
            key={mod.id}
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => {
              if (mod.id === 'daily') {
                router.push('/checks/daily' as any);
              } else if (mod.id === 'kitchen') {
                router.push('/checks/kitchen' as any);
              } else if (mod.id === 'aqua') {
                router.push('/checks/aqua' as any);
              } else if (mod.id === 'incident') {
                router.push('/checks/incident' as any);
              } else if (mod.id === 'pat') {
                router.push('/checks/pat' as any);
              } else if (mod.id === 'cleaning') {
                router.push('/checks/cleaning' as any);
              } else if (mod.id === 'green') {
                router.push('/checks/green' as any);
              } else if (mod.id === 'safe-track') {
                router.push('/checks/safe-track' as any);
              } else if (mod.id === 'hot-tub') {
                router.push('/checks/hot-tub' as any);
              } else {
                router.push(`/checks/${mod.id}` as any);
              }
            }}
            activeOpacity={0.75}
            testID={`checks-module-${mod.id}`}
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
