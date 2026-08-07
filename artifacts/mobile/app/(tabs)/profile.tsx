import React from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api';

interface Site {
  id: number;
  name: string;
}

const ROLE_LABELS: Record<string, string> = {
  consultant: 'Consultant',
  client_admin: 'Admin',
  client_staff: 'Staff',
  client_viewer: 'Viewer',
};

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: string;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.infoRow,
        { borderBottomColor: colors.border },
      ]}
    >
      <Feather name={icon} size={16} color={colors.mutedForeground} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>
          {label}
        </Text>
        <Text style={[styles.infoValue, { color: colors.foreground }]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ['sites'],
    queryFn: () => apiFetch('/api/sites'),
  });

  const initials = user?.name
    ?.split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() ?? '?';

  function confirmLogout() {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning,
          );
          logout();
        },
      },
    ]);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingBottom: Platform.OS === 'web' ? 34 : 24,
      }}
    >
      {/* Navy header */}
      <View
        style={[
          styles.header,
          { backgroundColor: colors.navy, paddingTop: topPad + 16 },
        ]}
      >
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{user?.name ?? '—'}</Text>
        <View
          style={[
            styles.roleBadge,
            { backgroundColor: 'rgba(255,255,255,0.15)' },
          ]}
        >
          <Text style={styles.roleText}>
            {ROLE_LABELS[user?.role ?? ''] ?? user?.role ?? '—'}
          </Text>
        </View>
      </View>

      {/* Info card */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
          Account
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <InfoRow icon="mail" label="Email" value={user?.email ?? '—'} />
          <InfoRow
            icon="briefcase"
            label="Role"
            value={ROLE_LABELS[user?.role ?? ''] ?? user?.role ?? '—'}
          />
          {sites.length > 0 && (
            <InfoRow
              icon="map-pin"
              label={`Site${sites.length > 1 ? 's' : ''}`}
              value={
                sites.length === 1
                  ? sites[0].name
                  : `${sites.length} sites`
              }
            />
          )}
        </View>
      </View>

      {/* App info */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
          App
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
            <Feather name="info" size={16} color={colors.mutedForeground} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text
                style={[styles.infoLabel, { color: colors.mutedForeground }]}
              >
                Version
              </Text>
              <Text style={[styles.infoValue, { color: colors.foreground }]}>
                1.0.0
              </Text>
            </View>
          </View>
          <View style={[styles.infoRow, { borderBottomWidth: 0 }]}>
            <Feather name="shield" size={16} color={colors.mutedForeground} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text
                style={[styles.infoLabel, { color: colors.mutedForeground }]}
              >
                Platform
              </Text>
              <Text style={[styles.infoValue, { color: colors.foreground }]}>
                ComplyTrack by ALPS Consulting
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Sign out */}
      <View style={[styles.section, { marginTop: 8 }]}>
        <TouchableOpacity
          style={[
            styles.signOutBtn,
            { borderColor: colors.destructive },
          ]}
          onPress={confirmLogout}
        >
          <Feather name="log-out" size={18} color={colors.destructive} />
          <Text style={[styles.signOutText, { color: colors.destructive }]}>
            Sign out
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 28,
    gap: 10,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  avatarText: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
  },
  name: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    color: '#ffffff',
  },
  roleBadge: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
  },
  roleText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: 'rgba(255,255,255,0.85)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  card: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
  },
  infoLabel: { fontSize: 11, fontFamily: 'Inter_400Regular', marginBottom: 2 },
  infoValue: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 14,
  },
  signOutText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
