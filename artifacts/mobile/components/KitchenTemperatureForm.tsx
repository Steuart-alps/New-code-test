import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
} from 'react-native';
import { assessKitchenTemperatures, kitchenFailureValue, kitchenHoldRequirement, parseKitchenTemperatureRules, temperatureRangeLabel, type KitchenTemperatureFailure } from '@workspace/api-client-react';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useColors } from '@/hooks/useColors';
import { apiFetch } from '@/lib/api';
import { kitchenDraftStorage, kitchenOutbox, newKitchenEntryId, useKitchenOutbox } from '@/lib/kitchenOutbox';
import {
  diaryFingerprint,
  discardKitchenDraft,
  kitchenFormDraftKey,
  listKitchenDrafts,
  loadKitchenDraft,
  mergeColdReadings,
  onKitchenDraftChanged,
  reviewKitchenDraft,
  saveKitchenDraft,
  type KitchenFormDraft,
} from './kitchen-form-drafts';
import { KitchenQueueStatus } from './KitchenQueueStatus';
import { DEFAULT_DIARY_SITE, kitchenDiaryScope } from './kitchen-diary-scope';
import {
  requestDiaryScopeChange,
  shouldHydrateDiaryDraft,
} from './kitchen-diary-draft-logic';
import {
  configuredUnits,
  deviceLocalCalendarDate,
  hydrateColdReadings,
  type ColdReading,
  type FoodSafetyColdConfig,
} from './kitchen-temperature-form-logic';
import {
  canSaveTemperatureForm,
  hasAnyValue,
  shouldIncludeHotHolding,
} from '@/components/kitchen-temperature-logic';

interface Site {
  id: number;
  name: string;
}

interface DeliveryReading {
  supplier: string;
  items: string;
  tempChilled: string;
  tempFrozen: string;
  correctiveActions: string;
}

interface HotHoldingReading {
  item: string;
  coreTemp: string;
  timeOfCheck: string;
}

interface CoreTemperatureReading {
  item: string;
  coreTemp: string;
  timeStart: string;
  timeFinish: string;
  /** Cooking only: seconds held at the core temperature. */
  holdSeconds?: string;
}

interface FoodSafetyConfig extends FoodSafetyColdConfig {
  food_temperature_rules?: string | null;
  food_hot_holding_limit?: string | null;
  food_reheating_limit?: string | null;
  food_show_deliveries?: string | null;
  food_show_cold_food?: string | null;
  food_show_hot_temperature?: string | null;
  food_show_cooling?: string | null;
  food_show_reheating?: string | null;
  food_show_hot_holding?: string | null;
}

interface FoodSafetyRecord {
  id: number;
  coldFood?: ColdReading[];
  deliveries?: DeliveryReading[];
  hotHolding?: HotHoldingReading[];
  correctives?: string | null;
  submittedAt?: string | null;
}

const EMPTY_DELIVERY: DeliveryReading = {
  supplier: '',
  items: '',
  tempChilled: '',
  tempFrozen: '',
  correctiveActions: '',
};
const EMPTY_HOT_HOLDING: HotHoldingReading = {
  item: '',
  coreTemp: '',
  timeOfCheck: '',
};
const EMPTY_CORE_READING: CoreTemperatureReading = {
  item: '',
  coreTemp: '',
  timeStart: '',
  timeFinish: '',
};

function today(): string {
  return deviceLocalCalendarDate(new Date());
}

