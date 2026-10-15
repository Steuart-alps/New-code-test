/**
 * Allergen records (KitchenTrack), read only: search dishes and products,
 * filter by site and open the full 14-allergen matrix for one dish. Mirrors
 * the website's Allergens page; adding, editing and the change log stay on the
 * website. The last loaded list is kept on the phone for use without signal.
 */
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { useCachedRegister } from '@/hooks/useCachedRegister';
import {
  Badge, DetailModal, Field, InfoNote, ListCard, RegisterFilters, RegisterHeader, RegisterStatus, Section, registerStyles,
} from '@/components/register-ui';
import {
  ALLERGEN_INFO,
  PPDS_BADGE,
  PPDS_NOTE,
  allergenMatrix,
  allergenReviewedText,
  allergenShortNames,
  filterAllergens,
  fmtDate,
  lastUpdatedText,
  siteName,
  type AllergenItem,
  type Site,
} from '@/components/registers-logic';

export default function AllergensScreen() {
  const colors = useColors();
  const { hasService } = useAuth();
  const enabled = hasService('kitchentrack');
  const [query, setQuery] = useState('');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [selected, setSelected] = useState<AllergenItem | null>(null);

  const sites = useCachedRegister<Site>('sites', ['register-sites'], '/api/sites', enabled);
  const list = useCachedRegister<AllergenItem>('allergens', ['register-allergens'], '/api/registers/allergens', enabled);
  const siteRows = sites.data ?? [];
  const items = list.data ?? [];
  const visible = useMemo(() => filterAllergens(items, siteId, query), [items, siteId, query]);
  const error = list.data ? null : list.query.error ? (list.query.error as Error).message || 'Could not load the register' : null;

  if (!enabled) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <RegisterHeader title="Allergen records" subtitle="Part of KitchenTrack" testID="allergens" />
        <Text style={[registerStyles.empty, { color: colors.mutedForeground }]}>KitchenTrack is not enabled for this account.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={list.query.isRefetching} onRefresh={() => { void sites.query.refetch(); void list.query.refetch(); }} />}
      >
        <RegisterHeader title="Allergen records" subtitle="The 14 regulated allergens for each dish or product, by site" testID="allergens" />
        <View style={registerStyles.content}>
          <InfoNote text={ALLERGEN_INFO} />
          <RegisterFilters
            query={query} onQuery={setQuery} placeholder="Search dishes…"
            sites={siteRows} siteId={siteId} onSite={setSiteId} testID="allergens"
          />
          <RegisterStatus
            loading={list.query.isFetching && !list.query.data}
            error={error}
            savedAt={list.fromCache ? list.savedAt : null}
            onRetry={() => { void sites.query.refetch(); void list.query.refetch(); }}
          />
          {list.data && visible.length === 0 && (
            <Text testID="allergens-empty" style={[registerStyles.empty, { color: colors.mutedForeground }]}>
              {items.length === 0 ? 'No dishes or products recorded yet.' : 'No records match this filter.'}
            </Text>
          )}
          {visible.map((item) => {
            const names = allergenShortNames(item);
            return (
              <ListCard
                key={item.id}
                testID={`allergen-${item.id}`}
                accessibilityLabel={`${item.name}, contains ${names.length ? names.join(', ') : 'none of the 14 allergens'}`}
                onPress={() => setSelected(item)}
              >
                <Text style={[registerStyles.cardTitle, { color: colors.foreground }]}>{item.name}</Text>
                <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>{siteName(siteRows, item.siteId)}</Text>
                <View style={registerStyles.badges}>
                  {names.length === 0
                    ? <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>None of the 14 allergens</Text>
                    : names.map((name) => <Badge key={name} text={name} tone="danger" />)}
                  {item.ppds && <Badge text={PPDS_BADGE} tone="warning" />}
                </View>
                <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>{allergenReviewedText(item)}</Text>
              </ListCard>
            );
          })}
        </View>
      </ScrollView>

      <DetailModal
        visible={selected !== null}
        title={selected?.name ?? ''}
        subtitle={selected ? siteName(siteRows, selected.siteId) : ''}
        onClose={() => setSelected(null)}
        testID="allergen-detail"
      >
        {selected && (
          <>
            {list.fromCache && list.savedAt && <InfoNote tone="warning" icon="wifi-off" text={lastUpdatedText(list.savedAt)} />}
            {selected.ppds && <InfoNote tone="warning" text={PPDS_NOTE} />}
            {selected.description ? (
              <Section title="Description or recipe notes">
                <Text style={[registerStyles.body, { color: colors.foreground }]}>{selected.description}</Text>
              </Section>
            ) : null}
            <Section title="Contains">
              <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>
                A tick means the dish or product contains that allergen as an ingredient.
              </Text>
              {allergenMatrix(selected).map((row) => (
                <View
                  key={row.key}
                  testID={`allergen-row-${row.key}`}
                  accessible
                  accessibilityLabel={`${row.label}: ${row.contains ? 'contains' : 'not an ingredient'}`}
                  style={[styles.row, { borderColor: colors.border, backgroundColor: row.contains ? '#fef2f2' : 'transparent' }]}
                >
                  <Text style={[styles.rowLabel, { color: row.contains ? '#b91c1c' : colors.foreground, fontFamily: row.contains ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>
                    {row.label}
                  </Text>
                  {row.contains
                    ? <View style={styles.yes}><Feather name="check" size={14} color="#b91c1c" /><Text style={styles.yesText}>Contains</Text></View>
                    : <Text style={[styles.noText, { color: colors.mutedForeground }]}>No</Text>}
                </View>
              ))}
            </Section>
            <Section title="Review">
              <Field label="Last reviewed" value={selected.lastReviewedAt ? fmtDate(selected.lastReviewedAt) : null} />
              <Field label="Reviewed by" value={selected.reviewedBy} />
            </Section>
          </>
        )}
      </DetailModal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderTopWidth: 1, paddingVertical: 9, paddingHorizontal: 6 },
  rowLabel: { flex: 1, fontSize: 14 },
  yes: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  yesText: { fontSize: 13, fontFamily: 'Inter_700Bold', color: '#b91c1c' },
  noText: { fontSize: 13, fontFamily: 'Inter_400Regular' },
});
