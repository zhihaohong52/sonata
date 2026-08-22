import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from './multi-select.js';
import { TextInput } from './text-input.js';
import { SearchSelect } from './search-select.js';
import { LoginScreen } from './login-screen.js';
import { ByokStep } from './byok-step.js';
import {
  addProviderCatalog,
  applyStep,
  byokProviderKey,
  configuredProviderNames,
  importableProviders,
  validateCustomProviderName,
  validateProviderUrl,
  type AvailableCredentials,
  type ProviderOption,
} from '../app-state.js';
import { isOauthGatewayAuth, type NativeGatewayAuth } from '../../config.js';
import { fetchModels as defaultFetchModels } from '../../native/models.js';
import type { InitState } from '../types.js';

interface ChoiceProps<T> {
  title: string;
  choices: Array<{ value: T; label: string }>;
  initial?: T;
  onSubmit: (value: T) => void;
  onBack?: () => void;
  onCancel: () => void;
}

/**
 * A local copy of app.tsx's arrow-navigated Choice — kept private to this
 * file rather than shared, the same way byok-step.tsx keeps its own copy.
 * Both are small (under 35 lines) and neither depends on the other's file.
 */
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

export interface ProvidersStepProps {
  home: string;
  providers: ProviderOption[];
  byokProviders: Array<{ name: string; url: string }>;
  credentialAvailability: Record<string, AvailableCredentials>;
  gatewayAuth: Record<string, NativeGatewayAuth>;
  storedKeys: Record<string, string>;
  fetchModels?: typeof defaultFetchModels;
  state: InitState;
  onChange: (updater: (current: InitState) => InitState) => void;
  onContinue: () => void;
  onBack: () => void;
  onCancel: () => void;
}

type Screen =
  | { kind: 'menu' }
  | { kind: 'import' }
  | { kind: 'pick' }
  | { kind: 'custom-name' }
  | { kind: 'custom-url'; name: string }
  | { kind: 'custom-format'; name: string; url: string }
  | { kind: 'credential-choice'; provider: ProviderOption }
  | { kind: 'login'; provider: ProviderOption }
  | { kind: 'key-entry'; provider: ProviderOption }
  | { kind: 'byok'; name: string; url: string };

/**
 * Replaces the old flat "log in / import from codex / import from opencode /
 * enter a key" row list with an explicit top-level choice, modeled on
 * opencode's own /connect: bulk-import everything already authenticated, or
 * add providers one at a time — including one sonata has never heard of.
 */
