import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from './components/multi-select.js';
import { RankedSelect } from './components/ranked-select.js';
import { ProvidersStep } from './components/providers-step.js';
import { ModelsStep } from './components/models-step.js';
import { loadAaCatalog, proposeTiers } from '../catalog.js';
import {
  applyStep,
  candidatesForProviders,
  initialRankedFor,
  tierPickerKeys,
  type AvailableCredentials,
  type CandidateOption,
  type ProviderOption,
} from './app-state.js';
import { type NativeGatewayAuth } from '../config.js';
import { byokCandidateKey, fetchModels as defaultFetchModels } from '../native/models.js';
import { ROLE_BLURB } from '../roles.js';
import type { InitState, TuiResult } from './types.js';

export interface WizardData {
  home: string;
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
  /** Existing importable credentials, by gateway. Contains health metadata only. */
  credentialAvailability?: Record<string, AvailableCredentials>;
  /** Resolved native gateway authentication, used by the device-login screen. */
  gatewayAuth?: Record<string, NativeGatewayAuth>;
  /**
   * A gateway's base URL, by provider — live-detected where a harness still
   * discovers it, falling back to what's already in sonata.toml otherwise.
   * Lets the wizard fetch a fresh model list when re-authenticating a
   * gateway no harness discovers anymore.
   */
  gatewayBaseUrls?: Record<string, string>;
  /** Gateways the config asks to rank last; see SonataConfig.avoidGateways. */
  avoidGateways?: string[];
  /** Injected so tests never reach the network. */
  fetchModels?: typeof defaultFetchModels;
  initialState?: InitState;
  initialStateByScope?: Partial<Record<'project' | 'global', InitState>>;
}

export interface InitWizardProps {
  data: WizardData;
  onDone: (result: TuiResult) => void;
}

export { applyStep, candidatesForProviders } from './app-state.js';

interface ChoiceProps<T> {
  title: string;
  choices: Array<{ value: T; label: string; hint?: string }>;
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
          {index === cursor ? '›' : ' '} {choice.label}{choice.hint ? `  · ${choice.hint}` : ''}
        </Text>
      ))}
      <Text dimColor>↑↓ choose · enter confirm{onBack ? ' · ← back' : ''} · esc cancel</Text>
    </Box>
  );
}

function Summary({ state, onDone, onBack }: { state: InitState; onDone: InitWizardProps['onDone']; onBack: () => void }): React.ReactElement {
  const hasModels = (state.nativeKeys?.length ?? 0) > 0;
  useInput((_, key) => {
    if (key.escape) onDone({ cancelled: true, state });
    if (key.leftArrow) onBack();
    if (key.return && hasModels) onDone({ cancelled: false, state });
  });

  return (
    <Box flexDirection="column">
      <Text bold>Summary</Text>
      <Text>Config scope: {state.configScope ?? 'none'}</Text>
      {/*
        This lists the harnesses imported *from*, not the ones installed — and
        the detection block directly above shows four of those, so a bare
        "none" read as "nothing was detected" when it meant "native models only".
      */}
      <Text>Imported from: {state.harnesses?.join(', ') || 'no harness (native models only)'}</Text>
      <Text>Providers: {state.providerKeys?.join(', ') || 'none'}</Text>
      <Text>Models: {state.nativeKeys?.join(', ') || 'none'}</Text>
      {!hasModels && <Text color="red">Select at least one model before continuing.</Text>}
      <Text>Roles: {state.roles?.join(', ') || 'none'}</Text>
      {(state.roles ?? []).map((role) => {
        const tiers = state.tiers?.[role];
        const line = tiers
          ? (['simple', 'complex'] as const).map((tier) => {
              const ranked = tiers[tier] ?? [];
              const [main, ...backups] = ranked;
              return `${tier} → ${main ?? 'none'}${backups.length > 0 ? ` (+${backups.length} backup${backups.length === 1 ? '' : 's'})` : ''}`;
            }).join(' · ')
          : 'none';
        return <Text key={role}>  {role}: {line}</Text>;
      })}
      <Text dimColor>{hasModels ? 'enter confirm' : '← back to select models'} · ← back · esc cancel</Text>
    </Box>
  );
}

