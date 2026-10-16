import React, { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useStagedPhotoEvidence } from '@/hooks/useStagedPhotoEvidence';
import { useUnsentSubmissions } from '@/hooks/useUnsentSubmissions';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { newCheckEntryId } from '@/lib/checkOutbox';
import { RECORD_PATHS, type CheckKind } from '@/lib/checkOutboxCore';
import { OutboxEntries } from './OutboxEntries';
import { RequiredPhotoEvidence } from './RequiredPhotoEvidence';
import { UnsentSubmissions } from './UnsentSubmissions';
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import { attemptFromSavedBody, nextEntryAttempt, type EntryAttempt } from './client-entry-logic';
import { isRetryableFailure, type UnsentSubmission } from './unsent-submission-logic';
import {
  buildDefectPayload,
  buildFuelPayload,
  buildPuwerPayload,
  buildServicePayload,
  DEFECT_SEVERITY_LABELS,
  FUEL_TYPE_LABELS,
  greenSendRoute,
  localDate,
  normalizeGreenRecords,
  options,
  PUWER_TYPE_LABELS,
  SERVICE_TYPE_LABELS,
  type DefectDraft,
  type FuelDraft,
  type GreenMachineOption,
  type GreenPayloadResult,
  type GreenRecordRow,
  type GreenRecordTab,
  type PuwerDraft,
  type ServiceDraft,
} from './green-records-logic';

const TAB_CONFIG: Record<GreenRecordTab, {
  kind: Extract<CheckKind, `green-${string}`>;
  listPath: string;
  noun: string;
  button: string;
  photoEntity: 'green_defect' | 'green_service' | null;
}> = {
  defect: { kind: 'green-defect', listPath: '/api/green-track/defects', noun: 'Defect report', button: 'Report a defect', photoEntity: 'green_defect' },
  fuel: { kind: 'green-fuel', listPath: '/api/green-track/fuel-logs', noun: 'Fuel / oil log', button: 'Log fuel / oil', photoEntity: null },
  service: { kind: 'green-service', listPath: '/api/green-track/service-records', noun: 'Service record', button: 'Log a service', photoEntity: 'green_service' },
  puwer: { kind: 'green-puwer', listPath: '/api/green-track/puwer-inspections', noun: 'PUWER inspection', button: 'Log PUWER inspection', photoEntity: null },
};

type Draft = Record<string, string | boolean>;

function emptyDraft(tab: GreenRecordTab, userName: string): Draft {
  const today = localDate();
  switch (tab) {
    case 'defect':
      return { reportDate: today, reportedBy: userName, severity: 'minor', outOfService: false, description: '', notes: '' } satisfies DefectDraft;
    case 'fuel':
      return { logDate: today, fuelType: 'diesel', quantityLitres: '', engineHours: '', costPounds: '', filledBy: userName, notes: '' } satisfies FuelDraft;
    case 'service':
      return {
        serviceDate: today, serviceType: 'scheduled', hoursAtService: '', nextServiceHours: '', nextServiceDate: '',
        workPerformed: '', servicedBy: '', costPounds: '', notes: '',
      } satisfies ServiceDraft;
    case 'puwer':
      return {
        inspectionDate: today, nextInspectionDate: '', inspectionType: 'thorough_examination', inspectorName: '',
        inspectorCompany: '', certRef: '', safeToOperate: true, defectsFound: '', notes: '',
      } satisfies PuwerDraft;
  }
}

function buildPayload(tab: GreenRecordTab, draft: Draft, machineId: number | null): GreenPayloadResult {
  switch (tab) {
    case 'defect': return buildDefectPayload(draft as unknown as DefectDraft, machineId);
    case 'fuel': return buildFuelPayload(draft as unknown as FuelDraft, machineId);
    case 'service': return buildServicePayload(draft as unknown as ServiceDraft, machineId);
    case 'puwer': return buildPuwerPayload(draft as unknown as PuwerDraft, machineId);
  }
}

const withoutPhotos = (payload: Record<string, unknown>) => {
  const { photoUploadIds: _photos, ...rest } = payload;
  return rest;
};

/**
 * One GreenTrack machine record type (defect report, fuel / oil log, service
 * record or PUWER inspection) for the chosen machine: the website's form and
 * the recent records.
 *
 * Saving goes through the device outbox (kept without signal, resent under
 * the same entry ID). Defect reports and service records that the account
 * requires photos for are sent straight away instead, with staged photos, as
 * the pre-use check does: they need signal, a copy is kept on the device if
 * sending fails, and saving again with unchanged answers reuses the entry ID.
 */
