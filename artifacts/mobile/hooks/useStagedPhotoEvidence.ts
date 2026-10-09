import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  classifyStagedCreateError,
  evidenceReady,
  parsePhotoRequirements,
  requirementFor,
  splitExpiredPhotos,
  stagedCreateErrorMessage,
  stagedPhotoScope,
  stageRequiredPhoto,
  STAGED_PHOTO_MAX,
  withPhotoUploadIds,
  type StagePhotoDeps,
  type StagedPhoto,
} from '@/components/staged-photo-logic';

export type StagedPhotoEntityType =
  | 'green_pre_use_check'
  | 'green_service'
  | 'green_defect'
  | 'swim_session'
  | 'swim_surveillance_check'
  | 'swim_first_aid_check'
  | 'swim_incident';

const stagingDeps: StagePhotoDeps = {
  apiPost: (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
  // Object storage receives the signed URL, the file bytes and Content-Type
  // only. No Authorization header and no cookies are sent to storage.
  putObject: async (uploadUrl, headers, uri) => {
    const response = await expoFetch(uploadUrl, {
      method: 'PUT',
      headers,
      body: new File(uri),
      credentials: 'omit',
    });
    return { ok: response.ok, status: response.status };
  },
};

/**
 * Required-photo evidence for a new GreenTrack or SwimTrack record. Receipts
 * are scoped to the signed-in user, their client and the record type, and are
 * discarded whenever that scope changes.
 */
export function useStagedPhotoEvidence(entityType: StagedPhotoEntityType, enabled: boolean) {
  const { user } = useAuth();
  const scope = enabled ? stagedPhotoScope(user?.id, user?.clientId, entityType) : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [state, setState] = useState<{ scope: string | null; photos: StagedPhoto[] }>({ scope, photos: [] });
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{ scope: string | null; message: string } | null>(null);

  const requirementsQuery = useQuery({
    queryKey: ['photo-requirements', user?.id ?? null, user?.clientId ?? null],
    queryFn: async () => parsePhotoRequirements(await apiFetch('/api/photos/requirements')),
    enabled: scope !== null,
    retry: 1,
  });

  const photos = state.scope === scope && scope !== null ? state.photos : [];
  const uploading = scope !== null && busyScope === scope;
  const { required, minimum } = requirementFor(requirementsQuery.data, entityType);

  const reset = useCallback(() => {
    setState({ scope: scopeRef.current, photos: [] });
    setUploadError(null);
  }, []);

  // Identity or record-type changes drop receipts from the previous scope.
  useEffect(() => {
    setState((previous) => (previous.scope === scope ? previous : { scope, photos: [] }));
    setUploadError(null);
  }, [scope]);

  async function addPhoto(source: 'camera' | 'library') {
    const currentScope = scope;
    if (currentScope === null || uploading || photos.length >= STAGED_PHOTO_MAX) return;
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      const action = permission.canAskAgain || Platform.OS === 'web'
        ? undefined
        : { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => undefined); } };
      Alert.alert(
        'Permission needed',
        `Allow access to your ${source === 'camera' ? 'camera' : 'photo library'} to attach evidence.`,
        action ? [{ text: 'Cancel', style: 'cancel' }, action] : [{ text: 'OK' }],
      );
      return;
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    if (scopeRef.current !== currentScope) return;
    setBusyScope(currentScope);
    setUploadError(null);
    try {
      const staged = await stageRequiredPhoto(stagingDeps, entityType, result.assets[0]);
      if (scopeRef.current === currentScope) {
        setState((previous) => ({
          scope: currentScope,
          photos: [...(previous.scope === currentScope ? previous.photos : []), staged].slice(0, STAGED_PHOTO_MAX),
        }));
      }
    } catch (error) {
      if (scopeRef.current === currentScope) {
        setUploadError({
          scope: currentScope,
          message: error instanceof Error && error.message ? error.message : 'Photo upload failed. Please retry.',
        });
      }
    } finally {
      setBusyScope((current) => (current === currentScope ? null : current));
    }
  }

  function removePhoto(id: string) {
    setState((previous) => ({
      scope,
      photos: previous.scope === scope ? previous.photos.filter((photo) => photo.id !== id) : [],
    }));
  }

  /**
   * Build the create payload, dropping receipts that are about to expire.
   * Returns null (and keeps the draft) when evidence must be re-added first.
   */
  function preparePayload<T extends Record<string, unknown>>(payload: T): (T & { photoUploadIds?: string[] }) | null {
    const { fresh, expired } = splitExpiredPhotos(photos, Date.now());
    if (expired.length) {
      setState({ scope, photos: fresh });
      if (required && fresh.length < minimum) {
        Alert.alert(
          'Photos expired',
          'Some verified photos were added more than 28 minutes ago and have expired. Add them again before saving. Your answers have been kept.',
        );
        return null;
      }
    }
    return withPhotoUploadIds(payload, fresh);
  }

  /** Map a failed create to a message; keeps the draft and valid photos. */
  function handleCreateError(error: unknown, fallback: string): string {
    const kind = classifyStagedCreateError(error);
    if (kind === 'receipts-invalid') setState({ scope, photos: [] });
    if (kind === 'requirement' || kind === 'receipts-invalid') void requirementsQuery.refetch();
    const serverMessage = error instanceof Error && error.message ? error.message : fallback;
    return stagedCreateErrorMessage(kind, kind === 'other' || kind === 'requirement' ? serverMessage : fallback);
  }

  const loadFailed = requirementsQuery.isError;
  return {
    enabled: scope !== null,
    required,
    minimum,
    loading: scope !== null && requirementsQuery.isPending,
    loadFailed,
    retryRequirements: () => { void requirementsQuery.refetch(); },
    uploading,
    photos,
    uploadError: uploadError?.scope === scope ? uploadError.message : null,
    ready: evidenceReady({
      enabled: scope !== null,
      loading: requirementsQuery.isPending,
      loadFailed,
      uploading,
      required,
      minimum,
      photoCount: photos.length,
    }),
    addPhoto,
    removePhoto,
    reset,
    preparePayload,
    handleCreateError,
  };
}

export type StagedPhotoEvidence = ReturnType<typeof useStagedPhotoEvidence>;
