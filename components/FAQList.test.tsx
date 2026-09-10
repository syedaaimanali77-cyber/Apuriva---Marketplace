// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FAQList } from './FAQList';

describe('FAQList (spec 011 AC-6)', () => {
  it('distinguishes official vs provider FAQs via icon+label, not color alone', () => {
    render(
      <FAQList
        faqs={[
          { id: '1', question: 'Official Q', answer: 'Official A', source: 'official' },
          { id: '2', question: 'Provider Q', answer: 'Provider A', source: 'provider' },
        ]}
      />,
    );

    expect(screen.getByText('Official Q')).toBeInTheDocument();
    expect(screen.getByText('Official answer')).toBeInTheDocument();
    expect(screen.getByText('Provider Q')).toBeInTheDocument();
    expect(screen.getByText('From a provider')).toBeInTheDocument();
  });

  it('shows the empty message when there are no FAQs', () => {
    render(<FAQList faqs={[]} />);
    expect(screen.getByText('No questions answered yet.')).toBeInTheDocument();
  });
});
