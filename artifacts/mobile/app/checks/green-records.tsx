/**
 * GreenTrack machine records
 * Opened from the GreenTrack pre-use check screen. Pick a machine, then report
 * a defect, log fuel / oil, or (managers) log a service or a PUWER inspection,
 * and see the machine's recent records. Machines, edits, defect status changes
 * and deletes stay on the website. Gated behind hasService("greentrack").
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { AquaEmptyState } from '@/components/aqua-track-ui';
import { GreenRecordPanel } from '@/components/GreenRecordPanel';
import {
  canRecordGreenTab,
  normalizeGreenMachines,
  type GreenMachineOption,
  type GreenRecordTab,
} from '@/components/green-records-logic';

const MODULE_COLOR = '#6f8750';

const TABS: { key: GreenRecordTab; label: string; icon: React.ComponentProps<typeof Feather>['name'] }[] = [
  { key: 'defect', label: 'Defects', icon: 'alert-triangle' },
  { key: 'fuel', label: 'Fuel / oil', icon: 'droplet' },
  { key: 'service', label: 'Service', icon: 'settings' },
  { key: 'puwer', label: 'PUWER', icon: 'clipboard' },
];

export default function GreenRecordsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, hasService } = useAuth();
  const serviceEnabled = hasService('greentrack');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const role = user?.role ?? null;
  const isViewer = role === 'client_viewer';
  // Service records and PUWER inspections are manager records (the API only
  // accepts them from admins); staff see defect reports and fuel logs.
  const tabs = TABS.filter((tab) => isViewer || canRecordGreenTab(role, tab.key));
  const [activeTab, setActiveTab] = useState<GreenRecordTab>('defect');
  const [machineId, setMachineId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const machinesQuery = useQuery<GreenMachineOption[]>({
    queryKey: ['green-records-machines', user?.clientId],
    queryFn: async () => normalizeGreenMachines(await apiFetch('/api/green-track/machines')),
    enabled: serviceEnabled,
  });
  const machines = machinesQuery.data ?? [];

  useEffect(() => {
    if (!machinesQuery.data) return;
    if (machinesQuery.data.length === 1 && machineId !== machinesQuery.data[0].id) {
      setMachineId(machinesQuery.data[0].id);
    } else if (machineId !== null && !machinesQuery.data.some((machine) => machine.id === machineId)) {
      setMachineId(null);
    }
  }, [machineId, machinesQuery.data]);

  const machine = machines.find((item) => item.id === machineId) ?? null;

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['green-records-machines'] }),
        queryClient.invalidateQueries({ queryKey: ['green-records'] }),
        queryClient.invalidateQueries({ queryKey: ['photo-requirements'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  if (!serviceEnabled) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>GreenTrack</Text>
        <Text style={[styles.gatedText, { color: colors.mutedForeground }]}>
          GreenTrack is not enabled on your account. Contact your administrator to activate this module.
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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={MODULE_COLOR} />}
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" testID="green-records-back">
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={[styles.moduleBadge, { backgroundColor: MODULE_COLOR + '55' }]}>
              <Feather name="tool" size={14} color="#d9e8c6" />
              <Text style={[styles.moduleBadgeText, { color: '#d9e8c6' }]}>GreenTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Machine records</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>
      </View>

      {machinesQuery.isLoading ? (
        <ActivityIndicator color={MODULE_COLOR} style={{ marginTop: 16 }} />
      ) : machinesQuery.isError ? (
        <View style={styles.machineSection}>
          <AquaEmptyState
            colors={colors}
            error
            message={machinesQuery.error instanceof Error ? machinesQuery.error.message : 'Equipment could not be loaded.'}
          >
            <TouchableOpacity onPress={() => void machinesQuery.refetch()}>
              <Text style={{ color: colors.primary }}>Retry loading equipment</Text>
            </TouchableOpacity>
          </AquaEmptyState>
        </View>
      ) : machines.length ? (
        <View style={styles.machineSection}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Machine</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={styles.chipRow}>
              {machines.map((item) => {
                const selected = machineId === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[
                      styles.chip,
                      { borderColor: selected ? MODULE_COLOR : colors.border, backgroundColor: selected ? MODULE_COLOR + '1a' : colors.card },
                      formOpen && styles.disabled,
                    ]}
                    onPress={() => setMachineId(selected ? null : item.id)}
                    disabled={formOpen}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    testID={`green-records-machine-${item.id}`}
                  >
                    <Text style={[styles.chipText, { color: selected ? MODULE_COLOR : colors.mutedForeground }]}>{item.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          {!machine && (
            <Text style={[styles.chipText, { color: colors.mutedForeground }]}>
              Choose a machine to add a record. Recent records for every machine are shown below.
            </Text>
          )}
        </View>
      ) : (
        <View style={styles.machineSection}>
          <AquaEmptyState colors={colors} message="No equipment listed. Ask a manager to add machines on the website." />
        </View>
      )}

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {tabs.map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tabButton, selected && { borderBottomColor: MODULE_COLOR }, formOpen && styles.disabled]}
              onPress={() => setActiveTab(tab.key)}
              disabled={formOpen}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              testID={`green-records-tab-${tab.key}`}
            >
              <Feather name={tab.icon} size={15} color={selected ? MODULE_COLOR : colors.mutedForeground} />
              <Text style={[styles.tabLabel, { color: selected ? MODULE_COLOR : colors.mutedForeground }]} numberOfLines={1}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.content}>
        <GreenRecordPanel
          key={activeTab}
          tab={activeTab}
          machine={machine}
          machines={machines}
          canRecord={canRecordGreenTab(role, activeTab)}
          onSelectMachine={setMachineId}
          onFormOpenChange={setFormOpen}
        />
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          {isViewer
            ? 'Your account is read-only.'
            : 'Add or edit machines, update or close defects and edit records on the website.'}
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
  machineSection: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  sectionTitle: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  disabled: { opacity: 0.5 },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, marginTop: 16, marginHorizontal: 16 },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  hint: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 16, lineHeight: 16 },
});