export function GreenRecordPanel({
  tab,
  machine,
  machines,
  canRecord,
  onSelectMachine,
  onFormOpenChange,
}: {
  tab: GreenRecordTab;
  machine: GreenMachineOption | null;
  machines: GreenMachineOption[];
  canRecord: boolean;
  onSelectMachine: (id: number) => void;
  onFormOpenChange: (open: boolean) => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const config = TAB_CONFIG[tab];
  const userName = user?.name ?? '';
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(tab, userName));
  const set = (key: string) => (value: string | boolean) => setDraft((current) => ({ ...current, [key]: value }));

  const queryKey = ['green-records', tab, user?.clientId];
  const recordsQuery = useQuery<GreenRecordRow[]>({
    queryKey,
    queryFn: async () => normalizeGreenRecords(tab, await apiFetch(`${config.listPath}?limit=50`)),
  });

  const outbox = useRecordOutbox(config.kind);
  // Required photos (defects and service records only) belong to the open
  // form for this machine; closing it or switching record type drops them.
  const photoEvidence = useStagedPhotoEvidence(
    config.photoEntity ?? 'green_defect',
    config.photoEntity !== null && showForm && machine !== null,
  );
  const unsent = useUnsentSubmissions(`green-${tab}`);
  const [restoredDraftId, setRestoredDraftId] = useState<string | null>(null);
  const entryAttempt = useRef<EntryAttempt | null>(null);

  function closeForm() {
    setShowForm(false);
    onFormOpenChange(false);
    setDraft(emptyDraft(tab, userName));
    setRestoredDraftId(null);
    entryAttempt.current = null;
  }

  async function recorded(message: string) {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: ['green-records', tab] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    Alert.alert('Saved', message);
  }

  const label = (payload: Record<string, unknown>) => {
    const date = String(payload.reportDate ?? payload.logDate ?? payload.serviceDate ?? payload.inspectionDate ?? '');
    return `${config.noun} · ${machine?.name ?? 'Machine'} · ${date}`;
  };

  const outboxMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => outbox.send(payload, label(payload)),
    onSuccess: async (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert(`Unable to save ${config.noun.toLowerCase()}`, outcome.error);
        return;
      }
      closeForm();
      if (outcome.state === 'queued') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert(
          'Saved on this device',
          `No connection right now. The ${config.noun.toLowerCase()} is saved on this device and will be sent automatically when you are back online.`,
        );
        return;
      }
      await recorded(`${config.noun} recorded.`);
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert(`Unable to save ${config.noun.toLowerCase()}`, error.message);
    },
  });

  const directMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch(RECORD_PATHS[config.kind], { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: async (_response, payload) => {
      void unsent.resolve(withoutPhotos(payload));
      if (restoredDraftId) void unsent.discard(restoredDraftId);
      photoEvidence.consume();
      closeForm();
      await recorded(`${config.noun} recorded with its photos.`);
    },
    onError: (error: Error, payload) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      if (isRetryableFailure(error)) {
        // A device copy survives closing the screen (photos must be re-added).
        void unsent.record({
          body: withoutPhotos(payload),
          values: { machineId: machine?.id ?? null, draft },
          label: label(payload),
          error: error.message || 'Could not send.',
        });
      }
      Alert.alert(`Could not save ${config.noun.toLowerCase()}`, photoEvidence.handleCreateError(error, error.message || 'Please try again.'));
    },
  });

  const pending = outboxMutation.isPending || directMutation.isPending;

  function restoreDraft(saved: UnsentSubmission) {
    const values = saved.values ?? {};
    const target = machines.find((item) => item.id === values.machineId);
    if (!target || !values.draft || typeof values.draft !== 'object') {
      Alert.alert('Cannot reopen this record', 'Its machine is no longer available. Discard it and start again.');
      return;
    }
    onSelectMachine(target.id);
    setDraft({ ...emptyDraft(tab, userName), ...(values.draft as Draft) });
    setShowForm(true);
    onFormOpenChange(true);
    setRestoredDraftId(saved.id);
    entryAttempt.current = attemptFromSavedBody(saved.body);
    Alert.alert('Record reopened', 'Review the details, add the required photos again, then save.');
  }

  function submit() {
    const built = buildPayload(tab, draft, machine?.id ?? null);
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    const route = config.photoEntity ? greenSendRoute(photoEvidence) : 'outbox';
    if (route === 'wait') {
      Alert.alert('One moment', 'Checking whether photos are required for this record.');
      return;
    }
    if (route === 'outbox') {
      outboxMutation.mutate(built.payload);
      return;
    }
    if (!photoEvidence.ready) {
      Alert.alert(
        'Photos required',
        photoEvidence.uploading
          ? 'Wait for the photo to finish verifying.'
          : `Attach at least ${photoEvidence.minimum} verified ${photoEvidence.minimum === 1 ? 'photo' : 'photos'} before saving.`,
      );
      return;
    }
    const payload = photoEvidence.preparePayload(built.payload);
    if (!payload) return;
    // Saving again with unchanged answers reuses the entry ID, so a resend
    // after a lost response never records it twice.
    const attempt = nextEntryAttempt(entryAttempt.current, payload, () => newCheckEntryId(config.kind));
    entryAttempt.current = attempt;
    directMutation.mutate({ ...payload, clientEntryId: attempt.id });
  }

  function toggleForm() {
    if (pending) return;
    if (showForm) {
      closeForm();
      return;
    }
    if (!machine) return;
    setDraft(emptyDraft(tab, userName));
    setShowForm(true);
    onFormOpenChange(true);
  }

  const field = (title: string, key: string, placeholder: string, opts: { multiline?: boolean; date?: boolean; number?: 'decimal' | 'whole' } = {}) => (
    <AquaField label={title}>
      <AquaInput
        value={String(draft[key] ?? '')}
        onChangeText={set(key)}
        placeholder={placeholder}
        keyboardType={opts.date ? 'numbers-and-punctuation' : opts.number === 'decimal' ? 'decimal-pad' : opts.number === 'whole' ? 'number-pad' : undefined}
        multiline={opts.multiline}
        colors={colors}
        disabled={pending}
        testID={`green-${tab}-${key}`}
      />
    </AquaField>
  );
  const choice = (title: string, key: string, labels: Record<string, string>) => (
    <AquaChoiceRow
      label={title}
      options={options(labels)}
      value={String(draft[key])}
      onChange={set(key)}
      colors={colors}
      disabled={pending}
      testIDPrefix={`green-${tab}-${key}`}
    />
  );
  const yesNo = (title: string, key: string) => (
    <AquaChoiceRow
      label={title}
      options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
      value={draft[key] ? 'yes' : 'no'}
      onChange={(value) => set(key)(value === 'yes')}
      colors={colors}
      disabled={pending}
      testIDPrefix={`green-${tab}-${key}`}
    />
  );

  function formFields() {
    switch (tab) {
      case 'defect':
        return (
          <>
            {field('Report date', 'reportDate', 'YYYY-MM-DD', { date: true })}
            {field('Reported by', 'reportedBy', 'Name')}
            {choice('Severity', 'severity', DEFECT_SEVERITY_LABELS)}
            {yesNo('Take machine out of service until repaired?', 'outOfService')}
            {field('Defect description', 'description', 'Describe the fault, damage, or safety concern…', { multiline: true })}
            {field('Notes', 'notes', 'Optional', { multiline: true })}
          </>
        );
      case 'fuel':
        return (
          <>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>{field('Date', 'logDate', 'YYYY-MM-DD', { date: true })}</View>
              <View style={{ flex: 1 }}>{field('Quantity (litres)', 'quantityLitres', 'e.g. 25.0', { number: 'decimal' })}</View>
            </View>
            {choice('Type', 'fuelType', FUEL_TYPE_LABELS)}
            <View style={styles.row}>
              <View style={{ flex: 1 }}>{field('Engine hours', 'engineHours', 'e.g. 512', { number: 'whole' })}</View>
              <View style={{ flex: 1 }}>{field('Cost (£)', 'costPounds', '0.00', { number: 'decimal' })}</View>
            </View>
            {field('Filled by', 'filledBy', 'Name')}
            {field('Notes', 'notes', 'Optional', { multiline: true })}
          </>
        );
      case 'service':
        return (
          <>
            {field('Service date', 'serviceDate', 'YYYY-MM-DD', { date: true })}
            {choice('Service type', 'serviceType', SERVICE_TYPE_LABELS)}
            <View style={styles.row}>
              <View style={{ flex: 1 }}>{field('Hours at service', 'hoursAtService', 'e.g. 450', { number: 'whole' })}</View>
              <View style={{ flex: 1 }}>{field('Next service (hours)', 'nextServiceHours', 'e.g. 550', { number: 'whole' })}</View>
            </View>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>{field('Next service date', 'nextServiceDate', 'YYYY-MM-DD', { date: true })}</View>
              <View style={{ flex: 1 }}>{field('Cost (£)', 'costPounds', '0.00', { number: 'decimal' })}</View>
            </View>
            {field('Serviced by', 'servicedBy', 'Name or company')}
            {field('Work performed', 'workPerformed', 'Oil & filter change, blade sharpening, belt replacement…', { multiline: true })}
            {field('Notes', 'notes', 'Optional', { multiline: true })}
          </>
        );
      case 'puwer':
        return (
          <>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>{field('Inspection date', 'inspectionDate', 'YYYY-MM-DD', { date: true })}</View>
              <View style={{ flex: 1 }}>{field('Next inspection due', 'nextInspectionDate', 'YYYY-MM-DD', { date: true })}</View>
            </View>
            {choice('Inspection type', 'inspectionType', PUWER_TYPE_LABELS)}
            {field('Inspector name', 'inspectorName', 'Name')}
            {field('Inspector company', 'inspectorCompany', 'Optional')}
            {field('Certificate / report ref', 'certRef', 'e.g. PUWER-2024-001')}
            {yesNo('Safe to continue operating?', 'safeToOperate')}
            {field('Defects / observations', 'defectsFound', 'Any defects identified during inspection…', { multiline: true })}
            {field('Notes', 'notes', 'Optional', { multiline: true })}
          </>
        );
    }
  }

  const rows = (recordsQuery.data ?? [])
    .filter((row) => !machine || row.machineId === machine.id)
    .slice(0, 8);
  const toneColor = (tone: NonNullable<GreenRecordRow['flag']>['tone']) =>
    tone === 'danger' ? colors.destructive : tone === 'warning' ? colors.warning : tone === 'ok' ? colors.success : colors.mutedForeground;
  const photoRoute = config.photoEntity !== null && showForm && greenSendRoute(photoEvidence) === 'photos';

  return (
    <View>
      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />
      {config.photoEntity ? (
        <UnsentSubmissions
          drafts={unsent.drafts}
          disabled={pending || showForm}
          primaryLabel="Reopen"
          onRetry={restoreDraft}
          onDiscard={(saved) => {
            if (saved.id === restoredDraftId) setRestoredDraftId(null);
            void unsent.discard(saved.id);
          }}
          note="Reopen puts the saved details back in the form; add the required photos again before saving."
        />
      ) : null}

      {canRecord ? (
        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: colors.navy }, (pending || (!showForm && !machine)) && styles.disabled]}
          onPress={toggleForm}
          disabled={pending || (!showForm && !machine)}
          testID={`green-${tab}-toggle-form`}
        >
          <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
          <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : config.button}</Text>
        </TouchableOpacity>
      ) : null}

      {showForm && machine ? (
        <View style={{ paddingTop: 16 }}>
          {formFields()}
          {config.photoEntity ? (
            <RequiredPhotoEvidence evidence={photoEvidence} disabled={pending} testIDPrefix={`green-${tab}-photos`} />
          ) : null}
          {photoRoute ? (
            <Text style={[styles.detail, { color: colors.mutedForeground, marginBottom: 10 }]}>
              Records with required photos need a connection to save.
            </Text>
          ) : null}
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, pending && styles.disabled]}
            onPress={submit}
            disabled={pending}
            testID={`green-${tab}-submit`}
          >
            {pending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{pending ? 'Saving…' : 'Save'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={{ marginTop: 16 }}>
        {recordsQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          recordsQuery.isError ? (
            <AquaEmptyState colors={colors} error message={recordsQuery.error instanceof Error ? recordsQuery.error.message : 'Records could not be loaded.'}>
              <TouchableOpacity onPress={() => void recordsQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : rows.length ? rows.map((row) => (
            <View key={row.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`green-${tab}-row-${row.id}`}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{row.date}</Text>
                {row.flag ? (
                  <View style={[styles.badge, { backgroundColor: toneColor(row.flag.tone) + '1a' }]}>
                    <Text style={[styles.badgeText, { color: toneColor(row.flag.tone) }]}>{row.flag.label}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.detail, { color: colors.foreground }]} numberOfLines={2}>{row.title}</Text>
              {!machine ? <Text style={[styles.detail, { color: colors.mutedForeground }]}>{row.machineName}</Text> : null}
              {row.detail ? <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>{row.detail}</Text> : null}
            </View>
          )) : (
            <AquaEmptyState colors={colors} message={machine ? `No ${config.noun.toLowerCase()}s for ${machine.name} yet.` : `No ${config.noun.toLowerCase()}s yet.`} />
          )}
      </View>
    </View>
  );
}
