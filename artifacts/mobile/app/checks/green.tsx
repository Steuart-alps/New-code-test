/**
 * GreenTrack
 * A quick pre-use safety check for grounds and maintenance equipment.
 *
 * Checklist definitions intentionally live on the mobile screen: they are
 * short, practical prompts that remain available even when the machine API
 * only returns the site's equipment register.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { RequiredPhotoEvidence } from '@/components/RequiredPhotoEvidence';
import { useStagedPhotoEvidence } from '@/hooks/useStagedPhotoEvidence';

const MODULE_COLOR = '#6f8750';
const MODULE_LIGHT = '#e6efdc';
const INK = '#26362c';

type MachineType =
  | 'aerator'
  | 'atv_quad'
  | 'blower'
  | 'chainsaw'
  | 'tractor'
  | 'fairway_mower'
  | 'ride_on_cylinder'
  | 'ride_on'
  | 'pedestrian'
  | 'walk_behind'
  | 'ride_on_rotary'
  | 'hedge_trimmer'
  | 'sprayer_spreader'
  | 'edger_strimmer'
  | 'topdresser'
  | 'utility_vehicle'
  | 'other';

type ItemStatus = 'ok' | 'fail' | 'na' | null;

interface Machine {
  id: number;
  name: string;
  machineType: MachineType;
  assetTag: string | null;
  location: string | null;
  active: boolean;
  operatorRosterId: number | null;
}

interface ChecklistDefinition {
  key: string;
  label: string;
  section: string;
}

interface ChecklistItem extends ChecklistDefinition {
  status: ItemStatus;
  note?: string;
}

interface GreenCheck {
  id: number;
  machineName: string | null;
  machineType: string | null;
  checkDate: string;
  operator: string | null;
  result: 'pass' | 'fail' | string;
  defectNoted?: boolean;
  submittedAt?: string | null;
}

interface GreenCheckPayload {
  machineId: number;
  checkDate: string;
  operator: string;
  operatorRosterId: number | null;
  checklistItems: Array<{
    key: string;
    label: string;
    section: string;
    status: Exclude<ItemStatus, null>;
    note?: string;
  }>;
  fuelLevel: string | null;
  notes: string;
  defectNoted: boolean;
  result: 'pass' | 'fail';
  photoUploadIds?: string[];
}

const MACHINE_LABELS: Record<MachineType, string> = {
  aerator: 'Aerator',
  atv_quad: 'ATV / quad',
  blower: 'Blower',
  chainsaw: 'Chainsaw',
  tractor: 'Tractor',
  fairway_mower: 'Fairway mower',
  ride_on_cylinder: 'Ride-on cylinder mower',
  ride_on: 'Ride-on equipment',
  pedestrian: 'Pedestrian equipment',
  walk_behind: 'Walk-behind mower',
  ride_on_rotary: 'Ride-on rotary mower',
  hedge_trimmer: 'Hedge trimmer',
  sprayer_spreader: 'Sprayer / spreader',
  edger_strimmer: 'Edger / strimmer',
  topdresser: 'Topdresser',
  utility_vehicle: 'Utility vehicle',
  other: 'Other equipment',
};

const DEFINITIONS: Record<MachineType, ChecklistDefinition[]> = {
  aerator: [
    { key: 'guards', label: 'Guards and covers are fitted and secure', section: 'Protective equipment' },
    { key: 'tines', label: 'Tines are secure, clear and undamaged', section: 'Working parts' },
    { key: 'controls', label: 'Controls, clutch and emergency stop operate correctly', section: 'Controls' },
    { key: 'leaks', label: 'No fuel, oil or hydraulic leaks visible', section: 'Condition' },
    { key: 'area', label: 'Work area checked for people, debris and buried hazards', section: 'Before starting' },
  ],
  atv_quad: [
    { key: 'tyres', label: 'Tyres, wheels and wheel nuts are secure', section: 'Condition' },
    { key: 'brakes', label: 'Brakes and parking brake operate correctly', section: 'Controls' },
    { key: 'steering', label: 'Steering, throttle and engine stop operate correctly', section: 'Controls' },
    { key: 'rops', label: 'Roll-over protection and seat belt are in place', section: 'Protective equipment' },
    { key: 'lights', label: 'Lights, horn and beacon work where fitted', section: 'Visibility' },
  ],
  blower: [
    { key: 'tube', label: 'Blower tube and nozzle are secure and clear', section: 'Working parts' },
    { key: 'guard', label: 'Fan guard and casing are intact', section: 'Protective equipment' },
    { key: 'controls', label: 'Throttle, trigger lock and stop switch operate correctly', section: 'Controls' },
    { key: 'harness', label: 'Harness or carrying strap is adjusted and sound', section: 'Operator setup' },
    { key: 'debris', label: 'Area checked before blowing; no people or loose objects nearby', section: 'Before starting' },
  ],
  chainsaw: [
    { key: 'chain', label: 'Chain is sharp, tensioned and lubricated', section: 'Working parts' },
    { key: 'brake', label: 'Chain brake and stop switch operate correctly', section: 'Controls' },
    { key: 'guards', label: 'Front hand guard, rear handle and chain catcher are sound', section: 'Protective equipment' },
    { key: 'bar', label: 'Guide bar is straight and secure', section: 'Working parts' },
    { key: 'area', label: 'Felling zone, escape route and overhead hazards checked', section: 'Before starting' },
  ],
  tractor: [
    { key: 'tyres', label: 'Tyres, wheels and wheel nuts are secure', section: 'Condition' },
    { key: 'brakes', label: 'Service brake and parking brake operate correctly', section: 'Controls' },
    { key: 'lights', label: 'Lights, beacon, horn and reversing alarm work where fitted', section: 'Visibility' },
    { key: 'hitch', label: 'PTO, linkage and attachment are secure', section: 'Attachments' },
    { key: 'leaks', label: 'No fuel, oil or hydraulic leaks visible', section: 'Condition' },
  ],
  fairway_mower: [
    { key: 'units', label: 'Cutting units, cylinders and bedknives are secure', section: 'Working parts' },
    { key: 'guards', label: 'Guards and shields are fitted and secure', section: 'Protective equipment' },
    { key: 'brakes', label: 'Brakes and parking brake operate correctly', section: 'Controls' },
    { key: 'steering', label: 'Steering, lift controls and emergency stop operate correctly', section: 'Controls' },
    { key: 'leaks', label: 'No fuel, oil or hydraulic leaks visible', section: 'Condition' },
  ],
  ride_on_cylinder: [
    { key: 'units', label: 'Cutting units, cylinders and bedknives are secure', section: 'Working parts' },
    { key: 'guards', label: 'Guards and discharge protection are fitted', section: 'Protective equipment' },
    { key: 'brakes', label: 'Brakes and parking brake operate correctly', section: 'Controls' },
    { key: 'controls', label: 'Operator controls and emergency stop operate correctly', section: 'Controls' },
    { key: 'leaks', label: 'No fuel, oil or hydraulic leaks visible', section: 'Condition' },
  ],
  ride_on: [
    { key: 'guards', label: 'Guards and covers are fitted and secure', section: 'Protective equipment' },
    { key: 'blades', label: 'Blades, cylinders or cutting units are secure', section: 'Working parts' },
    { key: 'brakes', label: 'Brakes and parking brake operate correctly', section: 'Controls' },
    { key: 'controls', label: 'Operator controls and emergency stop operate correctly', section: 'Controls' },
    { key: 'leaks', label: 'No fuel, oil or hydraulic leaks visible', section: 'Condition' },
  ],
  pedestrian: [
    { key: 'working_parts', label: 'Blade, cylinder or working parts are secure', section: 'Working parts' },
    { key: 'guards', label: 'Guards, discharge flap and handles are sound', section: 'Protective equipment' },
    { key: 'controls', label: 'Dead-man control and stop switch operate correctly', section: 'Controls' },
    { key: 'condition', label: 'Wheels, casing and height adjustment are secure', section: 'Condition' },
    { key: 'area', label: 'Area checked for people, debris and hidden hazards', section: 'Before starting' },
  ],
  walk_behind: [
    { key: 'blade', label: 'Blade, cylinder or cutting deck is secure and undamaged', section: 'Working parts' },
    { key: 'guards', label: 'Guards, discharge flap and handles are sound', section: 'Protective equipment' },
    { key: 'controls', label: 'Dead-man control and stop switch operate correctly', section: 'Controls' },
    { key: 'wheels', label: 'Wheels and height adjustment are secure', section: 'Condition' },
    { key: 'area', label: 'Area checked for people, debris and hidden hazards', section: 'Before starting' },
  ],
  ride_on_rotary: [
    { key: 'blade', label: 'Blades and spindle assemblies are secure', section: 'Working parts' },
    { key: 'guards', label: 'Guards and discharge protection are fitted', section: 'Protective equipment' },
    { key: 'brakes', label: 'Brakes and parking brake operate correctly', section: 'Controls' },
    { key: 'controls', label: 'Controls and emergency stop operate correctly', section: 'Controls' },
    { key: 'leaks', label: 'No fuel, oil or hydraulic leaks visible', section: 'Condition' },
  ],
  hedge_trimmer: [
    { key: 'blades', label: 'Blades are sharp, secure and undamaged', section: 'Working parts' },
    { key: 'guard', label: 'Blade guard and hand guard are fitted', section: 'Protective equipment' },
    { key: 'controls', label: 'Throttle, trigger lock and stop switch operate correctly', section: 'Controls' },
    { key: 'harness', label: 'Harness or carrying strap is adjusted and sound', section: 'Operator setup' },
    { key: 'area', label: 'Work area checked for people, overhead and hidden hazards', section: 'Before starting' },
  ],
  sprayer_spreader: [
    { key: 'tank', label: 'Tank, lid and hoses are secure with no leaks', section: 'Condition' },
    { key: 'nozzles', label: 'Nozzles, spreader plates and guards are clear', section: 'Working parts' },
    { key: 'controls', label: 'Pump, pressure controls and emergency stop operate correctly', section: 'Controls' },
    { key: 'labels', label: 'Product label, calibration and application area checked', section: 'Before starting' },
    { key: 'ppe', label: 'Required PPE is available and suitable for the product', section: 'Operator setup' },
  ],
  edger_strimmer: [
    { key: 'head', label: 'Cutting head, blade or line is secure and undamaged', section: 'Working parts' },
    { key: 'guard', label: 'Debris guard is fitted and secure', section: 'Protective equipment' },
    { key: 'controls', label: 'Throttle, trigger lock and stop switch operate correctly', section: 'Controls' },
    { key: 'harness', label: 'Harness or carrying strap is adjusted and sound', section: 'Operator setup' },
    { key: 'area', label: 'Area checked for people, stones and hidden hazards', section: 'Before starting' },
  ],
  topdresser: [
    { key: 'hopper', label: 'Hopper, conveyor and spinner are clear and secure', section: 'Working parts' },
    { key: 'guards', label: 'Guards and covers are fitted and secure', section: 'Protective equipment' },
    { key: 'controls', label: 'Controls, clutch and emergency stop operate correctly', section: 'Controls' },
    { key: 'tyres', label: 'Tyres, wheels and wheel nuts are secure', section: 'Condition' },
    { key: 'leaks', label: 'No fuel, oil or hydraulic leaks visible', section: 'Condition' },
  ],
  utility_vehicle: [
    { key: 'tyres', label: 'Tyres, wheels and wheel nuts are secure', section: 'Condition' },
    { key: 'brakes', label: 'Brakes and parking brake operate correctly', section: 'Controls' },
    { key: 'steering', label: 'Steering, throttle and engine stop operate correctly', section: 'Controls' },
    { key: 'lights', label: 'Lights, horn, beacon and reversing alarm work where fitted', section: 'Visibility' },
    { key: 'load', label: 'Load, tow hitch and restraints are secure', section: 'Attachments' },
  ],
  other: [
    { key: 'guards', label: 'Guards, covers and protective devices are fitted', section: 'Protective equipment' },
    { key: 'controls', label: 'Controls and emergency stop operate correctly', section: 'Controls' },
    { key: 'working_parts', label: 'Working parts, tools and attachments are secure', section: 'Working parts' },
    { key: 'condition', label: 'No visible damage, loose parts or fluid leaks', section: 'Condition' },
    { key: 'area', label: 'Work area and hazards checked before starting', section: 'Before starting' },
  ],
};

const FUEL_OPTIONS = [
  { value: 'full', label: 'Full' },
  { value: 'three_quarters', label: '3/4' },
  { value: 'half', label: 'Half' },
  { value: 'quarter', label: '1/4' },
  { value: 'low', label: 'Low' },
  { value: 'charged', label: 'Charged' },
  { value: 'needs_charging', label: 'Needs charge' },
] as const;

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function machineTypeValue(value: unknown): MachineType {
  const type = String(value ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  return (type in MACHINE_LABELS ? type : 'other') as MachineType;
}

function normalizeMachines(response: unknown): Machine[] {
  return asArray(response, ['machines', 'data']).map((entry, index) => {
    const item = asRecord(entry);
    const rawType = item.machineType ?? item.machine_type ?? item.type;
    const id = Number(item.id ?? item.machineId ?? item.machine_id ?? index + 1);
    return {
      id,
      name: String(item.name ?? item.machineName ?? item.machine_name ?? `Machine ${id}`),
      machineType: machineTypeValue(rawType),
      assetTag: stringValue(item.assetTag ?? item.asset_tag),
      location: stringValue(item.location ?? item.siteName ?? item.site_name),
      active: item.active !== false,
      operatorRosterId:
        Number.isFinite(Number(item.operatorRosterId ?? item.operator_roster_id))
          ? Number(item.operatorRosterId ?? item.operator_roster_id)
          : null,
    };
  }).filter((machine) => Number.isFinite(machine.id) && machine.active);
}

function normalizeChecks(response: unknown): GreenCheck[] {
  return asArray(response, ['checks', 'preUseChecks', 'pre_use_checks', 'data'])
    .map((entry, index) => {
      const item = asRecord(entry);
      return {
        id: Number(item.id ?? index),
        machineName: stringValue(item.machineName ?? item.machine_name ?? item.machine),
        machineType: stringValue(item.machineType ?? item.machine_type),
        checkDate: String(item.checkDate ?? item.check_date ?? item.createdAt ?? today()).slice(0, 10),
        operator: stringValue(item.operator ?? item.signedBy ?? item.signed_by),
        result: String(item.result ?? 'pass'),
        defectNoted: Boolean(item.defectNoted ?? item.defect_noted),
        submittedAt: stringValue(item.submittedAt ?? item.submitted_at),
      };
    })
    .filter((check) => Number.isFinite(check.id));
}

function createChecklist(machineType: MachineType): ChecklistItem[] {
  return DEFINITIONS[machineType].map((item) => ({ ...item, status: null }));
}

function formatDate(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function titleCase(value: string | null): string {
  return value
    ? value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    : 'Equipment';
}

export default function GreenTrackScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, hasService } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const serviceEnabled = hasService('greentrack');

  const [selectedMachineId, setSelectedMachineId] = useState<number | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [checkDate, setCheckDate] = useState(today());
  const [operator, setOperator] = useState(user?.name ?? '');
  const [fuelLevel, setFuelLevel] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Staged evidence belongs to this new check for the selected machine only;
  // changing or clearing the machine discards it.
  const photoEvidence = useStagedPhotoEvidence('green_pre_use_check', serviceEnabled && selectedMachineId !== null);

  useEffect(() => {
    if (user?.name) setOperator(user.name);
  }, [user?.name]);

  const machinesQuery = useQuery<Machine[]>({
    queryKey: ['green-track-machines'],
    queryFn: async () => normalizeMachines(await apiFetch('/api/green-track/machines')),
    enabled: serviceEnabled,
  });

  const checksQuery = useQuery<GreenCheck[]>({
    queryKey: ['green-track-pre-use-checks'],
    queryFn: async () => normalizeChecks(await apiFetch('/api/green-track/pre-use-checks')),
    enabled: serviceEnabled,
  });

  const selectedMachine = useMemo(
    () => machinesQuery.data?.find((machine) => machine.id === selectedMachineId) ?? null,
    [machinesQuery.data, selectedMachineId],
  );

  const sections = useMemo(
    () => Array.from(new Set(items.map((item) => item.section))),
    [items],
  );
  const failedCount = items.filter((item) => item.status === 'fail').length;
  const checkedCount = items.filter((item) => item.status !== null).length;
  const allChecked = items.length > 0 && checkedCount === items.length;

  const submitMutation = useMutation({
    mutationFn: (payload: GreenCheckPayload) =>
      apiFetch('/api/green-track/pre-use-checks', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['green-track-pre-use-checks'] });
      setSelectedMachineId(null);
      setItems([]);
      setFuelLevel(null);
      setNotes('');
      setCheckDate(today());
      setOperator(user?.name ?? '');
      photoEvidence.consume();
      Alert.alert('Check signed off', 'The pre-use check has been recorded against the machine.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // The draft (machine, answers, notes) is kept; still-valid photos are kept
      // unless the server reports their receipts as unusable.
      Alert.alert('Could not save check', photoEvidence.handleCreateError(error, error.message || 'Please try again.'));
    },
  });

  if (!serviceEnabled) {
    return (
      <View style={[styles.gated, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={[styles.gatedTitle, { color: colors.foreground }]}>GreenTrack</Text>
        <Text style={[styles.gatedSub, { color: colors.mutedForeground }]}>
          GreenTrack is not enabled on your account. Contact your administrator to activate this module.
        </Text>
      </View>
    );
  }

  function selectMachine(machine: Machine) {
    setSelectedMachineId(machine.id);
    setItems(createChecklist(machine.machineType));
    setFuelLevel(null);
    setNotes('');
  }

  function markAllOk() {
    setItems((current) => current.map((item) => ({ ...item, status: 'ok', note: undefined })));
  }

  function updateItem(key: string, status: Exclude<ItemStatus, null>) {
    setItems((current) =>
      current.map((item) =>
        item.key === key
          ? { ...item, status, ...(status !== 'fail' ? { note: undefined } : {}) }
          : item,
      ),
    );
  }

  function updateItemNote(key: string, note: string) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, note } : item)));
  }

  function submit() {
    if (!selectedMachine || !items.length) {
      Alert.alert('Choose a machine', 'Select the machine you are about to use.');
      return;
    }
    if (!allChecked) {
      Alert.alert('Finish the checklist', 'Choose OK, FAIL or N/A for every check before signing off.');
      return;
    }
    if (!operator.trim()) {
      Alert.alert('Operator required', 'Your signed-in name is needed to complete this check.');
      return;
    }
    if (!photoEvidence.ready) {
      Alert.alert(
        'Photos required',
        photoEvidence.uploading
          ? 'Wait for the photo to finish verifying.'
          : `Attach at least ${photoEvidence.minimum} verified ${photoEvidence.minimum === 1 ? 'photo' : 'photos'} before signing off.`,
      );
      return;
    }
    const checklistItems = items.map((item) => ({
      key: item.key,
      label: item.label,
      section: item.section,
      status: item.status as Exclude<ItemStatus, null>,
      ...(item.status === 'fail' && item.note?.trim() ? { note: item.note.trim() } : {}),
    }));
    const payload = photoEvidence.preparePayload({
      machineId: selectedMachine.id,
      checkDate,
      operator: operator.trim(),
      operatorRosterId: selectedMachine.operatorRosterId,
      checklistItems,
      fuelLevel,
      notes: notes.trim(),
      defectNoted: failedCount > 0,
      result: failedCount > 0 ? 'fail' as const : 'pass' as const,
    });
    if (payload) submitMutation.mutate(payload);
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([machinesQuery.refetch(), checksQuery.refetch()]);
    setRefreshing(false);
  }

  const isLoading = machinesQuery.isLoading || checksQuery.isLoading;
  const queryError = machinesQuery.error || checksQuery.error;
  const recentChecks = (checksQuery.data ?? []).slice(0, 6);

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : 44 }}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={MODULE_COLOR} />
      }
    >
      <View style={[styles.header, { backgroundColor: colors.navy, paddingTop: topPad + 14 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity testID="green-back" onPress={() => router.back()} style={styles.backButton}>
            <Feather name="arrow-left" size={22} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={styles.moduleBadge}>
              <View style={styles.badgeMark} />
              <Text style={styles.moduleBadgeText}>GreenTrack</Text>
            </View>
            <Text style={styles.headerTitle}>Pre-use check</Text>
          </View>
          <View style={styles.backButton} />
        </View>
        <Text style={styles.headerNote}>A quick check before you put equipment to work.</Text>
      </View>

      <View style={styles.section}>
        <View style={[styles.introCard, { backgroundColor: MODULE_LIGHT, borderColor: '#cbdcbb' }]}>
          <View style={styles.introIcon}>
            <Feather name="shield" size={20} color={MODULE_COLOR} />
          </View>
          <View style={styles.introBody}>
            <Text style={[styles.introTitle, { color: INK }]}>Check the machine, then start.</Text>
            <Text style={[styles.introText, { color: '#526652' }]}>
              Stop and report any failed item. Never use equipment you do not believe is safe.
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>1. Choose equipment</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>What are you about to use?</Text>
          </View>
          {selectedMachine && (
            <TouchableOpacity
              testID="green-change-machine"
              onPress={() => setSelectedMachineId(null)}
              style={styles.changeButton}
            >
              <Text style={[styles.changeButtonText, { color: MODULE_COLOR }]}>Change</Text>
            </TouchableOpacity>
          )}
        </View>

        {machinesQuery.isLoading ? (
          <View style={styles.skeletonStack}>
            <View style={[styles.skeleton, { backgroundColor: colors.muted }]} />
            <View style={[styles.skeleton, { backgroundColor: colors.muted }]} />
          </View>
        ) : queryError ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="wifi-off" size={24} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Equipment could not load</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Check your connection and try again.
            </Text>
            <TouchableOpacity onPress={() => void onRefresh()} style={[styles.retryButton, { borderColor: MODULE_COLOR }]}>
              <Text style={[styles.retryText, { color: MODULE_COLOR }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (machinesQuery.data ?? []).length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="tool" size={24} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No equipment listed</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Ask a manager to add your site equipment before starting a check.
            </Text>
          </View>
        ) : selectedMachine ? (
          <View style={[styles.selectedMachine, { backgroundColor: colors.card, borderColor: MODULE_COLOR }]}>
            <View style={styles.machineIcon}>
              <Feather name="tool" size={20} color={MODULE_COLOR} />
            </View>
            <View style={styles.machineBody}>
              <Text style={[styles.machineName, { color: colors.foreground }]}>{selectedMachine.name}</Text>
              <Text style={[styles.machineMeta, { color: colors.mutedForeground }]}>
                {MACHINE_LABELS[selectedMachine.machineType]}
                {selectedMachine.assetTag ? ` · ${selectedMachine.assetTag}` : ''}
                {selectedMachine.location ? ` · ${selectedMachine.location}` : ''}
              </Text>
            </View>
            <Feather name="check-circle" size={21} color={MODULE_COLOR} />
          </View>
        ) : (
          <View style={styles.machineList}>
            {(machinesQuery.data ?? []).map((machine) => (
              <TouchableOpacity
                key={machine.id}
                testID={`green-machine-${machine.id}`}
                onPress={() => selectMachine(machine)}
                activeOpacity={0.75}
                style={[styles.machineCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.machineIcon}>
                  <Feather name="tool" size={20} color={MODULE_COLOR} />
                </View>
                <View style={styles.machineBody}>
                  <Text style={[styles.machineName, { color: colors.foreground }]}>{machine.name}</Text>
                  <Text style={[styles.machineMeta, { color: colors.mutedForeground }]}>
                    {MACHINE_LABELS[machine.machineType]}
                    {machine.assetTag ? ` · ${machine.assetTag}` : ''}
                    {machine.location ? ` · ${machine.location}` : ''}
                  </Text>
                </View>
                <Feather name="chevron-right" size={19} color={colors.mutedForeground} />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {selectedMachine && (
        <>
          <View style={styles.section}>
            <View style={styles.sectionHeading}>
              <View>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>2. Complete the check</Text>
                <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
                  {checkedCount} of {items.length} checks answered
                </Text>
              </View>
              <TouchableOpacity
                testID="green-mark-all-ok"
                onPress={markAllOk}
                disabled={submitMutation.isPending}
                style={[styles.markAllButton, { backgroundColor: MODULE_LIGHT }]}
              >
                <Feather name="check" size={15} color={MODULE_COLOR} />
                <Text style={[styles.markAllText, { color: MODULE_COLOR }]}>Mark all OK</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.progressFill,
                  { backgroundColor: allChecked ? MODULE_COLOR : '#b7ca9f', width: `${items.length ? (checkedCount / items.length) * 100 : 0}%` },
                ]}
              />
            </View>

            {sections.map((section) => (
              <View key={section} style={styles.checkSection}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{section}</Text>
                {items.filter((item) => item.section === section).map((item) => (
                  <View
                    key={item.key}
                    style={[
                      styles.checkCard,
                      {
                        backgroundColor: colors.card,
                        borderColor: item.status === 'fail' ? colors.destructive : item.status === 'ok' ? MODULE_COLOR : colors.border,
                      },
                    ]}
                  >
                    <Text style={[styles.checkLabel, { color: colors.foreground }]}>{item.label}</Text>
                    <View style={styles.statusRow}>
                      {([
                        { value: 'ok' as const, label: 'OK', icon: 'check' as const },
                        { value: 'fail' as const, label: 'FAIL', icon: 'x' as const },
                        { value: 'na' as const, label: 'N/A', icon: 'minus' as const },
                      ]).map((option) => {
                        const active = item.status === option.value;
                        const optionColor = option.value === 'fail' ? colors.destructive : option.value === 'ok' ? MODULE_COLOR : colors.mutedForeground;
                        return (
                          <TouchableOpacity
                            key={option.value}
                            testID={`green-${item.key}-${option.value}`}
                            onPress={() => updateItem(item.key, option.value)}
                            disabled={submitMutation.isPending}
                            style={[
                              styles.statusButton,
                              {
                                backgroundColor: active ? `${optionColor}18` : colors.background,
                                borderColor: active ? optionColor : colors.border,
                              },
                            ]}
                          >
                            <Feather name={option.icon} size={14} color={active ? optionColor : colors.mutedForeground} />
                            <Text style={[styles.statusText, { color: active ? optionColor : colors.mutedForeground }]}>
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {item.status === 'fail' && (
                      <TextInput
                        testID={`green-${item.key}-note`}
                        value={item.note ?? ''}
                        onChangeText={(note) => updateItemNote(item.key, note)}
                        placeholder="What needs attention?"
                        placeholderTextColor={colors.mutedForeground}
                        editable={!submitMutation.isPending}
                        style={[styles.failNote, { color: colors.foreground, backgroundColor: colors.background, borderColor: `${colors.destructive}66` }]}
                      />
                    )}
                  </View>
                ))}
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>3. Finish and sign off</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>Record the basics before you start work.</Text>

            <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Fuel or charge level</Text>
            <View style={styles.fuelGrid}>
              {FUEL_OPTIONS.map((option) => {
                const active = fuelLevel === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    testID={`green-fuel-${option.value}`}
                    onPress={() => setFuelLevel(active ? null : option.value)}
                    disabled={submitMutation.isPending}
                    style={[styles.fuelButton, { backgroundColor: active ? MODULE_LIGHT : colors.card, borderColor: active ? MODULE_COLOR : colors.border }]}
                  >
                    <Text style={[styles.fuelText, { color: active ? MODULE_COLOR : colors.foreground }]}>{option.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Overall notes <Text style={styles.optional}>(optional)</Text></Text>
            <TextInput
              testID="green-overall-notes"
              value={notes}
              onChangeText={setNotes}
              placeholder="Anything the next person should know?"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              editable={!submitMutation.isPending}
              style={[styles.notesInput, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border }]}
            />

            <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Operator</Text>
            <View style={[styles.operatorRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.operatorAvatar}>
                <Feather name="user" size={17} color={MODULE_COLOR} />
              </View>
              <View style={styles.operatorBody}>
                <Text style={[styles.operatorName, { color: colors.foreground }]}>{operator || 'Signed-in operator'}</Text>
                <Text style={[styles.operatorMeta, { color: colors.mutedForeground }]}>Authenticated operator · {formatDate(checkDate)}</Text>
              </View>
              <Feather name="lock" size={15} color={colors.mutedForeground} />
            </View>
            <Text style={[styles.signoffHint, { color: colors.mutedForeground }]}>
              Your authenticated identity and the submitted time are the sign-off. No separate signature is needed.
            </Text>

            <RequiredPhotoEvidence
              evidence={photoEvidence}
              disabled={submitMutation.isPending}
              accent={MODULE_COLOR}
              testIDPrefix="green-photo"
            />

            <TouchableOpacity
              testID="green-complete-signoff"
              onPress={submit}
              disabled={submitMutation.isPending || !allChecked || !photoEvidence.ready}
              style={[styles.submitButton, { backgroundColor: colors.navy }, (submitMutation.isPending || !allChecked || !photoEvidence.ready) && styles.disabled]}
            >
              {submitMutation.isPending ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <>
                  <Feather name="check-circle" size={19} color="#ffffff" />
                  <Text style={styles.submitText}>Complete and sign off</Text>
                </>
              )}
            </TouchableOpacity>
            {!allChecked && <Text style={[styles.submitHint, { color: colors.mutedForeground }]}>Answer every check to enable sign-off.</Text>}
            {allChecked && !photoEvidence.ready && !photoEvidence.loading && (
              <Text style={[styles.submitHint, { color: colors.mutedForeground }]}>
                {photoEvidence.uploading ? 'Verifying photo…' : 'Attach the required photos to enable sign-off.'}
              </Text>
            )}
          </View>
        </>
      )}

      {!isLoading && recentChecks.length > 0 && (
        <View style={[styles.section, { marginTop: 4 }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent checks</Text>
          <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>The latest checks recorded for your site.</Text>
          <View style={styles.historyList}>
            {recentChecks.map((check) => {
              const passed = check.result.toLowerCase() === 'pass';
              return (
                <View key={check.id} style={[styles.historyRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={[styles.historyIcon, { backgroundColor: passed ? `${MODULE_COLOR}18` : `${colors.destructive}18` }]}>
                    <Feather name={passed ? 'check' : 'alert-triangle'} size={16} color={passed ? MODULE_COLOR : colors.destructive} />
                  </View>
                  <View style={styles.historyBody}>
                    <Text style={[styles.historyMachine, { color: colors.foreground }]}>{check.machineName || titleCase(check.machineType)}</Text>
                    <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
                      {formatDate(check.checkDate)} · {check.operator || 'Operator'} · {passed ? 'Passed' : 'Defect noted'}
                    </Text>
                  </View>
                  <Text style={[styles.historyResult, { color: passed ? MODULE_COLOR : colors.destructive }]}>{passed ? 'PASS' : 'FAIL'}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  gated: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  gatedTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  gatedSub: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  header: { paddingHorizontal: 20, paddingBottom: 22 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { alignItems: 'center', gap: 6 },
  moduleBadge: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: 'rgba(196,220,164,0.18)' },
  badgeMark: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#c4dca4' },
  moduleBadgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: '#c4dca4' },
  headerTitle: { fontSize: 19, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  headerNote: { color: 'rgba(255,255,255,0.66)', textAlign: 'center', marginTop: 15, fontSize: 12, fontFamily: 'Inter_400Regular' },
  section: { paddingHorizontal: 16, paddingTop: 20, gap: 10 },
  introCard: { borderWidth: 1, borderRadius: 12, padding: 13, flexDirection: 'row', gap: 11 },
  introIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#d5e7c5', alignItems: 'center', justifyContent: 'center' },
  introBody: { flex: 1, gap: 3 },
  introTitle: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  introText: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  sectionTitle: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  sectionSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  changeButton: { paddingVertical: 4, paddingHorizontal: 4 },
  changeButtonText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  machineList: { gap: 9 },
  machineCard: { minHeight: 70, borderWidth: 1, borderRadius: 11, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 11 },
  selectedMachine: { minHeight: 70, borderWidth: 1.5, borderRadius: 11, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 11 },
  machineIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: MODULE_LIGHT, alignItems: 'center', justifyContent: 'center' },
  machineBody: { flex: 1, gap: 3 },
  machineName: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  machineMeta: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  markAllButton: { minHeight: 35, borderRadius: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  markAllText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
  checkSection: { gap: 7, marginTop: 5 },
  sectionLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.7, fontFamily: 'Inter_700Bold', marginTop: 6 },
  checkCard: { borderWidth: 1, borderRadius: 11, padding: 12, gap: 11 },
  checkLabel: { fontSize: 13, lineHeight: 18, fontFamily: 'Inter_600SemiBold' },
  statusRow: { flexDirection: 'row', gap: 7 },
  statusButton: { flex: 1, minHeight: 38, borderWidth: 1, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  statusText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  failNote: { height: 43, borderWidth: 1, borderRadius: 8, paddingHorizontal: 11, fontSize: 13, fontFamily: 'Inter_400Regular' },
  fieldLabel: { fontSize: 13, fontFamily: 'Inter_700Bold', marginTop: 6 },
  optional: { color: '#809080', fontFamily: 'Inter_400Regular' },
  fuelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  fuelButton: { minWidth: 72, flexGrow: 1, height: 41, paddingHorizontal: 10, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  fuelText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  notesInput: { minHeight: 82, borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingTop: 11, fontSize: 13, fontFamily: 'Inter_400Regular' },
  operatorRow: { minHeight: 59, borderWidth: 1, borderRadius: 10, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 10 },
  operatorAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: MODULE_LIGHT, alignItems: 'center', justifyContent: 'center' },
  operatorBody: { flex: 1, gap: 2 },
  operatorName: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  operatorMeta: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  signoffHint: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular', marginTop: -2 },
  submitButton: { height: 54, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 5 },
  submitText: { color: '#ffffff', fontSize: 15, fontFamily: 'Inter_700Bold' },
  submitHint: { textAlign: 'center', fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: -2 },
  disabled: { opacity: 0.48 },
  historyList: { gap: 8 },
  historyRow: { minHeight: 64, borderWidth: 1, borderRadius: 10, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 10 },
  historyIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  historyBody: { flex: 1, gap: 3 },
  historyMachine: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  historyMeta: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  historyResult: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  emptyCard: { borderWidth: 1, borderRadius: 11, padding: 24, alignItems: 'center', gap: 7 },
  emptyTitle: { fontSize: 14, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  emptyText: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular', textAlign: 'center', maxWidth: 270 },
  retryButton: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 14, paddingVertical: 8, marginTop: 4 },
  retryText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  skeletonStack: { gap: 9 },
  skeleton: { height: 70, borderRadius: 11, opacity: 0.65 },
});