function currentTime(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function KitchenTemperatureForm() {
  return (
    <View style={{ flex: 1 }}>
      <KitchenQueueStatus />
      <KitchenTemperatureFields />
    </View>
  );
}

function KitchenTemperatureFields() {
  const colors = useColors();
  const router = useRouter();
  const outbox = useKitchenOutbox();
  const submissionId = useRef<string | null>(null);
  const [date] = useState(today);
  const [siteId, setSiteId] = useState<number | null>(DEFAULT_DIARY_SITE);
  const scope = kitchenDiaryScope(siteId, date);
  const pendingForDiary = outbox.entries.some(entry =>
    entry.siteId === siteId && entry.recordDate === date && entry.state !== 'sent');
  const [coldFood, setColdFood] = useState<ColdReading[]>([]);
  const [initialColdFood, setInitialColdFood] = useState<ColdReading[]>([]);
  const [delivery, setDelivery] = useState<DeliveryReading>(EMPTY_DELIVERY);
  const [hotHolding, setHotHolding] = useState<HotHoldingReading>(EMPTY_HOT_HOLDING);
  const [cooking, setCooking] = useState<CoreTemperatureReading>(EMPTY_CORE_READING);
  const [cooling, setCooling] = useState<CoreTemperatureReading>(EMPTY_CORE_READING);
  const [reheating, setReheating] = useState<CoreTemperatureReading>(EMPTY_CORE_READING);
  const [correctives, setCorrectives] = useState('');
  const [initialCorrectives, setInitialCorrectives] = useState<string | null>(null);
  const [loadedRecordId, setLoadedRecordId] = useState<number | null | undefined>(undefined);
  const [isDirty, setIsDirty] = useState(false);
  const dirtyRef = useRef(false);
  const owner = outbox.owner;
  // Fingerprint of the diary as loaded; a draft entered against a different
  // fingerprint is restored on top of the latest diary and flagged for review.
  const [loadedFingerprint, setLoadedFingerprint] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [draftCheck, setDraftCheck] = useState(0);
  const draftOrigin = useRef<KitchenFormDraft['origin']>('form');
  const promptedDraft = useRef<string | null>(null);
  const [otherDayDrafts, setOtherDayDrafts] = useState<KitchenFormDraft[]>([]);

  const markDirty = () => {
    submissionId.current = null;
    dirtyRef.current = true;
    setIsDirty(true);
  };
  const clearDirty = () => {
    dirtyRef.current = false;
    setIsDirty(false);
  };

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });
  const {
    data: config,
    isLoading: configLoading,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery<FoodSafetyConfig>({
    queryKey: scope.configKey,
    queryFn: () => apiFetch(scope.configUrl),
  });
  const units = useMemo(() => configuredUnits(config), [config]);

  const {
    data: existingRecord,
    isLoading: recordLoading,
    isError: recordError,
    refetch: refetchRecord,
  } = useQuery<FoodSafetyRecord | null>({
    queryKey: scope.recordKey,
    queryFn: () => apiFetch(scope.recordUrl),
  });

  useEffect(() => {
    if (
      !config
      || existingRecord === undefined
      || !shouldHydrateDiaryDraft(dirtyRef.current)
    ) return;
    const { coldFood: nextColdFood, initialColdFood: nextInitialColdFood } =
      hydrateColdReadings(units, existingRecord?.coldFood);
    setColdFood(nextColdFood);
    setInitialColdFood(nextInitialColdFood);
    setDelivery(EMPTY_DELIVERY);
    setHotHolding({
      ...EMPTY_HOT_HOLDING,
      timeOfCheck: currentTime(),
    });
    setCooking(EMPTY_CORE_READING);
    setCooling(EMPTY_CORE_READING);
    setReheating(EMPTY_CORE_READING);
    setCorrectives(existingRecord?.correctives ?? '');
    setInitialCorrectives(existingRecord?.correctives ?? null);
    setLoadedRecordId(existingRecord?.id ?? null);
    setLoadedFingerprint(diaryFingerprint(existingRecord ?? null));
    clearDirty();
  }, [config, existingRecord, units]);

  // Offer this account's unfinished form for this diary, if any.
  useEffect(() => {
    if (!owner || loadedRecordId === undefined || loadedFingerprint === null || dirtyRef.current) return;
    let cancelled = false;
    void loadKitchenDraft(kitchenDraftStorage, owner, siteId, date).then(draft => {
      if (cancelled || !draft || dirtyRef.current) return;
      const promptKey = `${kitchenFormDraftKey(owner, siteId, date)}@${draft.savedAt}`;
      if (promptedDraft.current === promptKey) return;
      promptedDraft.current = promptKey;
      const review = reviewKitchenDraft(draft, loadedFingerprint, date);
      if (review.kind === 'other-date') return;
      const restore = () => {
        setColdFood(current => mergeColdReadings(current, draft.values.coldFood));
        setDelivery({ ...EMPTY_DELIVERY, ...draft.values.delivery });
        setHotHolding({ ...EMPTY_HOT_HOLDING, ...draft.values.hotHolding });
        setCooking({ ...EMPTY_CORE_READING, ...draft.values.cooking });
        setCooling({ ...EMPTY_CORE_READING, ...draft.values.cooling });
        setReheating({ ...EMPTY_CORE_READING, ...draft.values.reheating });
        setCorrectives(draft.values.correctives);
        draftOrigin.current = draft.origin;
        markDirty();
        setDraftNotice(review.kind === 'review'
          ? draft.origin === 'restored'
            ? 'Restored from a rejected device entry and re-checked against the latest diary and temperature controls. Review every reading before saving; it will be sent as a new entry.'
            : 'This diary changed after these readings were entered. They are shown on top of the latest diary — review them before saving.'
          : 'Unsaved readings restored. Review and save when ready.');
      };
      const discard = () => Alert.alert(
        'Discard unsaved readings?',
        'The readings kept on this device for this diary will be deleted. This cannot be undone.',
        [
          { text: 'Keep them', style: 'cancel', onPress: () => { promptedDraft.current = null; setDraftCheck(n => n + 1); } },
          { text: 'Discard', style: 'destructive', onPress: () => {
            void discardKitchenDraft(kitchenDraftStorage, owner, siteId, date);
          } },
        ],
      );
      Alert.alert(
        draft.origin === 'restored' ? 'Edit restored readings?' : 'Restore unsaved readings?',
        review.kind === 'review'
          ? 'Readings for this diary were kept on this device, but the diary or its controls may have changed since. They will be shown on top of the latest diary for you to review.'
          : 'Readings for this diary were kept on this device and have not been saved yet.',
        [
          { text: 'Discard', style: 'destructive', onPress: discard },
          { text: 'Restore', onPress: restore },
        ],
      );
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [owner, siteId, date, loadedRecordId, loadedFingerprint, draftCheck]);

  // A rejected entry restored from the delivery panel writes a draft.
  useEffect(() => onKitchenDraftChanged(key => {
    if (owner && key === kitchenFormDraftKey(owner, siteId, date)) {
      promptedDraft.current = null;
      setDraftCheck(n => n + 1);
    } else {
      Alert.alert('Readings restored as a draft',
        'They belong to another diary. Choose that diary’s site to review and save them.');
    }
  }), [owner, siteId, date]);

  // Earlier days' drafts cannot be opened here (the form edits today's diary,
  // and older diaries may be locked); list them so they can be reviewed.
  useEffect(() => {
    if (!owner) return;
    void listKitchenDrafts(kitchenDraftStorage as never, owner)
      .then(drafts => setOtherDayDrafts(drafts.filter(draft => draft.recordDate !== date)))
      .catch(() => {});
  }, [owner, date, draftCheck]);

  // Keep dirty values on the device until they are saved or discarded.
  useEffect(() => {
    if (!owner || !dirtyRef.current || loadedRecordId === undefined) return;
    const timer = setTimeout(() => {
      void saveKitchenDraft(kitchenDraftStorage, {
        version: 1, owner, siteId, recordDate: date,
        values: { coldFood, delivery: { ...delivery }, hotHolding: { ...hotHolding }, cooking: { ...cooking },
          cooling: { ...cooling }, reheating: { ...reheating }, correctives },
        baseline: loadedFingerprint, origin: draftOrigin.current, savedAt: new Date().toISOString(),
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [owner, siteId, date, loadedRecordId, loadedFingerprint, isDirty, coldFood, delivery, hotHolding, cooking, cooling, reheating, correctives]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (loadedRecordId === undefined) throw new Error('Wait for the selected diary to load.');
      if (temperatureAssessment.error) throw new Error(temperatureAssessment.error);
      if (temperatureAssessment.failures.some(f => !f.actionTaken)) throw new Error('Record the corrective action taken for the failed readings before saving.');
      const hasValues = (row: object) =>
        Object.values(row).some((value) => typeof value === 'string' && value.trim());
      const deliveryRow = config?.food_show_deliveries !== 'false' && hasValues(delivery)
        ? delivery : undefined;
      const holdingRow = config?.food_show_hot_holding !== 'false'
        && shouldIncludeHotHolding(hotHolding)
        ? hotHolding : undefined;
      const cookingRow = config?.food_show_hot_temperature !== 'false' && hasValues(cooking)
        ? cooking : undefined;
      const coolingRow = config?.food_show_cooling !== 'false' && hasValues(cooling)
        ? cooling : undefined;
      const reheatingRow = config?.food_show_reheating !== 'false' && hasValues(reheating)
        ? reheating : undefined;
      const body = loadedRecordId === null ? {
        recordDate: date,
        coldFood,
        deliveries: deliveryRow ? [deliveryRow] : [],
        hotHolding: holdingRow ? [holdingRow] : [],
        hotTemperature: cookingRow ? [cookingRow] : [],
        cooling: coolingRow ? [coolingRow] : [],
        reheating: reheatingRow ? [reheatingRow] : [],
        correctives: correctives.trim(),
      } : {
        mobileTemperatureLog: {
          coldFood,
          expectedColdFood: initialColdFood,
          ...(deliveryRow ? { delivery: deliveryRow } : {}),
          ...(holdingRow ? { hotHolding: holdingRow } : {}),
          ...(cookingRow ? { hotTemperature: cookingRow } : {}),
          ...(coolingRow ? { cooling: coolingRow } : {}),
          ...(reheatingRow ? { reheating: reheatingRow } : {}),
          ...(correctives !== (initialCorrectives ?? '') ? { correctives: correctives.trim() } : {}),
          expectedCorrectives: initialCorrectives,
        },
      };
      if (pendingForDiary) throw new Error('This diary already has a saved device entry. Wait for delivery or review the failed entry first.');
      submissionId.current ??= newKitchenEntryId();
      return kitchenOutbox.enqueue({
        entryId: submissionId.current, siteId, recordDate: date, recordId: loadedRecordId, body,
      });
    },
    onSuccess: async (entry) => {
      clearDirty();
      submissionId.current = null;
      draftOrigin.current = 'form';
      setDraftNotice(null);
      if (owner) await discardKitchenDraft(kitchenDraftStorage, owner, siteId, date).catch(() => {});
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(entry.state === 'sent' ? 'Sent' : 'Saved on this device',
        entry.state === 'sent' ? 'The server has confirmed these readings.'
          : 'The readings are queued for delivery. KitchenTrack delivery shows “Sent” only after the server confirms them.', [
        { text: 'Done', onPress: () => router.back() },
      ]);
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not save', error.message);
    },
  });

  const loading = configLoading || recordLoading || loadedRecordId === undefined;
  const waitingForCreatedDiary = loadedRecordId === null && outbox.entries.some(entry =>
    entry.siteId === siteId && entry.recordDate === date && entry.state === 'sent' && entry.recordId === null);
  const temperatureAssessment = (() => {
    try {
      const before = loadedRecordId === null ? null : {
        ...existingRecord, coldFood: initialColdFood, correctives: initialCorrectives,
      };
      const append = (section: string, row: object) =>
        [...(((existingRecord as unknown as Record<string, unknown>)?.[section] ?? []) as object[]), row];
      const after = {
        coldFood, correctives,
        deliveries: config?.food_show_deliveries === 'false' ? existingRecord?.deliveries ?? [] : append('deliveries', delivery),
        hotHolding: config?.food_show_hot_holding === 'false' ? existingRecord?.hotHolding ?? [] : append('hotHolding', hotHolding),
        hotTemperature: config?.food_show_hot_temperature === 'false' ? (before as Record<string, unknown>)?.hotTemperature ?? [] : append('hotTemperature', cooking),
        cooling: config?.food_show_cooling === 'false' ? (before as Record<string, unknown>)?.cooling ?? [] : append('cooling', cooling),
        reheating: config?.food_show_reheating === 'false' ? (before as Record<string, unknown>)?.reheating ?? [] : append('reheating', reheating),
      };
      const rules = parseKitchenTemperatureRules(config?.food_temperature_rules);
      return { failures: assessKitchenTemperatures(before, after, rules, units), error: '', rules };
    } catch (error) {
      return { failures: [] as KitchenTemperatureFailure[], error: error instanceof Error ? error.message : 'The temperature rules could not be evaluated.', rules: null };
    }
  })();
  const canSave = !temperatureAssessment.error && temperatureAssessment.failures.every(f => !!f.actionTaken)
    && !pendingForDiary && !waitingForCreatedDiary && !outbox.error && canSaveTemperatureForm(
    { coldFood, delivery, hotHolding, cooking, cooling, reheating, correctives },
    {
      deliveries: config?.food_show_deliveries !== 'false',
      hotHolding: config?.food_show_hot_holding !== 'false',
      cooking: config?.food_show_hot_temperature !== 'false',
      cooling: config?.food_show_cooling !== 'false',
      reheating: config?.food_show_reheating !== 'false',
    },
  );

  const switchSite = (nextSiteId: number | null) => {
    submissionId.current = null;
    clearDirty();
    setLoadedRecordId(undefined);
    setSiteId(nextSiteId);
  };

  const requestSiteChange = (nextSiteId: number | null) => {
    const decision = requestDiaryScopeChange(siteId, nextSiteId, isDirty || dirtyRef.current, saveMutation.isPending);
    if (decision.kind === 'ignore') return;
    if (decision.kind === 'switch') {
      switchSite(decision.siteId);
      return;
    }
    Alert.alert(
      'Discard unsaved readings?',
      'Switching sites will discard the readings entered for this diary.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard changes',
          style: 'destructive',
          onPress: () => {
            if (owner) void discardKitchenDraft(kitchenDraftStorage, owner, siteId, date);
            setDraftNotice(null);
            draftOrigin.current = 'form';
            switchSite(decision.siteId);
          },
        },
      ],
    );
  };

  if ((configError || recordError) && (loadedRecordId === undefined || !config)) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <Feather name="wifi-off" size={28} color={colors.mutedForeground} />
        <Text style={[styles.errorTitle, { color: colors.foreground }]}>Could not load today’s diary</Text>
        <Text style={[styles.helper, styles.centerText, { color: colors.mutedForeground }]}>
          Check your connection and try again.
        </Text>
        <TouchableOpacity
          style={[styles.retry, { backgroundColor: colors.navy }]}
          onPress={() => {
            void refetchConfig();
            void refetchRecord();
          }}
        >
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[styles.helper, { color: colors.mutedForeground }]}>Loading today’s diary…</Text>
      </View>
    );
  }

  return (
    <KeyboardAwareScrollViewCompat
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      bottomOffset={64}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.badge, { backgroundColor: colors.warning + '1a', borderColor: colors.warning + '44' }]}>
        <Feather name="thermometer" size={14} color={colors.warning} />
        <Text style={[styles.badgeText, { color: colors.warning }]}>KitchenTrack · Today</Text>
      </View>

      {sites.length > 0 ? (
        <View style={styles.siteSection}>
          <Text style={[styles.label, { color: colors.foreground }]}>Diary site</Text>
          <View style={styles.siteList}>
            <TouchableOpacity
              style={[
                styles.siteChip,
                {
                  borderColor: siteId === null ? colors.primary : colors.border,
                  backgroundColor: siteId === null ? colors.primary + '1a' : colors.card,
                },
              ]}
              disabled={saveMutation.isPending}
              onPress={() => {
                requestSiteChange(null);
              }}
            >
              <Text style={[styles.siteChipText, { color: siteId === null ? colors.primary : colors.mutedForeground }]}>
                All sites
              </Text>
            </TouchableOpacity>
            {sites.map((site) => (
              <TouchableOpacity
                key={site.id}
                style={[
                  styles.siteChip,
                  {
                    borderColor: siteId === site.id ? colors.primary : colors.border,
                    backgroundColor: siteId === site.id ? colors.primary + '1a' : colors.card,
                  },
                ]}
                disabled={saveMutation.isPending}
                onPress={() => {
                  requestSiteChange(site.id);
                }}
              >
                <Text style={[styles.siteChipText, { color: siteId === site.id ? colors.primary : colors.mutedForeground }]}>
                  {site.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

      {draftNotice ? (
        <View testID="kitchen-draft-notice" style={[styles.notice, { borderColor: colors.primary, backgroundColor: colors.primary + '12' }]}>
          <Feather name="rotate-ccw" size={18} color={colors.primary} />
          <Text style={[styles.helper, { color: colors.foreground, flex: 1 }]}>{draftNotice}</Text>
        </View>
      ) : null}

      {otherDayDrafts.map(draft => (
        <View key={`${draft.siteId}:${draft.recordDate}`} style={[styles.notice, { borderColor: colors.warning, backgroundColor: colors.warning + '12' }]}>
          <Feather name="clock" size={18} color={colors.warning} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={[styles.helper, { color: colors.foreground }]}>
              Unsaved readings from {draft.recordDate} are still on this device. This form records today’s diary; if that day’s diary is still open for edits, enter them there.
            </Text>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <TouchableOpacity onPress={() => Alert.alert(`Unsaved readings · ${draft.recordDate}`,
                JSON.stringify(draft.values, null, 2))}>
                <Text style={{ color: colors.primary }}>View</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Alert.alert('Discard these readings?', 'They will be deleted from this device.', [
                { text: 'Keep', style: 'cancel' },
                { text: 'Discard', style: 'destructive', onPress: () => {
                  if (!owner) return;
                  void discardKitchenDraft(kitchenDraftStorage, owner, draft.siteId, draft.recordDate)
                    .then(() => setDraftCheck(n => n + 1));
                } },
              ])}>
                <Text style={{ color: colors.destructive }}>Discard</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ))}

      {existingRecord?.submittedAt ? (
        <View style={[styles.notice, { borderColor: colors.warning, backgroundColor: colors.warning + '12' }]}>
          <Feather name="alert-circle" size={18} color={colors.warning} />
          <Text style={[styles.noticeText, { color: colors.foreground }]}>
            Today’s diary is signed off. Saving will update its temperature readings.
          </Text>
        </View>
      ) : null}

      {waitingForCreatedDiary ? (
        <TouchableOpacity onPress={() => void refetchRecord()}>
          <Text style={[styles.helper, { color: colors.primary }]}>
            Your diary was sent. Tap to refresh it before adding more readings.
          </Text>
        </TouchableOpacity>
      ) : null}

      {config?.food_show_cold_food !== 'false' ? (
        <>
      <SectionTitle icon="box" title="Fridges and freezers" color={colors.foreground} />
      {coldFood.map((reading, index) => (
        <View key={reading.unit} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>{reading.unit}</Text>
          <View style={styles.inputRow}>
            <TemperatureInput
              label="AM °C"
              value={reading.tempAm}
              onChange={(value) => {
                markDirty();
                setColdFood((rows) => rows.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, tempAm: value } : row
                ));
              }}
            />
            <TemperatureInput
              label="PM °C"
              value={reading.tempPm}
              onChange={(value) => {
                markDirty();
                setColdFood((rows) => rows.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, tempPm: value } : row
                ));
              }}
            />
          </View>
          <TextInputField label="Corrective action taken (required if outside limits)" value={reading.correctiveAction}
            onChange={(value) => { markDirty(); setColdFood(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, correctiveAction: value } : row)); }} />
        </View>
      ))}
        </>
      ) : null}

      {config?.food_show_hot_holding !== 'false' ? (
        <>
      <SectionTitle icon="sun" title="Hot holding" color={colors.foreground} />
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <TextInputField label="Food item" value={hotHolding.item} onChange={(item) => { markDirty(); setHotHolding((row) => ({ ...row, item })); }} />
        <View style={styles.inputRow}>
          <TemperatureInput label="Core °C" value={hotHolding.coreTemp} onChange={(coreTemp) => { markDirty(); setHotHolding((row) => ({ ...row, coreTemp })); }} />
          <TextInputField label="Time" value={hotHolding.timeOfCheck} onChange={(timeOfCheck) => { markDirty(); setHotHolding((row) => ({ ...row, timeOfCheck })); }} placeholder="HH:mm" compact />
        </View>
        <Text style={[styles.helper, { color: colors.mutedForeground }]}>
          Target: {temperatureAssessment.rules ? temperatureRangeLabel(temperatureAssessment.rules.hotHolding) : 'Review numeric rules'}
        </Text>
      </View>
        </>
      ) : null}

      {config?.food_show_deliveries !== 'false' ? (
        <>
      <SectionTitle icon="truck" title="Delivery check" color={colors.foreground} />
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <TextInputField label="Supplier" value={delivery.supplier} onChange={(supplier) => { markDirty(); setDelivery((row) => ({ ...row, supplier })); }} />
        <TextInputField label="Items" value={delivery.items} onChange={(items) => { markDirty(); setDelivery((row) => ({ ...row, items })); }} />
        <View style={styles.inputRow}>
          <TemperatureInput label="Chilled °C" value={delivery.tempChilled} onChange={(tempChilled) => { markDirty(); setDelivery((row) => ({ ...row, tempChilled })); }} />
          <TemperatureInput label="Frozen °C" value={delivery.tempFrozen} onChange={(tempFrozen) => { markDirty(); setDelivery((row) => ({ ...row, tempFrozen })); }} />
        </View>
        <TextInputField label="Corrective action taken (required for failed deliveries)" value={delivery.correctiveActions}
          onChange={(value) => { markDirty(); setDelivery(row => ({ ...row, correctiveActions: value })); }} />
      </View>
        </>
      ) : null}

      {config?.food_show_hot_temperature !== 'false' ? (
        <CoreTemperatureCard title="Cooking" icon="thermometer" value={cooking} onChange={(value) => { markDirty(); setCooking(value); }}
          hold={temperatureAssessment.rules ? kitchenHoldRequirement(temperatureAssessment.rules, 'hotTemperature', cooking.item)?.limit ?? null : null} />
      ) : null}
      {config?.food_show_cooling !== 'false' ? (
        <CoreTemperatureCard title="Cooling" icon="wind" value={cooling} onChange={(value) => { markDirty(); setCooling(value); }} />
      ) : null}
      {config?.food_show_reheating !== 'false' ? (
        <CoreTemperatureCard
          title="Reheating"
          icon="rotate-cw"
          target={`Target: ${temperatureAssessment.rules ? temperatureRangeLabel(temperatureAssessment.rules.reheating) : 'Review numeric rules'}`}
          value={reheating}
          onChange={(value) => { markDirty(); setReheating(value); }}
        />
      ) : null}

      <SectionTitle icon="tool" title="Corrective actions" color={colors.foreground} />
      {temperatureAssessment.error ? <Text accessibilityRole="alert" style={{ color: colors.destructive }}>{temperatureAssessment.error}</Text> : null}
      {temperatureAssessment.failures.length ? <View style={[styles.notice, { borderColor: colors.destructive }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.destructive }}>Outside configured limits — record what you did for each failure. A manager must verify the follow-up evidence.</Text>
          {temperatureAssessment.failures.map((failure, index) => <Text key={index} style={{ color: colors.foreground }}>{failure.label} · {failure.field}: {kitchenFailureValue(failure)}</Text>)}
        </View>
      </View> : null}
      <TextInput
        style={[styles.textArea, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border }]}
        value={correctives}
        onChangeText={(value) => { markDirty(); setCorrectives(value); }}
        placeholder="Record any action taken for readings outside safe limits"
        placeholderTextColor={colors.mutedForeground}
        multiline
        textAlignVertical="top"
      />

      <TouchableOpacity
        testID="save-kitchen-temperatures"
        style={[styles.submit, { backgroundColor: colors.navy }, (!canSave || saveMutation.isPending) && styles.disabled]}
        onPress={() => saveMutation.mutate()}
        disabled={!canSave || saveMutation.isPending}
      >
        {saveMutation.isPending ? <ActivityIndicator color="#ffffff" /> : (
          <>
            <Feather name="check" size={18} color="#ffffff" />
            <Text style={styles.submitText}>{existingRecord ? 'Update today’s record' : 'Save today’s record'}</Text>
          </>
        )}
      </TouchableOpacity>
    </KeyboardAwareScrollViewCompat>
  );
}

