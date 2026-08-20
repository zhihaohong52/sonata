import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from './components/multi-select.js';
import { TextInput } from './components/text-input.js';
import {
  applyStep,
  byokProviderName,
  candidatesForProviders,
  providersForHarnesses,
  type CandidateOption,
  type ProviderOption,
} from './app-state.js';
import { isAnthropicRoutedName } from '../config.js';
import {
  byokCandidateKey, fetchModels as defaultFetchModels, type FetchedModel,
} from '../native/models.js';
import type { InitState, TuiResult } from './types.js';

export interface WizardData {
  harnesses: Array<{ name: string; installed: boolean }>;
  providers: ProviderOption[];
  candidates: CandidateOption[];
  roles: string[];
  /** Well-known providers a user can name with no harness installed. */
  byokProviders: Array<{ name: string; url: string }>;
  /**
   * Keys already in the store, by provider — the prompt is skipped for these.
   *
   * The key itself is needed, not just the fact of one: listing a provider's
   * models means authenticating to it. These are already on disk, so holding
   * them in memory here exposes nothing new.
   */
  storedKeys: Record<string, string>;
  /** Injected so tests never reach the network. */
  fetchModels?: typeof defaultFetchModels;
  initialState?: InitState;
  initialStateByScope?: Partial<Record<'project' | 'global', InitState>>;
}

export interface InitWizardProps {
  data: WizardData;
  onDone: (result: TuiResult) => void;
}

export { applyStep, candidatesForProviders, providersForHarnesses } from './app-state.js';

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

