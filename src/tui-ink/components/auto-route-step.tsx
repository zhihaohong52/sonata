import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './text-input.js';
import { decisionGatewayFor, decisionKeyRequired, isLoopbackUrl } from '../../native/auto-route.js';
import { DECISION_PROVIDERS, decisionGatewayCandidates, decisionProviderFor } from '../../native/decision-providers.js';
import type { DecisionChoice } from '../../native/decision-models.js';
import { canonicalBaseUrlOrUndefined, checkBaseUrl } from '../../native/base-url.js';
import type { InitState } from '../types.js';
import { usePalette } from '../theme-context.js';

/**
 * A row on the provider screen: `off`, `custom`, a named provider by its key
 * name (`typesafe`, `openrouter`, … — `DECISION_PROVIDERS`), or one of the
 * user's configured gateways as `gateway:<name>`.
 */
export type AutoRouteChoice = 'off' | 'custom' | string;

/** The gateways the step may key, by name: every configured api-key gateway's URL. */
export type StepGateways = Readonly<Record<string, { baseUrl: string }>>;

const GATEWAY_CHOICE = 'gateway:';

/** The key-store name and whether the host insists on a credential. */
export interface KeyPrompt {
  gateway: string;
  host: string;
  /**
   * A hosted decision server refuses an unauthenticated call, so the step
   * cannot proceed without one. A self-hosted one may not, so there the key
   * is offered rather than demanded — an empty submit stores nothing.
   */
  required: boolean;
}

/** The URL behind one of the named choices, or `undefined` for Custom and Off. */
export function urlForChoice(choice: AutoRouteChoice, gateways?: StepGateways): string | undefined {
  if (choice.startsWith(GATEWAY_CHOICE)) {
    const name = choice.slice(GATEWAY_CHOICE.length);
    return decisionGatewayCandidates(gateways).find((c) => c.gateway === name)?.baseUrl;
  }
  return DECISION_PROVIDERS.find((p) => p.gateway === choice)?.baseUrl;
}

/**
 * The choice one URL is: a named provider's canonical endpoint, a configured
 * gateway's decision URL, anything else Custom, no URL Off. Compared as parsed
 * hrefs with trailing path slashes stripped, so `https://API.typesafe.ai`
 * (`new URL` folds the host) and `https://api.typesafe.ai/` are still the
 * named row. A different path, port, query or fragment is a different server,
 * and therefore Custom — which keeps the saved URL rather than overwriting it
 * with a canonical one on confirm.
 */
export function choiceForUrl(baseUrl: string | null | undefined, gateways?: StepGateways): AutoRouteChoice {
  if (baseUrl === undefined || baseUrl === null) return 'off';
  const href = endpointHref(baseUrl);
  if (href === undefined) return 'custom';
  const named = DECISION_PROVIDERS.find((p) => endpointHref(p.baseUrl) === href);
  if (named !== undefined) return named.gateway;
  const configured = decisionGatewayCandidates(gateways).find((c) => endpointHref(c.baseUrl) === href);
  if (configured !== undefined) return `${GATEWAY_CHOICE}${configured.gateway}`;
  return 'custom';
}

/** A URL's href with its path's trailing slashes stripped — the form `choiceForUrl` compares. */
function endpointHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * What the choice screen opens on: this run's answer first (an explicit Off
 * is an answer too), then the saved `base_url`, then Off.
 */
export function initialChoiceFor(
  autoRoute: InitState['autoRoute'],
  savedBaseUrl: string | undefined,
  gateways?: StepGateways,
): AutoRouteChoice {
  return choiceForUrl(autoRoute === undefined ? savedBaseUrl : autoRoute?.baseUrl, gateways);
}

/**
 * Whether the key screen is shown for this URL, and what it asks.
 *
 * `present` is a key already held for the URL's gateway — stored before this
 * run, or typed into it as a provider key. A host with one in hand is never
 * asked again, and a loopback server is never asked at all: a decision model
 * on this machine costs nothing, so there is no credential to protect.
 */
export function keyPromptFor(baseUrl: string, present: boolean, gateways?: StepGateways): KeyPrompt | undefined {
  if (present) return undefined;
  const gateway = decisionGatewayFor(baseUrl, gateways);
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* other */ }
  if (decisionKeyRequired(baseUrl)) return { gateway, host, required: true };
  return isLoopbackUrl(baseUrl) ? undefined : { gateway, host, required: false };
}

