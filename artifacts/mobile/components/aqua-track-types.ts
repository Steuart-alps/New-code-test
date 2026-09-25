export interface Site {
  id: number;
  name: string;
}

export interface PoolCheck {
  id: number;
  check_date: string;
  check_time: string | null;
  check_type: string;
  ph_level: number | null;
  free_chlorine: number | null;
  water_temp_c: number | null;
  turbidity: string | null;
  result: string;
  notes: string | null;
  performed_by: string | null;
  site_name: string | null;
}

export interface SwimSession {
  id: number;
  session_date: string;
  session_type: string;
  open_time: string | null;
  close_time: string | null;
  lifeguard_name: string | null;
  max_bathers: number | null;
  bather_count_peak: number | null;
  pre_session_result: string;
  notes: string | null;
  result: string;
  site_name: string | null;
}

export type PoolCheckType = 'routine' | 'opening' | 'closing' | 'weekly';
export type PoolResult = 'pass' | 'fail';
export type Turbidity = 'clear' | 'slightly_hazy' | 'hazy' | 'cloudy';
export type SessionType =
  | 'public_swim'
  | 'lane_swim'
  | 'club_session'
  | 'lessons'
  | 'private_hire'
  | 'aquafit'
  | 'other';

export const POOL_CHECK_TYPES: { value: PoolCheckType; label: string }[] = [
  { value: 'routine', label: 'Routine' },
  { value: 'opening', label: 'Opening' },
  { value: 'closing', label: 'Closing' },
  { value: 'weekly', label: 'Weekly' },
];

export const POOL_RESULTS: { value: PoolResult; label: string }[] = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
];

export const TURBIDITY_OPTIONS: { value: Turbidity; label: string }[] = [
  { value: 'clear', label: 'Clear' },
  { value: 'slightly_hazy', label: 'Slightly hazy' },
  { value: 'hazy', label: 'Hazy' },
  { value: 'cloudy', label: 'Cloudy' },
];

export const SESSION_TYPES: { value: SessionType; label: string }[] = [
  { value: 'public_swim', label: 'Public swim' },
  { value: 'lane_swim', label: 'Lane swim' },
  { value: 'club_session', label: 'Club session' },
  { value: 'lessons', label: 'Lessons' },
  { value: 'private_hire', label: 'Private hire' },
  { value: 'aquafit', label: 'Aquafit / class' },
  { value: 'other', label: 'Other' },
];