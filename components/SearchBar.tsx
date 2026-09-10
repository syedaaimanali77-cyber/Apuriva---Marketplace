'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/ui/components/core/Icon.jsx';
import { Input } from '@/ui/components/forms/Input.jsx';

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  loading?: boolean;
}

// Minimal shape of the browser's (non-standard, vendor-prefixed) SpeechRecognition API — no ASR
// is implemented here, this only wires up whatever the browser already provides, when it exists.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionConstructor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}

/**
 * Spec 013 §5 — the search entry point. AC-5: voice input is progressive enhancement over the
 * same visible text field, never a voice-only path — the mic button only appears when the
 * browser's own `SpeechRecognition` exists, and a transcription is written into the same input
 * `onChange` a typed character would use, so it goes through identical interpretation/validation
 * downstream (no separate "isVoice" code path exists anywhere, matching `lib/types/search.ts`'s
 * contract). No ASR is implemented here — this only calls whatever the browser already provides.
 */
export function SearchBar({ value, onChange, onSubmit, placeholder = 'Search for a service...', loading = false }: SearchBarProps) {
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setVoiceSupported(getSpeechRecognitionConstructor() !== undefined);
  }, []);

  function handleMicClick() {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) onChange(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
      style={{ display: 'flex', gap: 'var(--space-2)', width: '100%' }}
    >
      <div style={{ flex: 1 }}>
        <Input
          type="search"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label="Search for a service"
          iconLeft="search"
        />
      </div>
      {voiceSupported ? (
        <button
          type="button"
          onClick={handleMicClick}
          aria-label={listening ? 'Listening...' : 'Search by voice'}
          aria-pressed={listening}
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 40,
            height: 40,
            border: '1px solid var(--field-border)',
            borderRadius: 'var(--radius-md)',
            background: listening ? 'var(--surface-brand-subtle)' : 'var(--field-bg)',
            cursor: 'pointer',
          }}
        >
          <Icon name="mic" size="sm" color={listening ? 'var(--teal-600)' : 'var(--text-muted)'} />
        </button>
      ) : null}
      <button
        type="submit"
        disabled={loading}
        style={{
          height: 40,
          padding: '0 16px',
          borderRadius: 'var(--radius-md)',
          border: 'none',
          background: 'var(--action-primary-bg)',
          color: 'var(--action-primary-fg)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 'var(--weight-semibold)',
          cursor: loading ? 'not-allowed' : 'pointer',
        }}
      >
        Search
      </button>
    </form>
  );
}
