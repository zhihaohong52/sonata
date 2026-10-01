import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './text-input.js';
import { DEFAULT_DECISION_BASE_URL } from '../../config.js';
import { decisionGatewayFor, isLoopbackUrl } from '../../native/auto-route.js';
import type { InitState } from '../types.js';
import { usePalette } from '../theme-context.js';

/** OpenRouter's Jev-compatible endpoint; TypeSafe's is `DEFAULT_DECISION_BASE_URL`. */
const OPENROUTER_URL = 'https://openrouter.ai/api';

export type AutoRouteChoice = 'off' | 'typesafe' | 'openrouter' | 'custom';

/** The key-store name and whether the host insists on a credential. */
export interface KeyPrompt {
  gateway: 'typesafe' | 'openrouter' | 'auto-route';
  host: string;
  /**
   * A hosted decision server refuses an unauthenticated call, so the step
   * cannot proceed without one. A self-hosted one may not, so there the key
   * is offered rather than demanded — an empty submit stores nothing.
   */
  required: boolean;
}

/** The URL behind one of the named choices, or `undefined` for Custom. */
export function urlForChoice(choice: AutoRouteChoice): string | undefined {
  if (choice === 'typesafe') return DEFAULT_DECISION_BASE_URL;
  if (choice === 'openrouter') return OPENROUTER_URL;
  return undefined;
}

/** The choice one URL is: the two named hosts, anything else Custom, no URL Off. */
export function choiceForUrl(baseUrl: string | null | undefined): AutoRouteChoice {
  if (baseUrl === undefined || baseUrl === null) return 'off';
  if (baseUrl === DEFAULT_DECISION_BASE_URL) return 'typesafe';
  if (baseUrl === OPENROUTER_URL) return 'openrouter';
  return 'custom';
}

/**
 * What the choice screen opens on: this run's answer first (an explicit Off
 * is an answer too), then the saved `base_url`, then Off.
 */
export function initialChoiceFor(autoRoute: InitState['autoRoute'], savedBaseUrl: string | undefined): AutoRouteChoice {
  return choiceForUrl(autoRoute === undefined ? savedBaseUrl : autoRoute?.baseUrl);
}

/**
 * Whether the key screen is shown for this URL, and what it asks.
 *
 * `present` is a key already held for the URL's gateway — stored before this
 * run, or typed into it as a provider key. A host with one in hand is never
 * asked again, and a loopback server is never asked at all: a decision model
 * on this machine costs nothing, so there is no credential to protect.
 */
export function keyPromptFor(baseUrl: string, present: boolean): KeyPrompt | undefined {
  if (present) return undefined;
  const gateway = decisionGatewayFor(baseUrl);
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* other */ }
  if (gateway === 'auto-route') return isLoopbackUrl(baseUrl) ? undefined : { gateway, host, required: false };
  return { gateway, host, required: true };
}

export interface AutoRouteStepProps {
  state: InitState;
  /** Keys already held, by gateway name: in the store, or typed in this run. */
  storedKeys: Record<string, string>;
  /** The saved config's `[auto_route]` base URL, for the scope being edited. */
  savedBaseUrl?: string;
  onChange: (update: (current: InitState) => InitState) => void;
  onDone: () => void;
  onBack: () => void;
  onCancel: () => void;
}

interface ChoiceProps<T> {
  title: string;
  choices: Array<{ value: T; label: string; hint?: string }>;
  initial?: T;
  onSubmit: (value: T) => void;
  onBack?: () => void;
  onCancel: () => void;
}

/**
 * A local copy of app.tsx's arrow-navigated Choice — kept private to this
 * file rather than shared, the same way providers-step.tsx keeps its own.
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
          {index === cursor ? '›' : ' '} {choice.label}{choice.hint ? `  · ${choice.hint}` : ''}
        </Text>
      ))}
      <Text color={palette.MUTED}>↑↓ choose   enter confirm{onBack ? '   ← back' : ''}   esc cancel</Text>
    </Box>
  );
}

type Screen =
  | { kind: 'choose' }
  | { kind: 'url' }
  | { kind: 'key'; from: 'choose' | 'url'; prompt: KeyPrompt };

/**
 * The Setup step that turns tier auto-routing on: a decision server URL, and
 * the key that URL needs. There is no model screen — the best model is chosen
 * at decision time, and pinning one stays a hand edit of `model`.
 *
 * Records its answers on `InitState` through `onChange` and never writes: like
 * every key the wizard gathers, a decision key is only stored once the confirm
 * gate is passed, so a cancelled run leaves nothing behind.
 */
