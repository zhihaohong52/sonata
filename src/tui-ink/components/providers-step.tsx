import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from './multi-select.js';
import { TextInput } from './text-input.js';
import { SearchSelect } from './search-select.js';
import { LoginScreen } from './login-screen.js';
import { ByokStep } from './byok-step.js';
import { RankedSelect } from './ranked-select.js';
import { WELL_KNOWN_PROVIDER_URLS } from '../../detect.js';
import {
  addProviderCatalog,
  alreadyImportedKeys,
  applyStep,
  byokProviderKey,
  byokProviderName,
  byokProviderRoute,
  completeGatewayOrder,
  configuredProviderNames,
  importableProviders,
  importHint,
  providersForHarnesses,
  seedGatewayOrder,
  validateCustomProviderName,
  validateProviderUrl,
  type AvailableCredentials,
  type ProviderOption,
} from '../app-state.js';
import { isAnthropicRoutedName, isOauthGatewayAuth, type NativeGatewayAuth } from '../../config.js';
import { proposePricingProvider } from '../../pricing.js';
import type { ModelsDevCache } from '../../modelsdev.js';
import { loginGateway as defaultLoginGateway, type LoginResult } from '../../native/oauth-login.js';
import { fetchModels as defaultFetchModels } from '../../native/models.js';
import type { InitState } from '../types.js';
import { usePalette } from '../theme-context.js';

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
  const palette = usePalette();
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
      <Text bold color={palette.TEXT}>{title}</Text>
      {choices.map((choice, index) => (
        <Text key={String(choice.value)} inverse={index === cursor}>
          {index === cursor ? '›' : ' '} {choice.label}
        </Text>
      ))}
      <Text color={palette.MUTED}>↑↓ choose   enter confirm{onBack ? '   ← back' : ''}   esc cancel</Text>
    </Box>
  );
}

export interface ProvidersStepProps {
  home: string;
  harnesses: Array<{ name: string; installed: boolean }>;
  providers: ProviderOption[];
  byokProviders: Array<{ name: string; url: string }>;
  credentialAvailability: Record<string, AvailableCredentials>;
  gatewayAuth: Record<string, NativeGatewayAuth>;
  storedKeys: Record<string, string>;
  fetchModels?: typeof defaultFetchModels;
  modelsDevCache?: ModelsDevCache;
  loginGateway?: typeof defaultLoginGateway;
  state: InitState;
  onChange: (updater: (current: InitState) => InitState) => void;
  onContinue: () => void;
  onBack: () => void;
  onCancel: () => void;
}

type Screen =
  | { kind: 'menu' }
  | { kind: 'rank' }
  | { kind: 'import-harnesses' }
  | { kind: 'import' }
  | { kind: 'pick' }
  | { kind: 'custom-name' }
  | { kind: 'custom-url'; name: string }
  | { kind: 'custom-format'; name: string; url: string }
  | { kind: 'credential-choice'; provider: ProviderOption }
  | { kind: 'login'; provider: ProviderOption }
  | { kind: 'oauth-models'; provider: ProviderOption; ids: string[] }
  | { kind: 'key-entry'; provider: ProviderOption }
  | { kind: 'byok'; name: string; url: string };

/**
 * Resolve the models.dev catalogue without making OAuth credentials look like
 * API keys.
 *
 * Read from `providers` (the priced map) rather than `names`, which lists more.
 * models.dev carries models it has not costed, and on `openai` those are the
 * four image models — not something a tier can dispatch to. Priced-only also
 * matches how the rest of sonata treats a model: the budget, the ledger and
 * tier ranking all need a rate. The cost is that an uncosted *chat* model on
 * some other provider is dropped silently, which is the better failure than
 * offering a model no tier can rank or bill.
 */
export function oauthModelIds(
  cache: ModelsDevCache | undefined,
  gateway: string,
  auth: NativeGatewayAuth,
): string[] {
  const provider = proposePricingProvider(gateway, auth)?.[0];
  if (provider === undefined || cache?.providers[provider] === undefined) return [];
  return Object.keys(cache.providers[provider]).filter((id) => !isAnthropicRoutedName(id));
}

export function parseOAuthModelIds(value: string): string[] {
  return [...new Set(value.split(',').map((id) => id.trim()).filter((id) => id !== '' && !isAnthropicRoutedName(id)))];
}

export interface OAuthModelsStepProps {
  provider: string;
  modelIds: string[];
  onSubmit: (ids: string[]) => void;
  onBack: () => void;
  onCancel: () => void;
}

