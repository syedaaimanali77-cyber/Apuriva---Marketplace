/**
 * Spec 032 §6 "Unit" — the category→priority table (AC-4).
 *
 * The point of these is that AC-4 is a property of a CONSTANT, checkable without a database: a
 * `safety` or `payment` ticket can never be created at a lower priority than the table states,
 * because there is no other source of a new ticket's priority.
 */
import { describe, expect, it } from 'vitest';
import { MESSAGE_BODY_MAX_LENGTH } from '@/lib/messaging/limits';
import { SUPPORT_CATEGORIES, SUPPORT_PRIORITIES } from '@/lib/types/support';
import {
  CATEGORY_PRIORITY,
  MAX_ASSISTANT_QUESTION_LENGTH,
  MAX_SUPPORT_ATTACHMENTS,
  MAX_SUPPORT_BODY_LENGTH,
  priorityForCategory,
} from './limits';

describe('CATEGORY_PRIORITY', () => {
  it('is exhaustive over SUPPORT_CATEGORIES and yields only valid priorities', () => {
    for (const category of SUPPORT_CATEGORIES) {
      const priority = priorityForCategory(category);
      expect(SUPPORT_PRIORITIES).toContain(priority);
    }
    // No stray keys: the map is exactly the vocabulary, so adding a category forces a decision here.
    expect(Object.keys(CATEGORY_PRIORITY).sort()).toEqual([...SUPPORT_CATEGORIES].sort());
  });

  it('pins the AC-4 values that a payment or safety ticket depends on', () => {
    expect(priorityForCategory('safety')).toBe('critical');
    expect(priorityForCategory('payment')).toBe('high');
    expect(priorityForCategory('booking')).toBe('medium');
    expect(priorityForCategory('provider_quality')).toBe('medium');
    expect(priorityForCategory('account')).toBe('medium');
    expect(priorityForCategory('technical')).toBe('low');
    expect(priorityForCategory('other')).toBe('low');
  });

  it('never routes safety or payment to the lowest tier, whatever else changes', () => {
    // The durable half of AC-4: these two must stay above `low` even if the table is retuned.
    expect(priorityForCategory('safety')).not.toBe('low');
    expect(priorityForCategory('payment')).not.toBe('low');
  });

  it('is a pure function of the category — same input, same output, no hidden state', () => {
    for (const category of SUPPORT_CATEGORIES) {
      expect(priorityForCategory(category)).toBe(priorityForCategory(category));
    }
  });
});

describe('prose and attachment bounds', () => {
  it('reuses spec 025 message bound rather than inventing a second platform bound', () => {
    expect(MAX_SUPPORT_BODY_LENGTH).toBe(MESSAGE_BODY_MAX_LENGTH);
    expect(MAX_ASSISTANT_QUESTION_LENGTH).toBe(MESSAGE_BODY_MAX_LENGTH);
  });

  it('caps attachments at the same count as request and message attachments', () => {
    expect(MAX_SUPPORT_ATTACHMENTS).toBe(5);
  });
});
