import { describe, expect, it } from 'vitest';
import { validateFieldSubmission } from '@/lib/service-page/fields';
import type { ServiceFieldDto } from '@/lib/types/service-page';

const REQUIRED_TEXT: ServiceFieldDto = {
  id: 'f1',
  serviceId: 's1',
  key: 'details',
  label: 'Details',
  type: 'text',
  required: true,
  sortOrder: 0,
};

const OPTIONAL_SELECT: ServiceFieldDto = {
  id: 'f2',
  serviceId: 's1',
  key: 'size',
  label: 'Size',
  type: 'select',
  required: false,
  options: ['small', 'large'],
  sortOrder: 1,
};

describe('validateFieldSubmission — the shared contract spec 015/034 both consume (spec 011 AC-3, unit)', () => {
  it('rejects a missing required field, naming it specifically', () => {
    const errors = validateFieldSubmission([REQUIRED_TEXT, OPTIONAL_SELECT], {});
    expect(errors).toEqual([{ field: 'details', message: 'Details is required' }]);
  });

  it('accepts a submission with the required field present and the optional field omitted', () => {
    const errors = validateFieldSubmission([REQUIRED_TEXT, OPTIONAL_SELECT], { details: 'some details' });
    expect(errors).toEqual([]);
  });

  it('names every missing required field, not just the first', () => {
    const secondRequired: ServiceFieldDto = { ...OPTIONAL_SELECT, required: true };
    const errors = validateFieldSubmission([REQUIRED_TEXT, secondRequired], {});
    expect(errors.map((e) => e.field).sort()).toEqual(['details', 'size']);
  });

  it('rejects a select value outside its declared options', () => {
    const errors = validateFieldSubmission([OPTIONAL_SELECT], { size: 'medium' });
    expect(errors).toEqual([{ field: 'size', message: 'Size must be one of: small, large' }]);
  });

  it('a whitespace-only value for a required text field counts as missing', () => {
    const errors = validateFieldSubmission([REQUIRED_TEXT], { details: '   ' });
    expect(errors).toEqual([{ field: 'details', message: 'Details is required' }]);
  });
});
