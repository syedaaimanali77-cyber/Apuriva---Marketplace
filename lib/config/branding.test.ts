import { describe, expect, it } from 'vitest';
import { metadata } from '@/app/layout';
import { branding } from './branding';

describe('branding config (spec 002 AC-1)', () => {
  it('defines the single source of truth for app name, AI assistant name, and tagline', () => {
    expect(branding.appName).toBe('APURIVA');
    expect(branding.aiAssistantName).toBe('Apuriva Assistant');
    expect(branding.tagline).toBe('Get the right help. Get it done.');
  });

  it('propagates into page metadata with no separately hardcoded copy', () => {
    expect(metadata.title).toBe(branding.appName);
    expect(metadata.description).toBe(branding.tagline);
  });
});