interface ByokStepProps {
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
function ByokStep(props: ByokStepProps): React.ReactElement {
  const { provider, apiKey, initialIds, fetchModels, onKey, onSubmit, onBack, onCancel } = props;
  const [models, setModels] = useState<FetchedModel[] | undefined>(undefined);
  const [dropped, setDropped] = useState(0);

  useEffect(() => {
    if (apiKey === undefined) return;
    let cancelled = false;
    void fetchModels(provider.url, apiKey).then((found) => {
      if (cancelled) return;
      // The router sends `claude-` upstream to Anthropic and parseConfig refuses
      // such an id, so offering one would let init write a config it cannot read
      // back. Aggregators serve plenty of them.
      const usable = found.filter((model) => !isAnthropicRoutedName(model.id));
      setDropped(found.length - usable.length);
      setModels(usable);
    });
    return () => { cancelled = true; };
  }, [apiKey, provider.url, fetchModels]);

  if (apiKey === undefined) {
    return (
      <TextInput
        key={`byok-key-${provider.name}`}
        title={`API key for ${provider.name}`}
        hint={`${provider.url} · stored in sonata's key store, not shown again`}
        mask
        validate={(value) => value.trim() === '' ? 'A key is required to list this provider\'s models.' : undefined}
        onSubmit={(value) => onKey(value.trim())}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }

  if (models === undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>{provider.name}</Text>
        <Text dimColor>fetching models from {provider.url}…</Text>
      </Box>
    );
  }

  if (models.length === 0) {
    // Unreachable, not OpenAI-shaped, or a key this provider rejects — one
    // fallback for all three, because the user's next move is the same.
    return (
      <TextInput
        key={`byok-ids-${provider.name}`}
        title={`Model ids for ${provider.name} (comma-separated)`}
        hint={`could not read ${provider.url}/models — enter ids by hand`}
        initial={initialIds?.join(', ')}
        validate={(value) => parseIds(value).length === 0 ? 'Enter at least one model id.' : undefined}
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
        items={models.map((model) => ({ value: model.id, label: model.name ?? model.id, hint: model.id }))}
        initialSelected={new Set(initialIds)}
        onSubmit={onSubmit}
        onBack={onBack}
        onCancel={onCancel}
      />
    </Box>
  );
}

function parseIds(value: string): string[] {
  return [...new Set(value.split(',').map((id) => id.trim()).filter((id) => id !== ''))]
    .filter((id) => !isAnthropicRoutedName(id));
}

function Summary({ state, onDone, onBack }: { state: InitState; onDone: InitWizardProps['onDone']; onBack: () => void }): React.ReactElement {
  useInput((_, key) => {
    if (key.escape) onDone({ cancelled: true, state });
    if (key.leftArrow) onBack();
    if (key.return) onDone({ cancelled: false, state });
  });

  return (
    <Box flexDirection="column">
      <Text bold>Summary</Text>
      <Text>Config scope: {state.configScope ?? 'none'}</Text>
      <Text>Harnesses: {state.harnesses?.join(', ') || 'none'}</Text>
      <Text>Providers: {state.providerKeys?.join(', ') || 'none'}</Text>
      <Text>Models: {state.nativeKeys?.join(', ') || 'none'}</Text>
      <Text>Roles: {state.roles?.join(', ') || 'none'}</Text>
      {(state.roles ?? []).map((role) => (
        <Text key={role}>  {role}: {(state.perRoleModels?.[role]?.join(', ') ?? state.nativeKeys?.join(', ')) || 'none'}</Text>
      ))}
      <Text dimColor>enter confirm · ← back · esc cancel</Text>
    </Box>
  );
}

export function InitWizard({ data, onDone }: InitWizardProps): React.ReactElement {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<InitState>(data.initialState ?? {});
  const [sameModels, setSameModels] = useState<boolean | undefined>(undefined);
  const [roleIndex, setRoleIndex] = useState(0);
  // Walks the selected BYOK providers within step 3, the way roleIndex walks
  // roles within step 5.
  const [byokIndex, setByokIndex] = useState(0);
  const cancel = () => onDone({ cancelled: true, state });
  const next = (value: unknown) => {
    setState((current) => applyStep(current, step, value));
    setStep((current) => current + 1);
  };
  const chooseScope = (scope: InitState['configScope']) => {
    setState(data.initialStateByScope?.[scope!] ?? { configScope: scope });
    setSameModels(undefined);
    setRoleIndex(0);
    setStep(1);
  };
  const back = () => setStep((current) => Math.max(0, current - 1));

  switch (step) {
    case 0:
      return <Choice key="config-scope" title="Config scope" choices={[{ value: 'project', label: 'Project' }, { value: 'global', label: 'Global' }]} initial={state.configScope} onSubmit={chooseScope} onCancel={cancel} />;
    case 1: {
      const harnesses = data.harnesses.filter((harness) => harness.installed);
      return <MultiSelect key="harnesses" title="Harnesses" items={harnesses.map((harness) => ({ value: harness.name, label: harness.name }))} initialSelected={new Set(state.harnesses ?? harnesses.map((harness) => harness.name))} onSubmit={next} onBack={back} onCancel={cancel} filterable={false} />;
    }
    case 2: {
      const providers = providersForHarnesses(data.providers, state.harnesses);
      return <MultiSelect key="providers" title="Providers" items={providers.map((provider) => ({ value: provider.key, label: provider.provider, hint: `${provider.harness} · ${provider.count}` }))} initialSelected={new Set(state.providerKeys)} onSubmit={next} onBack={back} onCancel={cancel} />;
    }
    case 3: {
      const providers = providersForHarnesses(data.providers, state.harnesses);
      const candidates = candidatesForProviders(data.candidates, providers, state.providerKeys);
      // BYOK providers have no local catalogue, so they are not among
      // `candidates` and get their own pass below, one provider at a time.
      const byok = (state.providerKeys ?? [])
        .map(byokProviderName)
        .filter((name): name is string => name !== undefined)
        .map((name) => data.byokProviders.find((provider) => provider.name === name))
        .filter((provider): provider is { name: string; url: string } => provider !== undefined);

      // Skipped when it would be an empty list — the zero-harness case, where
      // every model comes from BYOK.
      if (byokIndex === 0 && candidates.length > 0) {
        return <MultiSelect key="models" title="Models" items={candidates.map((candidate) => ({ value: candidate.key, label: candidate.label, hint: candidate.id }))} initialSelected={new Set(state.nativeKeys)} onSubmit={(keys) => {
          // Keep any BYOK keys already chosen: this step owns the harness
          // candidates only, and a plain overwrite would drop the rest.
          const byokKeys = new Set(Object.entries(state.byokModels ?? {}).flatMap(([provider, ids]) =>
            ids.map((id) => byokCandidateKey(provider, id))));
          const kept = (state.nativeKeys ?? []).filter((key) => byokKeys.has(key));
          setState((current) => applyStep(current, 3, [...(keys as string[]), ...kept]));
          if (byok.length > 0) setByokIndex(1);
          else setStep(4);
        }} onBack={back} onCancel={cancel} />;
      }

      // `byokIndex` is 1-based so that 0 can mean "still on the candidate list".
      const offset = candidates.length > 0 ? 1 : 0;
      const current = byok[byokIndex - offset];
      if (!current) return <Summary state={state} onDone={onDone} onBack={back} />;

      return <ByokStep
        key={`byok-${current.name}`}
        provider={current}
        apiKey={state.byokKeys?.[current.name] ?? data.storedKeys[current.name]}
        initialIds={state.byokModels?.[current.name]}
        fetchModels={data.fetchModels ?? defaultFetchModels}
        onKey={(key) => setState((prev) => ({ ...prev, byokKeys: { ...prev.byokKeys, [current.name]: key } }))}
        onSubmit={(ids) => {
          setState((prev) => applyStep(prev, 6, { provider: current.name, ids }));
          if (byokIndex - offset + 1 < byok.length) setByokIndex((n) => n + 1);
          else { setByokIndex(0); setStep(4); }
        }}
        onBack={() => {
          if (byokIndex > (offset === 1 ? 1 : 0)) setByokIndex((n) => n - 1);
          else { setByokIndex(0); if (offset === 0) back(); }
        }}
        onCancel={cancel}
      />;
    }
    case 4:
      return <MultiSelect key="roles" title="Roles" items={data.roles.map((role) => ({ value: role, label: role }))} initialSelected={new Set(state.roles ?? data.roles)} onSubmit={next} onBack={back} onCancel={cancel} filterable={false} />;
    case 5: {
      const roles = state.roles ?? [];
      if (sameModels === undefined) {
        return <Choice key="same-models" title="Use the same models for every role?" choices={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} initial={true} onSubmit={(value) => {
          if (value) {
            setState((current) => ({
              ...current,
              perRoleModels: Object.fromEntries(roles.map((role) => [role, current.nativeKeys ?? []])),
            }));
            setStep(6);
          } else if (roles.length === 0) {
            setStep(6);
          } else {
            setSameModels(false);
            setRoleIndex(0);
          }
        }} onBack={back} onCancel={cancel} />;
      }
      const role = roles[roleIndex];
      if (!role) return <Summary state={state} onDone={onDone} onBack={back} />;
      return <MultiSelect key={`role-${role}`} title={`Models for ${role}`} items={(state.nativeKeys ?? []).map((key) => ({ value: key, label: key }))} initialSelected={new Set(state.perRoleModels?.[role] ?? state.nativeKeys ?? [])} onSubmit={(models) => {
        setState((current) => applyStep(current, 5, { role, models }));
        if (roleIndex + 1 < roles.length) setRoleIndex((current) => current + 1);
        else setStep(6);
      }} onBack={() => {
        if (roleIndex === 0) setSameModels(undefined);
        else setRoleIndex((current) => current - 1);
      }} onCancel={cancel} />;
    }
    default:
      return <Summary state={state} onDone={onDone} onBack={back} />;
  }
}