export interface AutoRouteStepProps {
  state: InitState;
  /** Keys already held, by gateway name: in the store, or typed in this run. */
  storedKeys: Record<string, string>;
  /** The saved config's `[auto_route]` base URL, for the scope being edited. */
  savedBaseUrl?: string;
  /** The saved config's `[auto_route] model`, offered back when its URL is re-picked. */
  savedModel?: string;
  /**
   * Every configured api-key gateway's URL, by name. Each one that lists
   * decision models becomes a provider row, and a decision URL on one's host
   * is keyed by it — the rule serve applies.
   */
  gateways?: StepGateways;
  /**
   * Whether the stored key for `baseUrl`'s gateway may be sent there now: the
   * host binding serve enforces, or a URL the user typed this run. A key typed
   * on this step's own key screen is always sent: the user just chose it.
   */
  keyBound?: (baseUrl: string) => boolean;
  /**
   * A URL's decision models, JevBench-ranked; `undefined` when it lists none
   * or cannot be asked. Absent skips the model screen and the gateway probe —
   * the model is then chosen at decision time, as before.
   */
  listModels?: (baseUrl: string, key: string | undefined) => Promise<DecisionChoice | undefined>;
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
  // Held as a value, not an index: gateway rows arrive after the probe, and
  // an index would silently move the cursor onto another row.
  const [selected, setSelected] = useState<T | undefined>(() => initial ?? choices[0]?.value);
  const found = choices.findIndex((choice) => choice.value === selected);
  const cursor = found < 0 ? 0 : found;

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.leftArrow) return onBack?.();
    if (key.upArrow) return setSelected(choices[(cursor - 1 + choices.length) % choices.length]?.value);
    if (key.downArrow) return setSelected(choices[(cursor + 1) % choices.length]?.value);
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

type Back = { kind: 'choose' } | { kind: 'url' } | { kind: 'key'; from: 'choose' | 'url'; prompt: KeyPrompt; baseUrl: string };

type Screen =
  | { kind: 'choose' }
  | { kind: 'url' }
  | { kind: 'key'; from: 'choose' | 'url'; prompt: KeyPrompt; baseUrl: string }
  /** `key` is what the listing is asked with, settled when the screen opens. */
  | { kind: 'model'; baseUrl: string; back: Back; key: string | undefined };

/** The model screen's listing: in flight, or its JevBench-ranked answer. */
type Listing = { baseUrl: string; choice: DecisionChoice | undefined } | undefined;

/**
 * The Setup step that turns tier auto-routing on: a decision provider, the
 * key it needs, and the decision model — chosen automatically (the best
 * JevBench-scored model the provider lists, re-chosen at decision time) or
 * pinned. The providers are the named ones (`DECISION_PROVIDERS`), each
 * configured gateway that lists decision models, and a custom URL.
 *
 * Records its answers on `InitState` through `onChange` and never writes: like
 * every key the wizard gathers, a decision key is only stored once the confirm
 * gate is passed, so a cancelled run leaves nothing behind.
 */
