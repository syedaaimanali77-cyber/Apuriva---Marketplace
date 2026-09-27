// @vitest-environment jsdom
/**
 * Spec 042 §5.2 (X-2, AC-1, AC-6) — the `components/` wrappers give the DS primitives translated defaults
 * (`ui/` itself is never edited), and `DirectionalIcon` mirrors through `--rtl-flip` under `dir="rtl"`.
 */
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/app/_components/LocaleProvider';
import { en } from '@/lib/i18n/dictionaries/en';
import { ur } from '@/lib/i18n/dictionaries/ur';
import type { Dictionary } from '@/lib/i18n/dictionaries/en';
import { DIRECTIONAL_ICON_NAMES, DirectionalIcon } from './DirectionalIcon';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { FormField } from './FormField';
import { SearchBar } from './SearchBar';
import { Skeleton } from './Skeleton';
import { Table } from './Table';

function inLocale(locale: 'en' | 'ur', node: ReactNode, messages?: Dictionary) {
  return render(
    <LocaleProvider locale={locale} messages={messages ?? (locale === 'ur' ? ur : undefined)}>
      <div dir={locale === 'ur' ? 'rtl' : 'ltr'}>{node}</div>
    </LocaleProvider>,
  );
}

describe('X-2 wrappers render t() defaults (spec 042 §5.2)', () => {
  it('ErrorState: title and retry label', () => {
    inLocale('ur', <ErrorState onRetry={() => undefined} />);
    expect(screen.getByText(ur.common.somethingWentWrong)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ur.common.tryAgain })).toBeInTheDocument();
  });

  it('ErrorState: an explicit title still wins', () => {
    inLocale('ur', <ErrorState title="Custom" onRetry={() => undefined} />);
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('ErrorState under en is the English default', () => {
    inLocale('en', <ErrorState onRetry={() => undefined} />);
    expect(screen.getByText(en.common.somethingWentWrong)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.common.tryAgain })).toBeInTheDocument();
  });

  it('Skeleton: one status, announced in the reader\'s language (the DS English text hidden from AT)', () => {
    inLocale('ur', <Skeleton lines={2} />);
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(ur.common.loading);
  });

  it('Table: the empty message', () => {
    inLocale('ur', <Table columns={[{ key: 'a', header: 'A' }]} rows={[]} />);
    expect(screen.getByText(ur.common.nothingToShow)).toBeInTheDocument();
    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument();
  });

  it('FormField: the "Optional" marker', () => {
    inLocale(
      'ur',
      <FormField label="Label" optional>
        <input />
      </FormField>,
    );
    expect(screen.getByText(ur.common.optional)).toBeInTheDocument();
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
  });

  it('SearchBar: placeholder, accessible name and submit label', () => {
    inLocale('ur', <SearchBar value="" onChange={() => undefined} onSubmit={() => undefined} />);
    expect(screen.getByLabelText(ur.comp.search.label)).toHaveAttribute('placeholder', ur.comp.search.placeholder);
    expect(screen.getByRole('button', { name: ur.comp.search.submit })).toBeInTheDocument();
  });

  it('EmptyState: authored title/description pass through unchanged (the DS primitive has no English default)', () => {
    inLocale('ur', <EmptyState title="کوئی نتیجہ نہیں" description="desc" />);
    expect(screen.getByText('کوئی نتیجہ نہیں')).toBeInTheDocument();
  });

  it('AC-6: a key missing from the active dictionary renders English, never the raw key', () => {
    inLocale('ur', <ErrorState onRetry={() => undefined} />, {} as Dictionary);
    expect(screen.getByText(en.common.somethingWentWrong)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('common.');
  });
});

describe('DirectionalIcon (spec 042 §5.2)', () => {
  it('covers exactly the DS directional glyphs', () => {
    expect([...DIRECTIONAL_ICON_NAMES]).toEqual(['arrow-right', 'chevron-right']);
  });

  it('applies the --rtl-flip transform, which [dir="rtl"] turns into scaleX(-1)', () => {
    const { container } = inLocale('ur', <DirectionalIcon name="arrow-right" size="sm" />);
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('style')).toContain('transform: var(--rtl-flip, none)');
    expect(container.querySelector('[dir="rtl"]')).toContainElement(svg as unknown as HTMLElement);
  });

  it('keeps a caller style alongside the flip', () => {
    const { container } = inLocale('en', <DirectionalIcon name="chevron-right" size="sm" style={{ opacity: 0.5 }} />);
    const style = container.querySelector('svg')!.getAttribute('style') ?? '';
    expect(style).toContain('opacity: 0.5');
    expect(style).toContain('transform: var(--rtl-flip, none)');
  });
});
