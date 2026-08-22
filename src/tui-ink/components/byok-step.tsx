import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from './multi-select.js';
import { TextInput } from './text-input.js';
import { isAnthropicRoutedName } from '../../config.js';
import { fetchModels as defaultFetchModels, type FetchModelsResult } from '../../native/models.js';

interface ChoiceProps<T> {
  title: string;
  choices: Array<{ value: T; label: string }>;
  initial?: T;
  onSubmit: (value: T) => void;
  onBack?: () => void;
  onCancel: () => void;
}

function Choice<T>({ title, choices, initial, onSubmit, onBack, onCancel }: ChoiceProps<T>): React.ReactElement {
  const [cursor, setCursor] = useState(() => Math.max(0, choices.findIndex((choice) => choice.value === initial)));

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.leftArrow) return onBack?.();
    if (key.upArrow) return setCursor((current) => (current - 1 + choices.length) % choices.length);
    if (key.downArrow) return setCursor((current) => (current + 1) % choices.length);
    if (key.return && choices[cursor]) onSubmit(choices[cursor].value);
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {choices.map((choice, index) => (
        <Text key={String(choice.value)} inverse={index === cursor}>
          {index === cursor ? '›' : ' '} {choice.label}
        </Text>
      ))}
      <Text dimColor>↑↓ choose · enter confirm{onBack ? ' · ← back' : ''} · esc cancel</Text>
    </Box>
  );
}

export interface ByokStepProps {
  provider: { name: string; url: string };
  /** The key already stored for this provider, or typed earlier in this run. */
  apiKey?: string;
  initialIds?: string[];
  fetchModels: typeof defaultFetchModels;
  onKey: (key: string) => void;
  onSubmit: (ids: string[]) => void;
  onBack: () => void;
  onCancel: () => void;
}

/**
 * One BYOK provider: get a key if we lack one, ask the provider what it serves,
 * and let the user choose — or type ids, when it will not say.
 *
 * This is the wizard's only asynchronous step. The fetch runs in an effect and
 * the reducer never blocks on it; a `cancelled` flag keeps a late response from
 * writing into a screen the user has already left.
 */
export function ByokStep(props: ByokStepProps): React.ReactElement {
  const { provider, apiKey, initialIds, fetchModels, onKey, onSubmit, onBack, onCancel } = props;
  const [result, setResult] = useState<FetchModelsResult | undefined>(undefined);
  const [dropped, setDropped] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [ignoreRejection, setIgnoreRejection] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (apiKey === undefined) return;
    let cancelled = false;
    void fetchModels(provider.url, apiKey).then((found) => {
      if (cancelled) return;
      if (found.outcome === 'ok') {
        const usable = found.models.filter((model) => !isAnthropicRoutedName(model.id));
        setDropped(found.models.length - usable.length);
        setResult({ outcome: 'ok', models: usable });
      } else {
        setResult(found);
      }
    });
    return () => { cancelled = true; };
  }, [apiKey, provider.url, fetchModels, attempt]);

  const retryKey = (): void => {
    setResult(undefined);
    setIgnoreRejection(false);
    setRetrying(false);
    setAttempt((n) => n + 1);
  };

  if (apiKey === undefined || (result?.outcome === 'unauthorized' && retrying)) {
    return (
      <TextInput
        key={`byok-key-${provider.name}-${attempt}`}
        title={`API key for ${provider.name}`}
        hint={`${provider.url} · stored in sonata's key store, not shown again`}
        mask
        validate={(value) => value.trim() === '' ? 'A key is required to list this provider\'s models.' : undefined}
        onSubmit={(value) => { onKey(value.trim()); retryKey(); }}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }

  if (result === undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>{provider.name}</Text>
        <Text dimColor>fetching models from {provider.url}…</Text>
      </Box>
    );
  }

  if (result.outcome === 'unauthorized' && !ignoreRejection) {
    return (
      <Choice
        key={`byok-rejected-${provider.name}`}
        title={`${provider.name} rejected that key (HTTP ${result.status})`}
        choices={[
          { value: 'retry' as const, label: 'Re-enter the key' },
          { value: 'manual' as const, label: 'Keep it and type model ids by hand' },
        ]}
        initial={'retry' as const}
        onSubmit={(choice) => choice === 'retry' ? setRetrying(true) : setIgnoreRejection(true)}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }

  if (result.outcome !== 'ok' || result.models.length === 0) {
    return (
      <TextInput
        key={`byok-ids-${provider.name}`}
        title={`Model ids for ${provider.name} (comma-separated)`}
        hint={hintFor(result, provider.url)}
        initial={initialIds?.join(', ')}
        validate={validateIds}
        onSubmit={(value) => onSubmit(parseIds(value))}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {dropped > 0 && (
        <Text dimColor>
          {dropped} claude-* model{dropped === 1 ? '' : 's'} not shown — the router reserves that prefix
        </Text>
      )}
      <MultiSelect
        key={`byok-models-${provider.name}`}
        title={`Models for ${provider.name}`}
        items={result.models.map((model) => ({ value: model.id, label: model.name ?? model.id, hint: model.id }))}
        initialSelected={new Set(initialIds)}
        onSubmit={onSubmit}
        onBack={onBack}
        onCancel={onCancel}
      />
    </Box>
  );
}

/** Says what actually happened, so the fallback is not read as a diagnosis. */
function hintFor(result: FetchModelsResult, url: string): string {
  switch (result.outcome) {
    case 'unauthorized':
      return `${url} rejected the key for listing models — enter ids by hand`;
    case 'unreachable':
      return `could not reach ${url} — enter ids by hand`;
    default:
      return `${url} did not return a model list — enter ids by hand`;
  }
}

function validateIds(value: string): string | undefined {
  if (parseIds(value).length > 0) return undefined;
  const typed = value.split(',').map((id) => id.trim()).filter((id) => id !== '');
  return typed.length > 0
    ? 'None of those can be used: the router reserves `claude-` for Anthropic.'
    : 'Enter at least one model id.';
}

function parseIds(value: string): string[] {
  return [...new Set(value.split(',').map((id) => id.trim()).filter((id) => id !== ''))]
    .filter((id) => !isAnthropicRoutedName(id));
}
