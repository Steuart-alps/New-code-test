/**
 * COSHH register, read only: search substances, filter by site, and open one
 * substance's hazards, where it is used, controls and PPE, assessment dates
 * and its safety data sheet (online). Mirrors the website's COSHH register;
 * adding, editing and uploads stay on the website. The last loaded list is
 * kept on the phone for use without signal.
 */
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useCachedRegister } from '@/hooks/useCachedRegister';
import {
  Badge, DetailModal, DocumentButton, Field, InfoNote, ListCard, RegisterFilters, RegisterHeader, RegisterStatus, Section,
  registerStyles, useOpenDocument,
} from '@/components/register-ui';
import { localIsoDate } from '@/components/date-stepper-logic';
import {
  COSHH_INFO,
  COSHH_SDS_NOTE,
  coshhReview,
  filterCoshh,
  fmtDate,
  lastUpdatedText,
  pictogramLabels,
  siteName,
  type CoshhSubstance,
  type ReviewState,
  type Site,
} from '@/components/registers-logic';

const REVIEW_TONE: Record<ReviewState, 'danger' | 'warning' | 'success' | 'neutral'> = {
  overdue: 'danger', soon: 'warning', ok: 'success', none: 'neutral', withdrawn: 'neutral',
};

export default function CoshhScreen() {
  const colors = useColors();
  const [query, setQuery] = useState('');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [selected, setSelected] = useState<CoshhSubstance | null>(null);
  const documents = useOpenDocument();
  const today = localIsoDate();

  const sites = useCachedRegister<Site>('sites', ['register-sites'], '/api/sites');
  const list = useCachedRegister<CoshhSubstance>('coshh', ['register-coshh'], '/api/registers/coshh');
  const siteRows = sites.data ?? [];
  const items = list.data ?? [];
  const visible = useMemo(() => filterCoshh(items, siteId, query, showWithdrawn), [items, siteId, query, showWithdrawn]);
  const error = list.data ? null : list.query.error ? (list.query.error as Error).message || 'Could not load the register' : null;
  const refresh = () => { void sites.query.refetch(); void list.query.refetch(); };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={list.query.isRefetching} onRefresh={refresh} />}
      >
        <RegisterHeader title="COSHH register" subtitle="Hazardous substances used at each site, with safety data sheets and assessments" testID="coshh" />
        <View style={registerStyles.content}>
          <InfoNote text={COSHH_INFO} />
          <RegisterFilters
            query={query} onQuery={setQuery} placeholder="Search substances…"
            sites={siteRows} siteId={siteId} onSite={setSiteId} testID="coshh"
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[registerStyles.cardSub, { color: colors.foreground }]}>Show withdrawn</Text>
            <Switch testID="coshh-show-withdrawn" accessibilityLabel="Show withdrawn" value={showWithdrawn} onValueChange={setShowWithdrawn} />
          </View>
          <RegisterStatus
            loading={list.query.isFetching && !list.query.data}
            error={error}
            savedAt={list.fromCache ? list.savedAt : null}
            onRetry={refresh}
          />
          {list.data && visible.length === 0 && (
            <Text testID="coshh-empty" style={[registerStyles.empty, { color: colors.mutedForeground }]}>
              {items.length === 0 ? 'No substances recorded yet.' : 'No substances match this filter.'}
            </Text>
          )}
          {visible.map((item) => {
            const review = coshhReview(item, today);
            const hazards = pictogramLabels(item.hazardPictograms);
            return (
              <ListCard
                key={item.id}
                testID={`coshh-${item.id}`}
                accessibilityLabel={`${item.productName}, ${hazards.length ? hazards.map((h) => h.label).join(', ') : 'no hazards recorded'}`}
                onPress={() => setSelected(item)}
                highlight={item.reviewOverdue ? '#fca5a5' : undefined}
              >
                <Text style={[registerStyles.cardTitle, { color: colors.foreground }]}>{item.productName}</Text>
                <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>
                  {[item.supplier, siteName(siteRows, item.siteId)].filter(Boolean).join(' · ')}
                </Text>
                <View style={registerStyles.badges}>
                  {hazards.length === 0
                    ? <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>No hazards recorded</Text>
                    : hazards.map((h) => <Badge key={h.key} text={h.label} tone="hazard" />)}
                </View>
                <View style={registerStyles.badges}>
                  <Badge text={review.text} tone={REVIEW_TONE[review.state]} />
                  {!item.sdsObjectPath && item.status === 'in_use' && <Badge text="No safety data sheet" tone="warning" />}
                </View>
              </ListCard>
            );
          })}
        </View>
      </ScrollView>

      <DetailModal
        visible={selected !== null}
        title={selected?.productName ?? ''}
        subtitle={selected ? [selected.supplier, siteName(siteRows, selected.siteId)].filter(Boolean).join(' · ') : ''}
        onClose={() => setSelected(null)}
        testID="coshh-detail"
      >
        {selected && (() => {
          const review = coshhReview(selected, today);
          const hazards = pictogramLabels(selected.hazardPictograms);
          const sdsPath = `/api/registers/coshh/${selected.id}/sds-url`;
          return (
            <>
              {list.fromCache && list.savedAt && <InfoNote tone="warning" icon="wifi-off" text={lastUpdatedText(list.savedAt)} />}
              <View style={registerStyles.badges}>
                <Badge text={selected.status === 'withdrawn' ? 'Withdrawn' : 'In use'} tone={selected.status === 'withdrawn' ? 'neutral' : 'success'} />
                <Badge text={review.text} tone={REVIEW_TONE[review.state]} />
              </View>
              <Section title="Hazards">
                {hazards.length === 0
                  ? <Text style={[registerStyles.body, { color: colors.mutedForeground }]}>None recorded</Text>
                  : hazards.map((h) => (
                    <View key={h.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Badge text={h.code} tone="hazard" />
                      <Text style={[registerStyles.body, { color: colors.foreground, flex: 1 }]}>{h.label}</Text>
                    </View>
                  ))}
              </Section>
              <Section title="Where used">
                <Text style={[registerStyles.body, { color: selected.whereUsed ? colors.foreground : colors.mutedForeground }]}>
                  {selected.whereUsed || 'Not recorded'}
                </Text>
              </Section>
              <Section title="Controls and PPE">
                <Text style={[registerStyles.body, { color: selected.controls ? colors.foreground : colors.mutedForeground }]}>
                  {selected.controls || 'Not recorded'}
                </Text>
              </Section>
              <Section title="Safety data sheet">
                <InfoNote text={COSHH_SDS_NOTE} />
                {selected.sdsObjectPath ? (
                  <DocumentButton
                    testID="coshh-open-sds"
                    label={`Open ${selected.sdsFileName ?? 'safety data sheet'}`}
                    busy={documents.opening === sdsPath}
                    onPress={() => void documents.open(sdsPath, 'Could not open the safety data sheet')}
                  />
                ) : (
                  <Text style={[registerStyles.body, { color: '#b45309' }]}>No safety data sheet attached</Text>
                )}
              </Section>
              <Section title="Assessment">
                <Field label="Assessment date" value={selected.assessmentDate ? fmtDate(selected.assessmentDate) : null} />
                <Field label="Review due" value={selected.reviewDue ? fmtDate(selected.reviewDue) : null} />
              </Section>
            </>
          );
        })()}
      </DetailModal>
    </View>
  );
}