/** OAuth has no bearer key and no usable `/models` endpoint, so it goes straight to this picker. */
export function OAuthModelsStep({ provider, modelIds, onSubmit, onBack, onCancel }: OAuthModelsStepProps): React.ReactElement {
  if (modelIds.length === 0) {
    return (
      <TextInput
        key={`providers-oauth-ids-${provider}`}
        title={`Model ids for ${provider} (comma-separated)`}
        hint="models.dev has no cached list — enter ids by hand"
        validate={(value) => parseOAuthModelIds(value).length > 0 ? undefined : 'Enter at least one model id.'}
        onSubmit={(value) => onSubmit(parseOAuthModelIds(value))}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }
  return (
    <MultiSelect
      key={`providers-oauth-models-${provider}`}
      title={`Models for ${provider}`}
      items={modelIds.map((id) => ({ value: id, label: id }))}
      onSubmit={onSubmit}
      onBack={onBack}
      onCancel={onCancel}
    />
  );
}

/**
 * Replaces the old flat "log in / import from codex / import from opencode /
 * enter a key" row list with an explicit top-level choice, modeled on
 * opencode's own /connect: bulk-import everything already authenticated, or
 * add providers one at a time — including one sonata has never heard of.
 */
export function ProvidersStep(props: ProvidersStepProps): React.ReactElement {
  const palette = usePalette();
  const {
    home, harnesses, providers, byokProviders, credentialAvailability, gatewayAuth, storedKeys,
    fetchModels = defaultFetchModels, modelsDevCache, loginGateway, state, onChange, onContinue, onBack, onCancel,
  } = props;
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [pendingCustomFormat, setPendingCustomFormat] = useState<'anthropic' | undefined>(undefined);
  const [pendingCustomKey, setPendingCustomKey] = useState<string | undefined>(undefined);

  const configured = configuredProviderNames(state.providerKeys ?? [], providers);
  // Catalogued (harness or BYOK) providers are excluded here on purpose: typing
  // one of those names below redirects into re-entering its credential rather
  // than being rejected as a duplicate — see the custom-name onSubmit handler.
  // Only a name that collides with a custom provider already added this run has
  // no such redirect, so that's the only case left for validation to reject.
  const existingNames = (state.customProviders ?? []).map((p) => p.name);
  // The gateways the Rank providers screen orders: every provider selected
  // this run, a custom one included, each once.
  const selectedGateways = [...new Set([...configured, ...existingNames])];

  const routeToProvider = (provider: ProviderOption) => {
    if (provider.harness === 'byok') {
      const known = byokProviders.find((p) => p.name === provider.provider);
      if (known === undefined) return;
      const byokOption = { ...provider, key: byokProviderKey(provider.provider) };
      const route = byokProviderRoute(
        gatewayAuth[provider.provider],
        credentialAvailability[provider.provider]?.keyEntryAvailable,
      );
      if (route === 'credential-choice') setScreen({ kind: route, provider: byokOption });
      else if (route === 'login') setScreen({ kind: route, provider: byokOption });
      else setScreen({ kind: route, name: known.name, url: known.url });
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
  };

  if (screen.kind === 'rank') {
    return (
      <RankedSelect<string>
        key="rank-providers"
        title="Rank providers"
        items={selectedGateways.map((name) => ({ value: name, label: name }))}
        initialRanked={seedGatewayOrder(selectedGateways, state.gatewayOrder)}
        footer="first = preferred when two providers serve the same model"
        onSubmit={(ranked) => {
          onChange((current) => ({ ...current, gatewayOrder: completeGatewayOrder(ranked, selectedGateways) }));
          onContinue();
        }}
        onBack={() => setScreen({ kind: 'menu' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'menu') {
    const importable = importableProviders(providers, credentialAvailability);
    const choices: Array<{ value: 'import' | 'add' | 'continue'; label: string }> = [];
    if (importable.length > 0) choices.push({ value: 'import', label: 'Import from other harnesses' });
    choices.push({ value: 'add', label: 'Add provider' });
    if (configured.length > 0) choices.push({ value: 'continue', label: 'Continue' });
    return (
      <Box flexDirection="column">
        {problem !== undefined && <Text color={palette.HIGH}>{problem}</Text>}
        <Choice
          key="providers-menu"
          title="Set up providers"
          choices={choices}
          initial={choices[0]?.value}
          onSubmit={(choice) => {
            setProblem(undefined);
            if (choice === 'import') setScreen({ kind: 'import-harnesses' });
            else if (choice === 'add') setScreen({ kind: 'pick' });
            else if (selectedGateways.length < 2) {
              // Nothing to order: one gateway is trivially first.
              onChange((current) => ({ ...current, gatewayOrder: [...selectedGateways] }));
              onContinue();
            } else setScreen({ kind: 'rank' });
          }}
          onBack={onBack}
          onCancel={onCancel}
        />
      </Box>
    );
  }

  if (screen.kind === 'import-harnesses') {
    const installed = harnesses.filter((harness) => harness.installed);
    return (
      <MultiSelect
        key="providers-import-harnesses"
        title="Import from which harnesses?"
        items={installed.map((harness) => ({ value: harness.name, label: harness.name }))}
        initialSelected={new Set(state.harnesses ?? installed.map((harness) => harness.name))}
        onSubmit={(names) => {
          onChange((current) => ({ ...current, harnesses: names as string[] }));
          setScreen({ kind: 'import' });
        }}
        onBack={() => setScreen({ kind: 'menu' })}
        onCancel={onCancel}
        filterable={false}
      />
    );
  }

  if (screen.kind === 'import') {
    const importable = importableProviders(providersForHarnesses(providers, state.harnesses), credentialAvailability);
    return (
      <MultiSelect
        key="providers-import"
        title="Import from other harnesses"
        items={importable.map((provider) => ({
          value: provider.key,
          label: provider.provider,
          hint: importHint(provider.harness, credentialAvailability[provider.provider]!),
        }))}
        initialSelected={alreadyImportedKeys(state.providerKeys ?? [], importable)}
        onSubmit={(keys: string[]) => {
          onChange((current) => {
            const checked = new Set(keys);
            const nextCredentialSources = { ...current.credentialSources };
            for (const provider of importable) {
              if (!checked.has(provider.key)) {
                // Unchecked, whether newly or already configured: unimport —
                // no source pins a provider that is about to leave providerKeys.
                delete nextCredentialSources[provider.provider];
                continue;
              }
              const have = credentialAvailability[provider.provider]!;
              // A plain API key is left unset here: `resolveKeys` already
              // checks sonata's own store then opencode's live, in that
              // order, so pinning a source would only foreclose that
              // fallback without buying anything.
              if (have.codex !== null) nextCredentialSources[provider.provider] = 'codex';
              else if (have.opencode !== null) nextCredentialSources[provider.provider] = 'opencode';
              else delete nextCredentialSources[provider.provider];
            }
            // This screen owns every provider it can show, by name — not by
            // key, since an earlier run may have stored the same provider
            // under a different harness's key. Drop all of those, then add
            // back whatever is checked now: this is how unchecking an
            // already-imported provider actually removes it.
            const shownNames = new Set(importable.map((p) => p.provider));
            const byKey = new Map(providers.map((p) => [p.key, p.provider]));
            const kept = (current.providerKeys ?? []).filter((key) => {
              const name = byokProviderName(key) ?? byKey.get(key);
              return name === undefined || !shownNames.has(name);
            });
            return {
              ...current,
              providerKeys: [...new Set([...kept, ...keys])],
              credentialSources: nextCredentialSources,
            };
          });
          setScreen({ kind: 'menu' });
        }}
        onBack={() => setScreen({ kind: 'import-harnesses' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'pick') {
    const catalog = addProviderCatalog(providers, configured);
    const items = [
      // Several names in `WELL_KNOWN_PROVIDER_URLS` are near-duplicates that the
      // picker rendered as indistinguishable rows — `together`/`together_ai`
      // point at one URL, while `deep-infra`/`deepinfra` point at *different*
      // ones. They cannot be merged away, since the table doubles as the
      // name → base-URL lookup every harness's own provider name resolves
      // through, so the row shows the URL and disambiguates itself.
      ...catalog.map((provider) => ({
        value: provider.key,
        label: provider.provider,
        hint: [provider.harness, WELL_KNOWN_PROVIDER_URLS[provider.provider]].filter(Boolean).join(' · '),
      })),
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
          routeToProvider(provider);
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
        onSubmit={(value) => {
          const trimmed = value.trim();
          const catalogued = providers.find((p) => p.provider.toLowerCase() === trimmed.toLowerCase());
          if (catalogued !== undefined) { routeToProvider(catalogued); return; }
          const byok = byokProviders.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
          if (byok !== undefined) { setScreen({ kind: 'byok', name: byok.name, url: byok.url }); return; }
          setScreen({ kind: 'custom-url', name: trimmed });
        }}
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
        {problem !== undefined && <Text color={palette.HIGH}>{problem}</Text>}
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
        {...(loginGateway === undefined ? {} : { loginGateway })}
        onDone={(result) => {
          if (result.ok) {
            onChange((current) => ({
              ...current,
              providerKeys: [...new Set([...(current.providerKeys ?? []), provider.key])],
              credentialSources: { ...current.credentialSources, [provider.provider]: 'sonata' },
            }));
            setScreen({
              kind: 'oauth-models',
              provider,
              ids: oauthModelIds(modelsDevCache, provider.provider, auth),
            });
          } else {
            setProblem(result.problem ?? 'Login failed.');
            setScreen({ kind: 'credential-choice', provider });
          }
        }}
      />
    );
  }

  if (screen.kind === 'oauth-models') {
    const { provider, ids } = screen;
    return (
      <OAuthModelsStep
        key={`providers-oauth-models-${provider.provider}`}
        provider={provider.provider}
        modelIds={ids}
        onSubmit={(selected) => {
          onChange((current) => applyStep({
            ...current,
            providerKeys: [...new Set([...(current.providerKeys ?? []), provider.key])],
            credentialSources: { ...current.credentialSources, [provider.provider]: 'sonata' },
          }, 5, { provider: provider.provider, ids: selected }));
          setScreen({ kind: 'menu' });
        }}
        onBack={() => setScreen({ kind: 'login', provider })}
        onCancel={onCancel}
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
          const withModels = applyStep(current, 5, { provider: name, ids });
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