export function AutoRouteStep({
  state, storedKeys, savedBaseUrl, savedModel, gateways, keyBound, listModels, onChange, onDone, onBack, onCancel,
}: AutoRouteStepProps): React.ReactElement {
  const palette = usePalette();
  const [screen, setScreen] = useState<Screen>({ kind: 'choose' });
  // Configured gateways that answered with at least one decision model, by name.
  const [servingGateways, setServingGateways] = useState<Record<string, number>>({});
  const [probing, setProbing] = useState(false);
  const [listing, setListing] = useState<Listing>(undefined);

  /**
   * The key `baseUrl` would be asked with now, or undefined when none may be
   * sent. `typed` is a URL the user typed this run: their own choice, so the
   * key it is filed under may go there, as `typedHostsToTrust` will bind it.
   */
  const keyFor = (baseUrl: string, typed = false): string | undefined => {
    const gateway = decisionGatewayFor(baseUrl, gateways);
    if (state.decisionKey?.gateway === gateway) return state.decisionKey.key;
    const held = state.byokKeys?.[gateway] ?? storedKeys[gateway];
    if (held === undefined) return undefined;
    const bound = typed || state.byokKeys?.[gateway] !== undefined
      || decisionProviderFor(baseUrl) !== undefined || (keyBound?.(baseUrl) ?? false);
    return bound ? held : undefined;
  };

  // Ask each configured gateway once whether it serves decision models. One
  // whose stored key may not go to its host is not asked at all: the decision
  // would be refused there anyway, and the listing would carry the key.
  useEffect(() => {
    if (listModels === undefined) return;
    const candidates = decisionGatewayCandidates(gateways).filter(({ gateway, baseUrl }) =>
      (state.byokKeys?.[gateway] ?? storedKeys[gateway]) === undefined || keyBound?.(baseUrl) === true
      || state.byokKeys?.[gateway] !== undefined);
    if (candidates.length === 0) return;
    let live = true;
    setProbing(true);
    void Promise.all(candidates.map(async ({ gateway, baseUrl }) => {
      const choice = await listModels(baseUrl, keyFor(baseUrl)).catch(() => undefined);
      if (live && choice !== undefined && choice.ranked.length > 0) {
        setServingGateways((current) => ({ ...current, [gateway]: choice.ranked.length }));
      }
    })).finally(() => { if (live) setProbing(false); });
    return () => { live = false; };
    // Once per mount: the gateways and keys are fixed for the step's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The model screen's listing, fetched when it opens on a URL.
  const modelScreen = screen.kind === 'model' ? screen : undefined;
  useEffect(() => {
    if (modelScreen === undefined || listModels === undefined) return;
    let live = true;
    setListing(undefined);
    const { baseUrl } = modelScreen;
    void listModels(baseUrl, modelScreen.key).catch(() => undefined).then((choice) => {
      if (live) setListing({ baseUrl, choice });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelScreen]);

  // A key already held for a host is never asked for again — including one
  // this screen already gathered and keeps in `state.decisionKey`. Walking
  // back to the summary and forward again must not reopen the field empty:
  // for a required host that demands a key just typed, and for an optional one
  // a blank submit would erase it.
  const keyPresent = (baseUrl: string): boolean => {
    const gateway = decisionGatewayFor(baseUrl, gateways);
    return storedKeys[gateway] !== undefined
      || state.byokKeys?.[gateway] !== undefined
      || state.decisionKey?.gateway === gateway;
  };

  /**
   * Adopt a URL. A key already gathered is cleared only when its gateway name
   * changes, so a key is only ever sent to the host it belongs to — a
   * `typesafe` key does not follow a move to another host. Every custom host
   * shares the `auto-route` name, so a self-hosted key does follow a change
   * from one custom URL to another. A model answered for another URL is
   * dropped: a pinned model belongs to the URL that serves it.
   */
  const adoptUrl = (baseUrl: string): void => {
    onChange((current) => ({
      ...current,
      autoRoute: current.autoRoute?.baseUrl === baseUrl && current.autoRoute.model !== undefined
        ? { baseUrl, model: current.autoRoute.model }
        : { baseUrl },
      ...(current.decisionKey !== undefined && current.decisionKey.gateway !== decisionGatewayFor(baseUrl, gateways)
        ? { decisionKey: undefined }
        : {}),
    }));
  };

  /** After the URL and key: the model screen when models can be listed, else done. */
  const toModel = (baseUrl: string, back: Back, key: string | undefined): void => {
    if (listModels === undefined) return onDone();
    setScreen({ kind: 'model', baseUrl, back, key });
  };

  const afterUrl = (baseUrl: string, from: 'choose' | 'url', typed = false): void => {
    adoptUrl(baseUrl);
    const prompt = keyPromptFor(baseUrl, keyPresent(baseUrl), gateways);
    if (prompt === undefined) return toModel(baseUrl, { kind: from }, keyFor(baseUrl, typed));
    setScreen({ kind: 'key', from, prompt, baseUrl });
  };

  if (screen.kind === 'choose') {
    const gatewayRows = Object.keys(servingGateways).sort().map((gateway) => {
      const baseUrl = urlForChoice(`${GATEWAY_CHOICE}${gateway}`, gateways) ?? '';
      let host = baseUrl;
      try { host = new URL(baseUrl).host; } catch { /* the URL names it */ }
      const count = servingGateways[gateway];
      return { value: `${GATEWAY_CHOICE}${gateway}`, label: `${gateway} (${host})`, hint: `${count} decision model${count === 1 ? '' : 's'}` };
    });
    return <Box flexDirection="column">
      <Choice<AutoRouteChoice>
        key="auto-route-choose"
        title="Auto-route subagent tiers? Choose the decision provider"
        choices={[
          { value: 'off', label: 'Off' },
          ...DECISION_PROVIDERS.map((p) => ({ value: p.gateway, label: `${p.label} (${new URL(p.baseUrl).host}${new URL(p.baseUrl).pathname.replace(/\/+$/, '')})` })),
          ...gatewayRows,
          { value: 'custom', label: 'Custom URL…' },
        ]}
        initial={initialChoiceFor(state.autoRoute, savedBaseUrl, gateways)}
        onSubmit={(choice) => {
          if (choice === 'off') {
            // An explicit Off answers for this run: drop any key gathered on the
            // way here, or it would be stored for a table never written.
            onChange((current) => ({ ...current, autoRoute: null, decisionKey: undefined }));
            return onDone();
          }
          if (choice === 'custom') return setScreen({ kind: 'url' });
          const baseUrl = urlForChoice(choice, gateways);
          if (baseUrl !== undefined) afterUrl(baseUrl, 'choose');
        }}
        onBack={onBack}
        onCancel={onCancel}
      />
      {probing && <Text color={palette.MUTED}>checking your gateways for decision models…</Text>}
    </Box>;
  }

  if (screen.kind === 'url') {
    // The URL this screen opens on: what this run already typed, else the
    // saved custom URL. A named host belongs to its own choice row.
    const current = state.autoRoute?.baseUrl;
    const initial = current !== undefined && choiceForUrl(current, gateways) === 'custom'
      ? current
      : savedBaseUrl !== undefined && choiceForUrl(savedBaseUrl, gateways) === 'custom' ? savedBaseUrl : undefined;
    return <TextInput
      key="auto-route-url"
      title="Decision server URL"
      initial={initial}
      validate={(value) => decisionUrlError(value)}
      onSubmit={(value) => {
        const baseUrl = (canonicalBaseUrlOrUndefined(value) ?? value.trim()).replace(/\/+$/, '');
        // A re-submitted saved URL is not newly typed: its key stays behind
        // the host binding, as it would at decision time.
        afterUrl(baseUrl, 'url', baseUrl !== savedBaseUrl);
      }}
      onBack={() => setScreen({ kind: 'choose' })}
      onCancel={onCancel}
    />;
  }

  if (screen.kind === 'model') {
    const { baseUrl, back } = screen;
    if (listing === undefined || listing.baseUrl !== baseUrl) {
      return <Box flexDirection="column">
        <Text bold color={palette.TEXT}>Decision model</Text>
        <Text color={palette.MUTED}>listing decision models at {baseUrl}…</Text>
      </Box>;
    }
    const choice = listing.choice;
    if (choice === undefined || choice.ranked.length === 0) {
      // Nothing listed: the model is left to decision time, and a saved pin
      // for this URL is kept (`model` stays unanswered).
      return <NothingListed baseUrl={baseUrl} onDone={onDone} onBack={() => setScreen(back)} onCancel={onCancel} />;
    }
    const pinned = state.autoRoute?.baseUrl === baseUrl && state.autoRoute.model !== undefined
      ? state.autoRoute.model
      : savedBaseUrl === baseUrl ? savedModel ?? null : null;
    const rows: Array<{ value: string | null; label: string; hint?: string }> = [
      { value: null, label: 'Automatic', hint: `best JevBench-scored model at decision time — now ${choice.model ?? 'the server default'}` },
      ...choice.ranked.map((m) => ({
        value: m.id,
        label: m.id,
        hint: m.capability === undefined ? 'not scored by JevBench' : `JevBench ${m.capability.toFixed(1)}`,
      })),
      // A saved pin the URL no longer lists is still offered, so confirming
      // the screen unchanged does not drop it.
      ...(typeof pinned === 'string' && !choice.ranked.some((m) => m.id === pinned)
        ? [{ value: pinned, label: pinned, hint: 'pinned — not listed by this provider' }]
        : []),
    ];
    return <Choice<string | null>
      key={`auto-route-model-${baseUrl}`}
      title="Decision model"
      choices={rows}
      initial={pinned}
      onSubmit={(model) => {
        onChange((current) => ({ ...current, autoRoute: { baseUrl, model } }));
        onDone();
      }}
      onBack={() => setScreen(back)}
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
      toModel(screen.baseUrl, screen, key === '' ? undefined : key);
    }}
    onBack={() => setScreen(screen.from === 'url' ? { kind: 'url' } : { kind: 'choose' })}
    onCancel={onCancel}
  />;
}

/** The model screen when the provider lists nothing: say so, and go on with the model chosen at decision time. */
function NothingListed({ baseUrl, onDone, onBack, onCancel }: { baseUrl: string; onDone: () => void; onBack: () => void; onCancel: () => void }): React.ReactElement {
  const palette = usePalette();
  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.leftArrow) return onBack();
    if (key.return) onDone();
  });
  return <Box flexDirection="column">
    <Text bold color={palette.TEXT}>Decision model</Text>
    <Text color={palette.TEXT}>{baseUrl} listed no decision models — the model is chosen at decision time.</Text>
    <Text color={palette.MUTED}>enter continue   ← back   esc cancel</Text>
  </Box>;
}

/**
 * The rule `parseConfig` enforces on `[auto_route] base_url`, asked before
 * the write: one message per refusal, since a query string or fragment is a
 * real URL and only wrong here — endpoint suffixes are appended to this
 * string, so a `?…`/`#…` would swallow them.
 */
function decisionUrlError(value: string): string | undefined {
  // The config parser's own check, so a URL accepted here loads.
  const check = checkBaseUrl(value);
  return 'href' in check ? undefined : `This URL is refused: ${check.problem}.`;
}
