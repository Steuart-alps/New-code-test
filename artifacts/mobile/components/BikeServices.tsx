import React, { useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { OutboxEntries } from './OutboxEntries';
import { AquaChoiceRow, AquaEmptyState, AquaField, AquaInput, aquaUiStyles as styles } from './aqua-track-ui';
import {
  SERVICE_TYPES,
  autoNextService,
  bikeTitle,
  buildServicePayload,
  dayOf,
  localDate,
  serviceTypeLabel,
  type Bike,
  type BikeService,
  type BikeServiceDraft,
} from './bike-track-logic';

const emptyDraft = (): BikeServiceDraft => {
  const serviceDate = localDate();
  return {
    bikeId: null, serviceDate, serviceType: 'annual', nextServiceDate: autoNextService(serviceDate, 'annual'),
    cost: '', servicedBy: '', notes: '',
  };
};

/**
 * Bike services for the chosen site's fleet: the website's "Log a service"
 * form, sent through the device outbox, and recent services.
 */
export function BikeServices({
  bikes,
  canUseSite,
  onFormOpenChange,
}: {
  bikes: Bike[];
  canUseSite: boolean;
  onFormOpenChange: (open: boolean) => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const servicesQuery = useQuery<BikeService[]>({
    queryKey: ['bike-services', user?.clientId],
    queryFn: () => apiFetch('/api/bike-track/services'),
  });
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<BikeServiceDraft>(emptyDraft);
  // The next service date follows the date and type until it is edited.
  const [nextEdited, setNextEdited] = useState(false);

  function update(change: Partial<BikeServiceDraft>) {
    setDraft((current) => {
      const next = { ...current, ...change };
      if (!nextEdited && ('serviceDate' in change || 'serviceType' in change)) {
        next.nextServiceDate = autoNextService(next.serviceDate, next.serviceType);
      }
      return next;
    });
  }

  const outbox = useRecordOutbox('bike-service');
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => {
      const bike = bikes.find((row) => row.id === payload.bikeId);
      return outbox.send(payload, `Service · ${bike?.ref ?? 'Bike'} · ${serviceTypeLabel(String(payload.serviceType))} · ${String(payload.serviceDate)}`);
    },
    onSuccess: (outcome) => {
      if (outcome.state === 'rejected') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Unable to log service', outcome.error);
        return;
      }
      setShowForm(false);
      onFormOpenChange(false);
      setDraft(emptyDraft());
      setNextEdited(false);
      if (outcome.state === 'queued') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert('Saved on this device', 'No connection right now. The service is saved on this device and will be sent automatically when you are back online.');
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void queryClient.invalidateQueries({ queryKey: ['bike-services'] });
      void queryClient.invalidateQueries({ queryKey: ['bike-services-latest'] });
      Alert.alert('Logged', 'Service recorded successfully.');
    },
    onError: (error: Error) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert('Unable to log service', error.message);
    },
  });

  function submit() {
    if (!canUseSite) {
      Alert.alert('Select a site', 'Choose a site before logging a service.');
      return;
    }
    const built = buildServicePayload(draft);
    if (!built.ok) {
      Alert.alert(built.title, built.message);
      return;
    }
    mutation.mutate(built.payload);
  }

  function toggleForm() {
    if (mutation.isPending) return;
    if (!showForm && !canUseSite) return;
    const next = !showForm;
    setShowForm(next);
    onFormOpenChange(next);
    setDraft(emptyDraft());
    setNextEdited(false);
  }

  const bikeIds = new Set(bikes.map((bike) => bike.id));
  const rows = (servicesQuery.data ?? []).filter((service) => bikeIds.has(service.bike_id)).slice(0, 15);
  const pending = mutation.isPending;

  return (
    <View>
      <OutboxEntries entries={outbox.entries} readError={outbox.readError} />
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: colors.navy }, (pending || (!showForm && !canUseSite)) && styles.disabled]}
        onPress={toggleForm}
        disabled={pending || (!showForm && !canUseSite)}
        testID="bike-service-toggle-form"
      >
        <Feather name={showForm ? 'x' : 'plus'} size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>{showForm ? 'Cancel' : 'Log a service'}</Text>
      </TouchableOpacity>

      {showForm && (
        <View style={{ paddingTop: 16 }}>
          {bikes.length ? (
            <AquaChoiceRow
              label="Bike"
              options={bikes.map((bike) => ({ value: String(bike.id), label: bikeTitle(bike) }))}
              value={draft.bikeId === null ? '' : String(draft.bikeId)}
              onChange={(value) => update({ bikeId: Number(value) })}
              colors={colors}
              testIDPrefix="bike-service-bike"
              disabled={pending}
            />
          ) : (
            <AquaEmptyState colors={colors} message="No bikes at this site. Add bikes on the website." />
          )}
          <AquaChoiceRow
            label="Service type"
            options={SERVICE_TYPES.map((type) => ({ value: type.value, label: type.label }))}
            value={draft.serviceType}
            onChange={(serviceType) => update({ serviceType })}
            colors={colors}
            testIDPrefix="bike-service-type"
            disabled={pending}
          />
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Service date">
                <AquaInput value={draft.serviceDate} onChangeText={(serviceDate) => update({ serviceDate })} placeholder="YYYY-MM-DD"
                  keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID="bike-service-date" />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Next service due">
                <AquaInput value={draft.nextServiceDate} onChangeText={(nextServiceDate) => { setNextEdited(true); update({ nextServiceDate }); }}
                  placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" colors={colors} disabled={pending} testID="bike-service-next" />
              </AquaField>
            </View>
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <AquaField label="Cost (£)">
                <AquaInput value={draft.cost} onChangeText={(cost) => update({ cost })} placeholder="e.g. 45.00"
                  keyboardType="decimal-pad" colors={colors} disabled={pending} testID="bike-service-cost" />
              </AquaField>
            </View>
            <View style={{ flex: 1 }}>
              <AquaField label="Serviced by">
                <AquaInput value={draft.servicedBy} onChangeText={(servicedBy) => update({ servicedBy })} placeholder="Technician or company"
                  colors={colors} disabled={pending} testID="bike-service-by" />
              </AquaField>
            </View>
          </View>
          <AquaField label="Notes">
            <AquaInput value={draft.notes} onChangeText={(notes) => update({ notes })} placeholder="Work carried out, parts replaced, observations…"
              multiline colors={colors} disabled={pending} testID="bike-service-notes" />
          </AquaField>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.navy }, (pending || !canUseSite) && styles.disabled]}
            onPress={submit}
            disabled={pending || !canUseSite}
            testID="bike-service-submit"
          >
            {pending ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="check" size={18} color={colors.primaryForeground} />}
            <Text style={styles.primaryButtonText}>{pending ? 'Saving…' : 'Log service'}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ marginTop: 16 }}>
        {!canUseSite ? <AquaEmptyState colors={colors} message="Select a site to view services." /> :
          servicesQuery.isLoading ? <ActivityIndicator color={colors.primary} /> :
          servicesQuery.isError ? (
            <AquaEmptyState colors={colors} error message={servicesQuery.error instanceof Error ? servicesQuery.error.message : 'Services could not be loaded.'}>
              <TouchableOpacity onPress={() => void servicesQuery.refetch()}><Text style={{ color: colors.primary }}>Try again</Text></TouchableOpacity>
            </AquaEmptyState>
          ) : rows.length ? rows.map((service) => (
            <View key={service.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`bike-service-${service.id}`}>
              <View style={[styles.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{service.bike_ref}{service.bike_name ? ` — ${service.bike_name}` : ''}</Text>
                <View style={[styles.badge, { backgroundColor: colors.primary + '1a' }]}>
                  <Text style={[styles.badgeText, { color: colors.primary }]}>{serviceTypeLabel(service.service_type)}</Text>
                </View>
              </View>
              <Text style={[styles.detail, { color: colors.foreground }]}>
                {dayOf(service.service_date)}{service.serviced_by ? ` · ${service.serviced_by}` : ''}
              </Text>
              {service.next_service_date ? (
                <Text style={[styles.detail, { color: colors.mutedForeground }]}>Next due {dayOf(service.next_service_date)}</Text>
              ) : null}
              {service.notes ? <Text style={[styles.detail, { color: colors.mutedForeground }]} numberOfLines={2}>{service.notes}</Text> : null}
            </View>
          )) : (
            <AquaEmptyState colors={colors} message="No services recorded for this site's bikes." />
          )}
      </View>
    </View>
  );
}
