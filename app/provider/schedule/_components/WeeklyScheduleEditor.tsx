'use client';

import { FormField, Select, Switch } from '@/components';
import type { DayOfWeek, WeeklyScheduleEntry } from '@/lib/types/availability';
import styles from '../schedule.module.css';

export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** R7's grid — the editor offers the same 30-minute positions slots are generated on. */
const STEP_MINUTES = 30;

function minuteOptions(includeMidnightEnd: boolean): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  const last = includeMidnightEnd ? 1440 : 1410;
  for (let minute = includeMidnightEnd ? STEP_MINUTES : 0; minute <= last; minute += STEP_MINUTES) {
    options.push({ value: String(minute), label: formatMinute(minute) });
  }
  return options;
}

export function formatMinute(minute: number): string {
  if (minute === 1440) return '24:00';
  const hours = String(Math.floor(minute / 60)).padStart(2, '0');
  const minutes = String(minute % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export interface WeeklyScheduleEditorProps {
  entries: WeeklyScheduleEntry[];
  onChange: (entries: WeeklyScheduleEntry[]) => void;
  /** `errors[].field` from a 422 INVALID_SCHEDULE_RANGE, keyed by `entries[i].<field>`. */
  fieldErrors: Record<string, string>;
  disabled?: boolean;
}

/**
 * Spec 016 §5 — the weekly editor, composed from the existing design-system primitives
 * (`Switch`, `Select`, `FormField`). **No `Calendar` component exists** in `ui/` or
 * `components/`, and this spec introduces no new design-system primitive: the editor is a
 * seven-row table of `Select` time pairs, the same way spec 012's `AddressForm` and spec 013's
 * `SearchBar` were built from what already existed.
 *
 * One window per day is what this editor exposes. R2 permits several per day and the API accepts
 * them; a provider needing a split day can still express it through the API, and nothing here
 * writes a set that R2 would reject.
 */
export function WeeklyScheduleEditor({ entries, onChange, fieldErrors, disabled }: WeeklyScheduleEditorProps) {
  const byDay = new Map(entries.map((entry) => [entry.dayOfWeek, entry]));

  function updateDay(day: DayOfWeek, next: WeeklyScheduleEntry | null) {
    const remaining = entries.filter((entry) => entry.dayOfWeek !== day);
    const updated = next ? [...remaining, next] : remaining;
    onChange(updated.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute));
  }

  return (
    <table className={styles.weekTable}>
      <caption className={styles.srOnly}>Weekly working hours</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          <th scope="col">Working</th>
          <th scope="col">From</th>
          <th scope="col">To</th>
        </tr>
      </thead>
      <tbody>
        {DAY_LABELS.map((label, index) => {
          const day = index as DayOfWeek;
          const entry = byDay.get(day);
          const entryIndex = entries.findIndex((candidate) => candidate.dayOfWeek === day);
          const startError = fieldErrors[`entries[${entryIndex}].startMinute`];
          const endError = fieldErrors[`entries[${entryIndex}].endMinute`];

          return (
            <tr key={label}>
              <th scope="row" className={styles.dayCell}>
                {label}
              </th>
              <td>
                <Switch
                  label={`Working on ${label}`}
                  checked={Boolean(entry)}
                  disabled={disabled}
                  onChange={(next) => updateDay(day, next ? { dayOfWeek: day, startMinute: 540, endMinute: 1080 } : null)}
                />
              </td>
              <td>
                <FormField label={`${label} start`} htmlFor={`start-${day}`} error={startError}>
                  <Select
                    id={`start-${day}`}
                    options={minuteOptions(false)}
                    value={entry ? String(entry.startMinute) : ''}
                    disabled={disabled || !entry}
                    invalid={Boolean(startError)}
                    onChange={(event) =>
                      entry && updateDay(day, { ...entry, startMinute: Number(event.currentTarget.value) })
                    }
                  />
                </FormField>
              </td>
              <td>
                <FormField label={`${label} end`} htmlFor={`end-${day}`} error={endError}>
                  <Select
                    id={`end-${day}`}
                    options={minuteOptions(true)}
                    value={entry ? String(entry.endMinute) : ''}
                    disabled={disabled || !entry}
                    invalid={Boolean(endError)}
                    onChange={(event) => entry && updateDay(day, { ...entry, endMinute: Number(event.currentTarget.value) })}
                  />
                </FormField>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
