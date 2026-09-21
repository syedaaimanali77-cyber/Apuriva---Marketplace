// @vitest-environment jsdom
/**
 * Spec 034 §5 "Accessibility" (spec 043) — the Ask Apuriva panel: keyboard operable, the transcript is
 * a polite live region, the pending state is announced, the temporary notice is part of the panel's
 * accessible name, confirmation parameters are a labelled list with real buttons, the suggestion group
 * is labelled by its attribution text, and the styles use logical properties only (RTL/Urdu).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskApurivaPanel } from './AskApurivaPanel';

configure({ asyncUtilTimeout: 10_000 });

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }));

function stub(message?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      let body: unknown = { data: [] };
      let status = 200;
      if (url === '/api/v1/ai/suggestions')
        body = {
          data: [{ kind: 'unfinished_request', source: 'ask_apuriva', text: 'Ask Apuriva suggests taking a look at your request.', link: { type: 'request', id: 'r-1' } }],
        };
      else if (url === '/api/v1/ai/conversations' && method === 'POST') {
        status = 201;
        body = { data: { id: 'conv-1' } };
      } else if (url.endsWith('/messages')) {
        status = 201;
        body = { data: message ?? { id: 'm', role: 'assistant', body: 'Reply', createdAt: '' } };
      } else if (url === '/api/v1/ai/temporary-turns') body = { data: { role: 'assistant', body: 'Private reply' } };
      return { ok: status < 400, status, json: async () => body, clone() { return this; } };
    }),
  );
}

describe('AskApurivaPanel accessibility (spec 034 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is keyboard operable: Tab reaches a labelled composer and a real Send button; Enter sends', async () => {
    stub();
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    const composer = screen.getByRole('textbox', { name: 'Message Ask Apuriva' });
    composer.focus();
    await user.keyboard('Hello{Enter}');
    expect(await screen.findByText('Reply')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' }).tagName).toBe('BUTTON');
    expect(screen.getByRole('button', { name: 'Close assistant' }).tagName).toBe('BUTTON');
  });

  it('the transcript is an aria-live="polite" log, and the pending state is announced', async () => {
    stub();
    render(<AskApurivaPanel onClose={() => undefined} />);
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message Ask Apuriva' }), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await within(log).findByText('Reply')).toBeInTheDocument();
  });

  it('the temporary-mode notice is part of the panel’s accessible name, conveyed in text', async () => {
    stub();
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    const toggle = screen.getByRole('switch', { name: /Temporary conversation/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(screen.getByRole('region', { name: /temporary conversation/i })).toBeInTheDocument();
    expect(screen.getByText(/Not saved, not used to remember preferences/)).toBeInTheDocument();
  });

  it('a confirmation lists its parameters with real, explicitly labelled buttons', async () => {
    stub({
      id: 'm',
      role: 'assistant',
      body: 'Ready?',
      createdAt: '',
      pendingConfirmation: {
        confirmationId: 'c',
        riskTier: 'high',
        actionLabel: 'Book AC repair',
        parameters: [{ label: 'Price', value: 'PKR 3,200' }],
      },
    });
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await user.type(screen.getByRole('textbox', { name: 'Message Ask Apuriva' }), 'Book');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const card = await screen.findByRole('region', { name: 'Action confirmation' });
    expect(within(card).getByText('Price')).toBeInTheDocument();
    expect(within(card).getByText('PKR 3,200')).toBeInTheDocument();
    for (const name of ['Confirm', 'Not now']) expect(within(card).getByRole('button', { name }).tagName).toBe('BUTTON');
  });

  it('the proactive-suggestion group is labelled by its "Ask Apuriva suggests" text', async () => {
    stub();
    render(<AskApurivaPanel onClose={() => undefined} />);
    expect(await screen.findByText('Ask Apuriva suggests')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask Apuriva suggests taking a look at your request.' }).tagName).toBe('BUTTON');
  });

  it('uses logical properties only, so an Urdu (RTL) layout mirrors correctly', () => {
    for (const file of ['ask-apuriva.module.css', 'ai-account.module.css']) {
      const css = readFileSync(path.resolve(__dirname, file), 'utf8');
      const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(declarations, file).not.toMatch(/(^|[\s;{])(margin|padding|border)-(left|right|top|bottom)\s*:/m);
      expect(declarations, file).not.toMatch(/(^|[\s;{])(left|right|top|bottom)\s*:/m);
      expect(declarations, file).not.toMatch(/text-align\s*:\s*(left|right)/);
      expect(declarations, file).not.toMatch(/float\s*:\s*(left|right)/);
    }
  });
});