export function ProvidersStep(props: ProvidersStepProps): React.ReactElement {
  const {
    home, providers, byokProviders, credentialAvailability, gatewayAuth, storedKeys,
    fetchModels = defaultFetchModels, state, onChange, onContinue, onBack, onCancel,
  } = props;
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [pendingCustomFormat, setPendingCustomFormat] = useState<'anthropic' | undefined>(undefined);
  const [pendingCustomKey, setPendingCustomKey] = useState<string | undefined>(undefined);

  const configured = configuredProviderNames(state.providerKeys ?? [], providers);
  const existingNames = [
    ...providers.map((p) => p.provider),
    ...byokProviders.map((p) => p.name),
    ...(state.customProviders ?? []).map((p) => p.name),
  ];

  if (screen.kind === 'menu') {
    const importable = importableProviders(providers, credentialAvailability);
    const choices: Array<{ value: 'import' | 'add' | 'continue'; label: string }> = [];
    if (importable.length > 0) choices.push({ value: 'import', label: 'Import from other harnesses' });
    choices.push({ value: 'add', label: 'Add provider' });
    if (configured.length > 0) choices.push({ value: 'continue', label: 'Continue' });
    return (
      <Box flexDirection="column">
        {problem !== undefined && <Text color="red">{problem}</Text>}
        <Choice
          key="providers-menu"
          title="Set up providers"
          choices={choices}
          initial={choices[0]?.value}
          onSubmit={(choice) => {
            setProblem(undefined);
            if (choice === 'import') setScreen({ kind: 'import' });
            else if (choice === 'add') setScreen({ kind: 'pick' });
            else onContinue();
          }}
          onBack={onBack}
          onCancel={onCancel}
        />
      </Box>
    );
  }

  if (screen.kind === 'import') {
    const importable = importableProviders(providers, credentialAvailability);
    return (
      <MultiSelect
        key="providers-import"
        title="Import from other harnesses"
        items={importable.map((provider) => {
          const have = credentialAvailability[provider.provider]!;
          const fromCodex = have.codex !== null;
          const days = (fromCodex ? have.codex : have.opencode)?.expiresInDays ?? null;
          const hint = days === null ? 'expiry unknown' : days < 0 ? 'expired — re-login in that tool' : `expires in ${days}d`;
          return { value: provider.key, label: provider.provider, hint };
        })}
        initialSelected={new Set<string>()}
        onSubmit={(keys: string[]) => {
          onChange((current) => {
            const nextCredentialSources = { ...current.credentialSources };
            for (const key of keys) {
              const provider = importable.find((p) => p.key === key);
              if (provider === undefined) continue;
              const have = credentialAvailability[provider.provider]!;
              nextCredentialSources[provider.provider] = have.codex !== null ? 'codex' : 'opencode';
            }
            return {
              ...current,
              providerKeys: [...new Set([...(current.providerKeys ?? []), ...keys])],
              credentialSources: nextCredentialSources,
            };
          });
          setScreen({ kind: 'menu' });
        }}
        onBack={() => setScreen({ kind: 'menu' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'pick') {
    const catalog = addProviderCatalog(providers, configured);
    const items = [
      ...catalog.map((provider) => ({ value: provider.key, label: provider.provider, hint: provider.harness })),
      { value: '__custom__', label: 'Add a custom provider…' },
    ];
    return (
      <SearchSelect
        key="providers-pick"
        title="Add provider"
        items={items}
        onSubmit={(value) => {
          if (value === '__custom__') { setScreen({ kind: 'custom-name' }); return; }
          const provider = catalog.find((p) => p.key === value);
          if (provider === undefined) return;
          if (provider.harness === 'byok') {
            const known = byokProviders.find((p) => p.name === provider.provider);
            if (known !== undefined) setScreen({ kind: 'byok', name: known.name, url: known.url });
            return;
          }
          const auth = gatewayAuth[provider.provider];
          if (auth !== undefined && isOauthGatewayAuth(auth)) {
            setScreen(credentialAvailability[provider.provider]?.keyEntryAvailable
              ? { kind: 'credential-choice', provider }
              : { kind: 'login', provider });
          } else {
            setScreen({ kind: 'key-entry', provider });
          }
        }}
        onBack={() => setScreen({ kind: 'menu' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'custom-name') {
    return (
      <TextInput
        key="providers-custom-name"
        title="Custom provider name"
        hint="a short identifier, e.g. my-proxy"
        validate={(value) => validateCustomProviderName(value, existingNames)}
        onSubmit={(value) => setScreen({ kind: 'custom-url', name: value.trim() })}
        onBack={() => setScreen({ kind: 'pick' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'custom-url') {
    return (
      <TextInput
        key={`providers-custom-url-${screen.name}`}
        title={`Base URL for ${screen.name}`}
        hint="e.g. https://api.example.com/v1"
        validate={validateProviderUrl}
        onSubmit={(value) => setScreen({ kind: 'custom-format', name: screen.name, url: value.trim() })}
        onBack={() => setScreen({ kind: 'custom-name' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'custom-format') {
    const { name, url } = screen;
    return (
      <Choice
        key={`providers-custom-format-${name}`}
        title={`Wire format for ${name}`}
        choices={[
          { value: 'openai' as const, label: 'OpenAI-compatible' },
          { value: 'anthropic' as const, label: 'Anthropic-compatible' },
        ]}
        initial={'openai' as const}
        onSubmit={(format) => {
          setPendingCustomFormat(format === 'anthropic' ? 'anthropic' : undefined);
          setScreen({ kind: 'byok', name, url });
        }}
        onBack={() => setScreen({ kind: 'custom-url', name })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'credential-choice') {
    const { provider } = screen;
    const choices = [
      { value: 'login' as const, label: 'Run OAuth login' },
      ...(credentialAvailability[provider.provider]?.keyEntryAvailable
        ? [{ value: 'key' as const, label: 'Enter an API key' }]
        : []),
    ];
    return (
      <Box flexDirection="column">
        {problem !== undefined && <Text color="red">{problem}</Text>}
        <Choice
          key={`providers-credential-choice-${provider.provider}`}
          title={`Credential for ${provider.provider}`}
          choices={choices}
          initial={'login' as const}
          onSubmit={(choice) => {
            setProblem(undefined);
            setScreen(choice === 'login' ? { kind: 'login', provider } : { kind: 'key-entry', provider });
          }}
          onBack={() => setScreen({ kind: 'pick' })}
          onCancel={onCancel}
        />
      </Box>
    );
  }

  if (screen.kind === 'login') {
    const { provider } = screen;
    const auth = gatewayAuth[provider.provider];
    if (auth === undefined) { setScreen({ kind: 'pick' }); return <></>; }
    return (
      <LoginScreen
        key={`providers-login-${provider.provider}`}
        home={home}
        gateway={provider.provider}
        auth={auth}
        onDone={(result) => {
          if (result.ok) {
            onChange((current) => ({
              ...current,
              providerKeys: [...new Set([...(current.providerKeys ?? []), provider.key])],
              credentialSources: { ...current.credentialSources, [provider.provider]: 'sonata' },
            }));
            setScreen({ kind: 'menu' });
          } else {
            setProblem(result.problem ?? 'Login failed.');
            setScreen({ kind: 'credential-choice', provider });
          }
        }}
      />
    );
  }

  if (screen.kind === 'key-entry') {
    const { provider } = screen;
    const auth = gatewayAuth[provider.provider];
    const canGoBackToChoice = auth !== undefined && isOauthGatewayAuth(auth);
    return (
      <TextInput
        key={`providers-key-entry-${provider.provider}`}
        title={`API key for ${provider.provider}`}
        hint="stored in sonata's key store, not shown again"
        mask
        validate={(value) => value.trim() === '' ? 'A key is required.' : undefined}
        onSubmit={(value) => {
          onChange((current) => ({
            ...current,
            byokKeys: { ...current.byokKeys, [provider.provider]: value.trim() },
            providerKeys: [...new Set([...(current.providerKeys ?? []), provider.key])],
          }));
          setScreen({ kind: 'menu' });
        }}
        onBack={() => setScreen(canGoBackToChoice ? { kind: 'credential-choice', provider } : { kind: 'pick' })}
        onCancel={onCancel}
      />
    );
  }

  // screen.kind === 'byok'
  const { name, url } = screen;
  const isCustom = !byokProviders.some((provider) => provider.name === name);
  const apiKey = isCustom
    ? pendingCustomKey ?? state.byokKeys?.[name] ?? storedKeys[name]
    : state.byokKeys?.[name] ?? storedKeys[name];
  return (
    <ByokStep
      key={`providers-byok-${name}`}
      provider={{ name, url }}
      apiKey={apiKey}
      initialIds={state.byokModels?.[name]}
      fetchModels={fetchModels}
      onKey={(key) => {
        if (isCustom) setPendingCustomKey(key);
        else onChange((current) => ({ ...current, byokKeys: { ...current.byokKeys, [name]: key } }));
      }}
      onSubmit={(ids) => {
        onChange((current) => {
          const withModels = applyStep(current, 6, { provider: name, ids });
          return {
            ...withModels,
            ...(isCustom && {
              byokKeys: pendingCustomKey === undefined
                ? withModels.byokKeys
                : { ...withModels.byokKeys, [name]: pendingCustomKey },
              customProviders: [...(withModels.customProviders ?? []), { name, url }],
              customWireFormats: pendingCustomFormat === 'anthropic'
                ? { ...withModels.customWireFormats, [name]: 'anthropic' as const }
                : withModels.customWireFormats,
            }),
            providerKeys: [...new Set([...(withModels.providerKeys ?? []), byokProviderKey(name)])],
          };
        });
        setPendingCustomFormat(undefined);
        setPendingCustomKey(undefined);
        setScreen({ kind: 'menu' });
      }}
      onBack={() => {
        setPendingCustomFormat(undefined);
        setPendingCustomKey(undefined);
        setScreen({ kind: 'pick' });
      }}
      onCancel={onCancel}
    />
  );
}
