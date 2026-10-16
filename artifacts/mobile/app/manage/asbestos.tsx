/**
 * Asbestos register, read only: one record per site with its survey,
 * management plan review and the known asbestos-containing materials
 * (location, material, condition, priority and risk score, action, last
 * inspected), behind a clear "do not disturb" warning. Survey reports open
 * online. Mirrors the website's asbestos register; adding and editing stay on
 * the website. The last loaded list is kept on the phone for use without
 * signal.
 */
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useCachedRegister } from '@/hooks/useCachedRegister';
import {
  Badge, DetailModal, DocumentButton, Field, InfoNote, ListCard, RegisterFilters, RegisterHeader, RegisterStatus, Section,
  registerStyles, useOpenDocument,
} from '@/components/register-ui';
import {
  ACTION_LABELS,
  ASBESTOS_INFO,
  ASBESTOS_SUSPECT,
  ASBESTOS_WARNING,
  BUILT_LABELS,
  CONDITION_LABELS,
  filterAsbestos,
  fmtDate,
  highestPriority,
  lastUpdatedText,
  planReviewText,
  priorityText,
  siteName,
  sortEntriesForSite,
  surveyText,
  type AsbestosRecord,
  type Site,
} from '@/components/registers-logic';

const PRIORITY_TONE: Record<string, 'success' | 'warning' | 'danger'> = { low: 'success', medium: 'warning', high: 'danger' };
const CONDITION_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { good: 'neutral', low_damage: 'neutral', medium_damage: 'warning', high_damage: 'danger' };