export function AutoRouteStep({
  state, storedKeys, savedBaseUrl, onChange, onDone, onBack, onCancel,
}: AutoRouteStepProps): React.ReactElement {
  const [screen, setScreen] = useState<Screen>({ kind: 'choose' });

  // A key already held for a host is never asked for again.
  const keyPresent = (baseUrl: string): boolean => {
    const gateway = decisionGatewayFor(baseUrl);
    return storedKeys[gateway] !== undefined || state.byokKeys?.[gateway] !== undefined;
  };

  /** Adopt a URL and clear a key typed for some other host — a key is only ever sent to the host it belongs to. */
  const adoptUrl = (baseUrl: string): void => {
    onChange((current) => ({
      ...current,
      autoRoute: { baseUrl },
      ...(current.decisionKey !== undefined && current.decisionKey.gateway !== decisionGatewayFor(baseUrl)
        ? { decisionKey: undefined }
        : {}),
    }));
  };

  const afterUrl = (baseUrl: string, from: 'choose' | 'url'): void => {
    adoptUrl(baseUrl);
    const prompt = keyPromptFor(baseUrl, keyPresent(baseUrl));
    if (prompt === undefined) return onDone();
    setScreen({ kind: 'key', from, prompt });
  };

  if (screen.kind === 'choose') {
    return <Choice<AutoRouteChoice>
      key="auto-route-choose"
      title="Auto-route subagent tiers?"
      choices={[
        { value: 'off', label: 'Off' },
        { value: 'typesafe', label: 'TypeSafe (api.typesafe.ai)' },
        { value: 'openrouter', label: 'OpenRouter (openrouter.ai/api)' },
        { value: 'custom', label: 'Custom URL…' },
      ]}
      initial={initialChoiceFor(state.autoRoute, savedBaseUrl)}
      onSubmit={(choice) => {
        if (choice === 'off') {
          // An explicit Off answers for this run: drop any key gathered on the
          // way here, or it would be stored for a table never written.
          onChange((current) => ({ ...current, autoRoute: null, decisionKey: undefined }));
          return onDone();
        }
        if (choice === 'custom') return setScreen({ kind: 'url' });
        const baseUrl = urlForChoice(choice);
        if (baseUrl !== undefined) afterUrl(baseUrl, 'choose');
      }}
      onBack={onBack}
      onCancel={onCancel}
    />;
  }

  if (screen.kind === 'url') {
    // The URL this screen opens on: what this run already typed, else the
    // saved custom URL. A named host belongs to its own choice row.
    const current = state.autoRoute?.baseUrl;
    const initial = current !== undefined && choiceForUrl(current) === 'custom'
      ? current
      : savedBaseUrl !== undefined && choiceForUrl(savedBaseUrl) === 'custom' ? savedBaseUrl : undefined;
    return <TextInput
      key="auto-route-url"
      title="Decision server URL"
      initial={initial}
      validate={(value) => isAbsoluteHttpUrl(value) ? undefined : 'Enter an absolute http(s) URL'}
      onSubmit={(value) => afterUrl(value.trim().replace(/\/+$/, ''), 'url')}
      onBack={() => setScreen({ kind: 'choose' })}
      onCancel={onCancel}
    />;
  }

  const { prompt } = screen;
  return <TextInput
    key={`auto-route-key-${prompt.gateway}`}
    title={`Key for ${prompt.host}`}
    hint={prompt.required
      ? "stored in sonata's key store, not shown again"
      : "stored in sonata's key store, not shown again — leave blank to send none"}
    mask
    validate={prompt.required
      ? (value) => value.trim() === '' ? 'A key is required.' : undefined
      : undefined}
    onSubmit={(value) => {
      // Blank on an optional key is an answer: no key, and none stored.
      const key = value.trim();
      onChange((current) => ({
        ...current,
        ...(key === '' ? { decisionKey: undefined } : { decisionKey: { gateway: prompt.gateway, key } }),
      }));
      onDone();
    }}
    onBack={() => setScreen(screen.from === 'url' ? { kind: 'url' } : { kind: 'choose' })}
    onCancel={onCancel}
  />;
}

/** The rule `parseConfig` enforces on `[auto_route] base_url`, asked before the write. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
