import { describe, expect, it } from 'vitest';
import { decodeBinding, encodeBinding, redactInput, REDACTED, type ToolField } from './fields';
import { searchServicesTool } from './tools/search-services';

const ID = '5d3b1c2e-8f4a-4b6c-9d0e-1f2a3b4c5d6e';

/** Spec 036 §4 / AC-9 — only the minimal redacted structure is ever persisted. */
describe('spec 036 redaction of persisted tool input', () => {
  it('keeps IDs, enums, minor units, currency, timestamps, dates and booleans; records everything else by name only', () => {
    const fields: ToolField[] = [
      { name: 'id', kind: 'uuid', required: true },
      { name: 'sort', kind: 'enum', required: true, values: ['a'] },
      { name: 'amount', kind: 'minorUnits', required: true },
      { name: 'currency', kind: 'currency', required: true },
      { name: 'at', kind: 'timestamp', required: true },
      { name: 'day', kind: 'date', required: true },
      { name: 'flag', kind: 'boolean', required: true },
      { name: 'message', kind: 'text', required: true },
      { name: 'lat', kind: 'number', required: true },
      { name: 'limit', kind: 'integer', required: true },
    ];
    const input = {
      id: ID,
      sort: 'a',
      amount: 320000,
      currency: 'PKR',
      at: '2026-10-01T05:00:00.000Z',
      day: '2026-10-01',
      flag: true,
      message: 'Call me on 0300-1234567 at House 5',
      lat: 24.8607,
      limit: 20,
    };
    expect(redactInput(input, fields)).toEqual({
      id: ID,
      sort: 'a',
      amount: 320000,
      currency: 'PKR',
      at: '2026-10-01T05:00:00.000Z',
      day: '2026-10-01',
      flag: true,
      message: REDACTED,
      lat: REDACTED,
      limit: REDACTED,
    });
  });

  it('a search’s free-text query and coordinates never reach input_params', () => {
    const input = searchServicesTool.definition.validate({ q: 'plumber near my house on Street 9', lat: 24.86, lng: 67.0, serviceId: ID });
    const stored = JSON.stringify(redactInput(input, searchServicesTool.fields));
    expect(stored).not.toContain('Street 9');
    expect(stored).not.toContain('24.86');
    expect(stored).toContain(ID);
    expect(stored).toContain('"q":"[redacted]"');
  });

  it('a field that was not supplied is absent, not recorded', () => {
    expect(redactInput({}, searchServicesTool.fields)).toEqual({});
    expect(redactInput(undefined, searchServicesTool.fields)).toEqual({});
  });

  it('binding rows round-trip exactly, labelled by field name', () => {
    const fields: ToolField[] = [
      { name: 'offerId', kind: 'uuid', required: true },
      { name: 'scheduledAt', kind: 'timestamp', required: false },
      { name: 'flag', kind: 'boolean', required: false },
      { name: 'amount', kind: 'minorUnits', required: false },
    ];
    const input = { offerId: ID, scheduledAt: '2026-10-01T05:00:00.000Z', flag: false, amount: 1500 };
    const rows = encodeBinding(input, fields);
    expect(rows).toEqual([
      { label: 'offerId', value: ID },
      { label: 'scheduledAt', value: '2026-10-01T05:00:00.000Z' },
      { label: 'flag', value: 'false' },
      { label: 'amount', value: '1500' },
    ]);
    // Display rows alongside are ignored when restoring the input.
    expect(decodeBinding([{ label: 'Price', value: 'PKR 3,200.00' }, ...rows], fields)).toEqual(input);
  });
});
