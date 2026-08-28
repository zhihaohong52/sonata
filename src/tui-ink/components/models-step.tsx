import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { MultiSelect } from './multi-select.js';
import { mergeLiveCandidates, type CandidateOption } from '../app-state.js';
import { isAnthropicRoutedName, isOauthGatewayAuth, type NativeGatewayAuth } from '../../config.js';
import { fetchModels as defaultFetchModels } from '../../native/models.js';

export interface ModelsStepProps {
  candidates: CandidateOption[];
  gatewayBaseUrls: Record<string, string>;
  gatewayAuth: Record<string, NativeGatewayAuth>;
  /** Keys already resolvable for a gateway, by gateway name. */
  keys: Record<string, string>;
  initialSelected: Set<string>;
  fetchModels?: typeof defaultFetchModels;
  onSubmit: (keys: string[]) => void;
  onBack: () => void;
  onCancel: () => void;
}

/**
 * Which gateways can be asked what they serve, rather than trusted to still
 * match a harness snapshot.
 *
 * Three things have to hold. A **base URL**, or there is nowhere to ask. A
 * **key**, because listing models means authenticating. And **not OAuth**: a
 * subscription credential is not a bearer key, and those gateways do not serve
 * an OpenAI-shaped `/models` anyway (ChatGPT's is `backend-api/codex`, Copilot
 * needs a token exchange first) — so asking would fail slowly and teach
 * nothing. Everything excluded here keeps its harness list.
 */
export function refreshableGateways(
  candidates: CandidateOption[],
  gatewayBaseUrls: Record<string, string>,
  gatewayAuth: Record<string, NativeGatewayAuth>,
  keys: Record<string, string>,
): string[] {
  const gateways = [...new Set(candidates.map((candidate) => candidate.gateway))];
  return gateways.filter((gateway) => {
    const auth = gatewayAuth[gateway];
    if (auth !== undefined && isOauthGatewayAuth(auth)) return false;
    return gatewayBaseUrls[gateway] !== undefined && keys[gateway] !== undefined;
  });
}

/**
 * The model picker, over a catalogue refreshed from the gateways themselves.
 *
 * The wizard's only other asynchronous screen is `ByokStep`, and this follows
 * its shape: the fetch runs in an effect, a `cancelled` flag keeps a late
 * response from writing into a screen the user has left, and a failure is
 * never fatal — `fetchModels` is timeout-bounded and non-throwing, and a
 * gateway that does not answer simply keeps the list the harness gave.
 */
export function ModelsStep(props: ModelsStepProps): React.ReactElement {
  const {
    candidates, gatewayBaseUrls, gatewayAuth, keys, initialSelected,
    fetchModels = defaultFetchModels, onSubmit, onBack, onCancel,
  } = props;
  const targets = refreshableGateways(candidates, gatewayBaseUrls, gatewayAuth, keys);
  const [live, setLive] = useState<Record<string, string[]> | undefined>(
    targets.length === 0 ? {} : undefined,
  );
  const [failed, setFailed] = useState<string[]>([]);

  // The gateway set is derived from props that do not change while this screen
  // is mounted; joining it keeps the effect from re-firing on every render.
  const targetKey = targets.join(',');
  useEffect(() => {
    if (targets.length === 0) return;
    let cancelled = false;
    void Promise.all(targets.map(async (gateway) => {
      const found = await fetchModels(gatewayBaseUrls[gateway]!, keys[gateway]!);
      return { gateway, found };
    })).then((results) => {
      if (cancelled) return;
      const fresh: Record<string, string[]> = {};
      const problems: string[] = [];
      for (const { gateway, found } of results) {
        // The router reserves `claude-` for Anthropic, so parseConfig refuses
        // such an id — offering one would write a config it cannot read back.
        const usable = found.outcome === 'ok'
          ? found.models.map((model) => model.id).filter((id) => !isAnthropicRoutedName(id))
          : [];
        // An empty answer is not evidence the gateway serves nothing; treat it
        // as a failed refresh so the harness list survives.
        if (usable.length > 0) fresh[gateway] = usable;
        else problems.push(gateway);
      }
      setFailed(problems);
      setLive(fresh);
    });
    return () => { cancelled = true; };
  }, [targetKey, fetchModels]);

  if (live === undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>Models</Text>
        <Text dimColor>
          asking {targets.length} provider{targets.length === 1 ? '' : 's'} what {targets.length === 1 ? 'it serves' : 'they serve'}…
        </Text>
      </Box>
    );
  }

  const merged = mergeLiveCandidates(candidates, live);
  const refreshed = Object.keys(live).length;
  return (
    <Box flexDirection="column">
      {refreshed > 0 && (
        <Text dimColor>
          refreshed {refreshed} provider{refreshed === 1 ? '' : 's'} from their /models endpoint
        </Text>
      )}
      {failed.length > 0 && (
        <Text dimColor>{failed.join(', ')} did not answer — showing the harness catalogue</Text>
      )}
      <MultiSelect
        key="models"
        title="Models"
        items={merged.map((candidate) => ({ value: candidate.key, label: candidate.label, hint: candidate.id }))}
        initialSelected={initialSelected}
        onSubmit={(selected) => onSubmit(selected as string[])}
        onBack={onBack}
        onCancel={onCancel}
      />
    </Box>
  );
}