function SectionTitle({ icon, title, color }: { icon: React.ComponentProps<typeof Feather>['name']; title: string; color: string }) {
  return (
    <View style={styles.sectionTitle}>
      <Feather name={icon} size={18} color={color} />
      <Text style={[styles.sectionTitleText, { color }]}>{title}</Text>
    </View>
  );
}

function CoreTemperatureCard({
  title,
  icon,
  target,
  value,
  onChange,
  hold,
}: {
  title: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  target?: string;
  /** Cooking: the minimum seconds this item must be held (null = no control,
   *  but the time can still be recorded); undefined hides the field. */
  hold?: number | null;
  value: CoreTemperatureReading;
  onChange: React.Dispatch<React.SetStateAction<CoreTemperatureReading>>;
}) {
  const colors = useColors();
  return (
    <>
      <SectionTitle icon={icon} title={title} color={colors.foreground} />
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <TextInputField label="Food item" value={value.item} onChange={(item) => onChange((row) => ({ ...row, item }))} />
        <TemperatureInput label="Core °C" value={value.coreTemp} onChange={(coreTemp) => onChange((row) => ({ ...row, coreTemp }))} />
        <View style={styles.inputRow}>
          <TextInputField label="Start time" value={value.timeStart} onChange={(timeStart) => onChange((row) => ({ ...row, timeStart }))} placeholder="HH:mm" compact />
          <TextInputField label="Finish time" value={value.timeFinish} onChange={(timeFinish) => onChange((row) => ({ ...row, timeFinish }))} placeholder="HH:mm" compact />
        </View>
        {hold !== undefined ? (
          <TextInputField label={hold === null ? 'Held at core temp (seconds)' : `Held at core temp (seconds, at least ${hold})`}
            value={value.holdSeconds ?? ''} onChange={(holdSeconds) => onChange((row) => ({ ...row, holdSeconds }))} placeholder="e.g. 30" compact numeric />
        ) : null}
        {target ? <Text style={[styles.helper, { color: colors.mutedForeground }]}>{target}</Text> : null}
      </View>
    </>
  );
}

function TemperatureInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <TextInputField label={label} value={value} onChange={onChange} placeholder="e.g. 4.5" compact numeric />;
}

function TextInputField({
  label,
  value,
  onChange,
  placeholder,
  compact = false,
  numeric = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
  numeric?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={compact ? styles.compactField : styles.field}>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <TextInput
        style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={numeric ? (Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'decimal-pad') : 'default'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  centerText: { textAlign: 'center' },
  retry: { borderRadius: 8, paddingHorizontal: 22, paddingVertical: 12 },
  retryText: { color: '#ffffff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  badge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 16 },
  badgeText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  notice: { flexDirection: 'row', gap: 10, borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 18 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  siteSection: { marginBottom: 16 },
  siteList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  siteChip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 },
  siteChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 10 },
  sectionTitleText: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  card: { borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 10 },
  cardTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', marginBottom: 10 },
  field: { marginBottom: 12 },
  compactField: { flex: 1, marginBottom: 12 },
  inputRow: { flexDirection: 'row', gap: 10 },
  label: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginBottom: 6 },
  input: { height: 44, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, fontSize: 15, fontFamily: 'Inter_400Regular' },
  helper: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  textArea: { minHeight: 96, borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 14, fontFamily: 'Inter_400Regular', marginBottom: 18 },
  submit: { height: 52, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  disabled: { opacity: 0.5 },
  submitText: { color: '#ffffff', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
});