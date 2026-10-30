/**
 * What a LegionellaTrack inspection, clean or flush found: sediment, slime
 * (biofilm), scale, debris and the state of the tank or calorifier. Shared by
 * the API (which validates the answers and fails the check when one needs
 * action) and the LegionellaTrack page (which asks the questions) so the two
 * cannot disagree.
 *
 * HSG274 Part 2: cold water storage tanks are inspected for a tight lid,
 * screened vents and overflow, insulation, and contamination such as debris,
 * insects, vermin, sediment and biofilm; calorifier bases are drained to check
 * for and remove sediment; shower heads and hoses are descaled and
 * disinfected; little-used outlets are flushed. Any answer marked `fail` turns
 * the check into a Fail, which opens an action.
 */

export interface LegionellaConditionOption {
  value: string;
  label: string;
  /** This answer needs action: the check is saved as a Fail. */
  fail?: true;
  /** Shown under the question when this answer is picked. */
  advice?: string;
}

export interface LegionellaConditionQuestion {
  key: string;
  label: string;
  options: readonly LegionellaConditionOption[];
}

const SEDIMENT = [
  { value: "none", label: "None" },
  { value: "slight", label: "A little", advice: "Note it for the next clean and tell your competent person if it builds up." },
  { value: "heavy", label: "A lot", fail: true },
] as const;
const YES_NO_FAIL_ON_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No", fail: true },
] as const;
const NONE_OR_FOUND = [
  { value: "none", label: "None seen" },
  { value: "found", label: "Found", fail: true },
] as const;

export const LEGIONELLA_CONDITION_QUESTIONS = {
  cold_tank_inspection: [
    { key: "sediment", label: "Sediment or debris on the tank floor", options: SEDIMENT },
    { key: "biofilm", label: "Slime (biofilm) on the tank walls or at the water line", options: NONE_OR_FOUND },
    {
      key: "waterSurface", label: "Water surface and colour", options: [
        { value: "clear", label: "Clear" },
        { value: "film", label: "Scum, oily film or discoloured", fail: true },
      ],
    },
    { key: "debris", label: "Insects, birds, vermin or other debris in the tank", options: NONE_OR_FOUND },
    { key: "corrosion", label: "Rust, corrosion or damage to the tank", options: NONE_OR_FOUND },
    { key: "lid", label: "Lid fitted tightly and secure", options: YES_NO_FAIL_ON_NO },
    { key: "screens", label: "Insect screens on the overflow and vent in place", options: YES_NO_FAIL_ON_NO },
    { key: "insulation", label: "Tank and pipework insulation in good condition", options: YES_NO_FAIL_ON_NO },
  ],
  calorifier_inspection: [
    {
      key: "drained", label: "Drain valve at the base opened and run until clear", options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No, could not drain", fail: true },
      ],
    },
    { key: "sediment", label: "Sediment or scale in the water drained from the base", options: SEDIMENT },
    {
      key: "ranClear", label: "Water ran clear by the end of draining", options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No", fail: true },
      ],
    },
    {
      key: "internal", label: "Scale, corrosion or slime inside (if it was opened)", options: [
        { value: "none", label: "None seen" },
        { value: "found", label: "Found", fail: true },
        { value: "not_opened", label: "Not opened this time" },
      ],
    },
  ],
  cold_tank_clean: [
    { key: "sediment", label: "Sediment found before cleaning", options: [
      { value: "none", label: "None" },
      { value: "slight", label: "A little" },
      { value: "heavy", label: "A lot", advice: "Ask your competent person whether the tank needs cleaning more often." },
    ] },
    { key: "biofilm", label: "Slime (biofilm) found before cleaning", options: [
      { value: "none", label: "None seen" },
      { value: "found", label: "Found", advice: "Ask your competent person whether the tank needs cleaning more often." },
    ] },
    { key: "completed", label: "Tank cleaned, disinfected, flushed and refilled", options: YES_NO_FAIL_ON_NO },
  ],
  calorifier_clean: [
    { key: "sediment", label: "Sediment or scale found before cleaning", options: [
      { value: "none", label: "None" },
      { value: "slight", label: "A little" },
      { value: "heavy", label: "A lot", advice: "Ask your competent person whether the base needs draining more often." },
    ] },
    { key: "completed", label: "Cleaned and back in service at 60°C or above", options: YES_NO_FAIL_ON_NO },
  ],
  shower_clean: [
    { key: "scale", label: "Scale on the shower head", options: [
      { value: "none", label: "None" },
      { value: "slight", label: "A little" },
      { value: "heavy", label: "A lot", advice: "Ask your competent person whether showers need descaling more often." },
    ] },
    { key: "biofilm", label: "Slime (biofilm) in the head or hose", options: [
      { value: "none", label: "None seen" },
      { value: "found", label: "Found", advice: "Ask your competent person whether showers need cleaning more often." },
    ] },
    { key: "completed", label: "Head and hose descaled and disinfected", options: YES_NO_FAIL_ON_NO },
  ],
  outlet_flush: [
    {
      key: "water", label: "Water when the outlet was first run", options: [
        { value: "clear", label: "Clear from the start" },
        { value: "cleared", label: "Discoloured or with debris, then ran clear",
          advice: "Note the outlet; your competent person may want it flushed more often." },
        { value: "not_clear", label: "Still discoloured after flushing", fail: true },
      ],
    },
  ],
} as const satisfies Record<string, readonly LegionellaConditionQuestion[]>;

export type LegionellaConditionCheckType = keyof typeof LEGIONELLA_CONDITION_QUESTIONS;
export type LegionellaFindings = Record<string, string>;

export function legionellaConditionQuestions(checkType: string): readonly LegionellaConditionQuestion[] {
  return Object.prototype.hasOwnProperty.call(LEGIONELLA_CONDITION_QUESTIONS, checkType)
    ? LEGIONELLA_CONDITION_QUESTIONS[checkType as LegionellaConditionCheckType]
    : [];
}

/**
 * Why `findings` cannot be saved for `checkType`, or null when every question
 * has a known answer and nothing else was sent.
 */
export function legionellaFindingsError(checkType: string, findings: unknown): string | null {
  const questions = legionellaConditionQuestions(checkType);
  if (questions.length === 0) return "This check type has no condition questions";
  if (!findings || typeof findings !== "object" || Array.isArray(findings)) return "Answer the condition questions";
  const answers = findings as Record<string, unknown>;
  for (const key of Object.keys(answers)) {
    if (!questions.some(q => q.key === key)) return "Unknown condition question";
  }
  for (const question of questions) {
    const answer = answers[question.key];
    if (!question.options.some(o => o.value === answer)) return `Answer "${question.label}"`;
  }
  return null;
}

/** The questions whose answers need action, as "question: answer" lines. */
export function legionellaFindingFailures(checkType: string, findings: unknown): string[] {
  if (!findings || typeof findings !== "object") return [];
  const answers = findings as Record<string, unknown>;
  const failures: string[] = [];
  for (const question of legionellaConditionQuestions(checkType)) {
    const option = question.options.find(o => o.value === answers[question.key]);
    if (option?.fail) failures.push(`${question.label}: ${option.label}`);
  }
  return failures;
}

/** Every answered question as "question: answer", in question order. */
export function legionellaFindingLines(checkType: string, findings: unknown): string[] {
  if (!findings || typeof findings !== "object") return [];
  const answers = findings as Record<string, unknown>;
  const lines: string[] = [];
  for (const question of legionellaConditionQuestions(checkType)) {
    const option = question.options.find(o => o.value === answers[question.key]);
    if (option) lines.push(`${question.label}: ${option.label}`);
  }
  return lines;
}