export function InitWizard({ data, onDone }: InitWizardProps): React.ReactElement {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<InitState>(data.initialState ?? {});
  const [tierIndex, setTierIndex] = useState(0);
  const cancel = () => onDone({ cancelled: true, state });
  const next = (value: unknown) => {
    setState((current) => applyStep(current, step, value));
    setStep((current) => current + 1);
  };
  const chooseScope = (scope: InitState['configScope']) => {
    setState(data.initialStateByScope?.[scope!] ?? { configScope: scope });
    setTierIndex(0);
    setStep(1);
  };
  const back = () => setStep((current) => Math.max(0, current - 1));

  switch (step) {
    case 0:
      // A project config *replaces* the machine one rather than merging, which
      // is the whole consequence of this answer and was nowhere on the screen.
      return <Choice key="config-scope" title="Where should this config live?" choices={[
        { value: 'project', label: 'Project', hint: './sonata.toml — this repo only, and it replaces the machine config here' },
        { value: 'global', label: 'Global', hint: '~/.config/sonata/sonata.toml — every project without its own' },
      ]} initial={state.configScope} onSubmit={chooseScope} onCancel={cancel} />;
    case 1: {
      const providers = data.providers;
      return <ProvidersStep
        key="providers-step"
        home={data.home}
        harnesses={data.harnesses}
        providers={providers}
        byokProviders={data.byokProviders}
        credentialAvailability={data.credentialAvailability ?? {}}
        gatewayAuth={data.gatewayAuth ?? {}}
        storedKeys={data.storedKeys}
        fetchModels={data.fetchModels ?? defaultFetchModels}
        state={state}
        onChange={setState}
        onContinue={() => {
          const candidates = candidatesForProviders(data.candidates, providers, state.providerKeys);
          setStep(candidates.length > 0 ? 2 : 3);
        }}
        onBack={back}
        onCancel={cancel}
      />;
    }
    case 2: {
      const candidates = candidatesForProviders(data.candidates, data.providers, state.providerKeys);
      if (candidates.length === 0) return <Summary state={state} onDone={onDone} onBack={back} />;
      return <ModelsStep
        key="models"
        candidates={candidates}
        gatewayBaseUrls={data.gatewayBaseUrls ?? {}}
        gatewayAuth={data.gatewayAuth ?? {}}
        keys={{ ...data.storedKeys, ...state.byokKeys }}
        fetchModels={data.fetchModels ?? defaultFetchModels}
        initialSelected={new Set(state.nativeKeys)}
        onSubmit={(keys, live) => {
          // Keep any BYOK/custom-provider keys already chosen: this step owns
          // the harness candidates only, and a plain overwrite would drop the
          // rest — they were already selected inside ProvidersStep.
          const byokKeys = new Set(Object.entries(state.byokModels ?? {}).flatMap(([provider, ids]) =>
            ids.map((id) => byokCandidateKey(provider, id))));
          // Deduped: a BYOK model can now also appear in this picker (its
          // gateway's live /models answer lists it), so `keys` and `kept`
          // overlap — and a doubled key is written to the config twice.
          const kept = (state.nativeKeys ?? []).filter((key) => byokKeys.has(key));
          setState((current) => ({
            ...applyStep(current, 2, [...new Set([...(keys as string[]), ...kept])]),
            // Carried so cmdInit can mint a candidate for a model only the
            // gateway knew about — otherwise it reaches the tiers but never
            // [models], and the config it writes will not parse.
            liveModels: { ...current.liveModels, ...live },
          }));
          setStep(3);
        }}
        onBack={back}
        onCancel={cancel}
      />;
    }
    case 3: {
      const candidates = candidatesForProviders(data.candidates, data.providers, state.providerKeys);
      return <MultiSelect key="roles" title="Roles" items={data.roles.map((role) => ({ value: role, label: role, hint: ROLE_BLURB[role] }))} initialSelected={new Set(state.roles ?? data.roles)} onSubmit={next} onBack={() => setStep(candidates.length > 0 ? 2 : 1)} onCancel={cancel} filterable={false} />;
    }
    case 4: {
      const roles = state.roles ?? [];
      const role = roles[Math.floor(tierIndex / 2)];
      const tier = tierIndex % 2 === 0 ? 'simple' : 'complex';
      if (!role) return <Summary state={state} onDone={onDone} onBack={back} />;
      const catalog = loadAaCatalog(data.home);
      // Gateway names come from the candidate set: a model key is
      // `<gateway>-<id>`, and without them the id cannot be recovered, so the
      // model misses its catalog entry and drops out of the simple tier.
      const gateways = [...new Set(data.candidates.map((candidate) => candidate.gateway))];
      // Resolved from the candidate set, not by matching key prefixes: a key
      // only looks like `<gateway>-<id>`.
      const avoid = new Set(data.avoidGateways ?? []);
      const avoided = new Set(
        data.candidates.filter((c) => avoid.has(c.gateway)).map((c) => c.key),
      );
      const proposal = proposeTiers(state.nativeKeys ?? [], catalog, gateways, avoided);
      const initialRanked = initialRankedFor(state.tiers?.[role]?.[tier], proposal[tier]);
      const footer = catalog
        ? `rankings: Artificial Analysis (fetched ${catalog.fetchedAt}) — artificialanalysis.ai`
        : 'rankings: built-in defaults — refresh with sonata catalog update';
      return <RankedSelect
        key={`${role}-${tier}`}
        title={`${role}: ${tier} models`}
        items={tierPickerKeys(state.nativeKeys ?? [], initialRanked, data.candidates.map((c) => c.key)).map((key) => ({ value: key, label: key }))}
        initialRanked={initialRanked}
        footer={footer}
        onSubmit={(ranked) => {
          setState((current) => applyStep(current, 4, { role, tier, ranked }));
          if (tierIndex + 1 < roles.length * 2) setTierIndex((current) => current + 1);
          else setStep(5);
        }}
        onBack={() => {
          if (tierIndex === 0) back();
          else setTierIndex((current) => current - 1);
        }}
        onCancel={cancel}
      />;
    }
    default:
      return <Summary state={state} onDone={onDone} onBack={back} />;
  }
}