export default function AsbestosScreen() {
  const colors = useColors();
  const [query, setQuery] = useState('');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const documents = useOpenDocument();

  const sites = useCachedRegister<Site>('sites', ['register-sites'], '/api/sites');
  const list = useCachedRegister<AsbestosRecord>('asbestos', ['register-asbestos'], '/api/registers/asbestos');
  const siteRows = sites.data ?? [];
  const records = list.data ?? [];
  const visible = useMemo(() => filterAsbestos(records, siteRows, siteId, query), [records, siteRows, siteId, query]);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const error = list.data ? null : list.query.error ? (list.query.error as Error).message || 'Could not load the register' : null;
  const refresh = () => { void sites.query.refetch(); void list.query.refetch(); };
  const sitesWithoutRecord = list.data && sites.data
    ? siteRows.filter((site) => !records.some((record) => record.siteId === site.id) && (siteId === null || site.id === siteId))
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={list.query.isRefetching} onRefresh={refresh} />}
      >
        <RegisterHeader title="Asbestos register" subtitle="Surveys, known asbestos-containing materials and the management plan for each site" testID="asbestos" />
        <View style={registerStyles.content}>
          <InfoNote tone="danger" text={ASBESTOS_WARNING} />
          <RegisterFilters
            query={query} onQuery={setQuery} placeholder="Search locations or materials…"
            sites={siteRows} siteId={siteId} onSite={setSiteId} testID="asbestos"
          />
          <RegisterStatus
            loading={list.query.isFetching && !list.query.data}
            error={error}
            savedAt={list.fromCache ? list.savedAt : null}
            onRetry={refresh}
          />
          {sitesWithoutRecord.length > 0 && !query && (
            <InfoNote tone="warning" text={`No asbestos record yet for: ${sitesWithoutRecord.map((site) => site.name).join(', ')}`} />
          )}
          {list.data && visible.length === 0 && (
            <Text testID="asbestos-empty" style={[registerStyles.empty, { color: colors.mutedForeground }]}>
              {records.length === 0 ? 'No asbestos records yet.' : 'No records match this search.'}
            </Text>
          )}
          {visible.map((record) => {
            const top = highestPriority(record);
            const plan = planReviewText(record);
            const name = siteName(siteRows, record.siteId);
            return (
              <ListCard
                key={record.id}
                testID={`asbestos-${record.id}`}
                accessibilityLabel={`${name}, ${record.entries.length} asbestos-containing materials`}
                onPress={() => setSelectedId(record.id)}
                highlight={top === 'high' || record.planReviewOverdue ? '#fca5a5' : undefined}
              >
                <Text style={[registerStyles.cardTitle, { color: colors.foreground }]}>{name}</Text>
                <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>{surveyText(record, record.noAsbestosExpected)}</Text>
                <View style={registerStyles.badges}>
                  {record.noAsbestosExpected
                    ? <Badge text="No asbestos expected (post-2000 build)" tone="success" />
                    : <Badge text={`Asbestos-containing materials: ${record.entries.length}`} tone={record.entries.length ? 'warning' : 'neutral'} />}
                  {top && <Badge text={`Highest: ${priorityText({ priority: top, riskScore: null })}`} tone={PRIORITY_TONE[top] ?? 'neutral'} />}
                  {plan && <Badge text={plan} tone={record.planReviewOverdue ? 'danger' : 'neutral'} />}
                </View>
              </ListCard>
            );
          })}
          <InfoNote text={ASBESTOS_INFO} />
        </View>
      </ScrollView>

      <DetailModal
        visible={selected !== null}
        title={selected ? siteName(siteRows, selected.siteId) : ''}
        subtitle="Asbestos register"
        onClose={() => setSelectedId(null)}
        testID="asbestos-detail"
      >
        {selected && (() => {
          const plan = planReviewText(selected);
          const reportPath = `/api/registers/asbestos/${selected.id}/report-url`;
          const entries = sortEntriesForSite(selected.entries);
          return (
            <>
              <InfoNote tone="danger" icon="slash" text={`DO NOT DISTURB. ${ASBESTOS_WARNING}`} />
              <InfoNote tone="warning" text={ASBESTOS_SUSPECT} />
              {list.fromCache && list.savedAt && <InfoNote tone="warning" icon="wifi-off" text={lastUpdatedText(list.savedAt)} />}
              <Section title={`Asbestos-containing materials (${entries.length})`}>
                {entries.length === 0 ? (
                  <Text style={[registerStyles.body, { color: colors.mutedForeground }]}>No materials recorded.</Text>
                ) : entries.map((entry) => (
                  <View key={entry.id} testID={`asbestos-entry-${entry.id}`} style={[styles.entry, { borderColor: entry.priority === 'high' ? '#fca5a5' : colors.border }]}>
                    <Text style={[registerStyles.cardTitle, { color: colors.foreground }]}>{entry.location}</Text>
                    <Field label="Material" value={entry.material} />
                    <View style={registerStyles.badges}>
                      <Badge text={`Condition: ${CONDITION_LABELS[entry.condition] ?? entry.condition}`} tone={CONDITION_TONE[entry.condition] ?? 'neutral'} />
                      <Badge text={priorityText(entry)} tone={PRIORITY_TONE[entry.priority] ?? 'neutral'} />
                      <Badge text={ACTION_LABELS[entry.action] ?? entry.action} />
                    </View>
                    <Field label="Last inspected" value={entry.lastInspected ? fmtDate(entry.lastInspected) : null} />
                    {entry.notes ? <Text style={[registerStyles.body, { color: colors.mutedForeground }]}>{entry.notes}</Text> : null}
                  </View>
                ))}
              </Section>
              <Section title="Survey">
                <Field label="Latest survey" value={surveyText(selected, selected.noAsbestosExpected)} />
                <Field label="Building built before 2000?" value={BUILT_LABELS[selected.builtBefore2000] ?? selected.builtBefore2000} />
                {selected.noAsbestosExpected && <Badge text="No asbestos expected (post-2000 build)" tone="success" />}
                {plan && <Field label="Management plan review" value={plan} />}
                {selected.reportObjectPath ? (
                  <DocumentButton
                    testID="asbestos-open-report"
                    label="Survey report"
                    busy={documents.opening === reportPath}
                    onPress={() => void documents.open(reportPath, 'Could not open the survey report')}
                  />
                ) : null}
              </Section>
              {selected.notes ? (
                <Section title="Notes">
                  <Text style={[registerStyles.body, { color: colors.foreground }]}>{selected.notes}</Text>
                </Section>
              ) : null}
              {(selected.surveyHistory?.length ?? 0) > 0 && (
                <Section title="Previous surveys">
                  {selected.surveyHistory!.map((survey) => {
                    const path = `/api/registers/asbestos/${selected.id}/history/${survey.id}/report-url`;
                    return (
                      <View key={survey.id} style={{ gap: 6 }}>
                        <Text style={[registerStyles.cardSub, { color: colors.mutedForeground }]}>
                          {`${survey.surveyType ? surveyText(survey) : 'Survey'}${!survey.surveyType && survey.surveyDate ? ` on ${fmtDate(survey.surveyDate)}` : ''} (replaced ${fmtDate(survey.replacedAt)})`}
                        </Text>
                        <DocumentButton
                          testID={`asbestos-open-history-${survey.id}`}
                          label={survey.reportFileName ?? 'Report'}
                          busy={documents.opening === path}
                          onPress={() => void documents.open(path, 'Could not open the survey report')}
                        />
                      </View>
                    );
                  })}
                </Section>
              )}
            </>
          );
        })()}
      </DetailModal>
    </View>
  );
}

const styles = StyleSheet.create({
  entry: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 },
});
