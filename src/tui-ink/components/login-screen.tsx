import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { NativeGatewayAuth } from '../../config.js';
import { loginGateway as defaultLoginGateway, type LoginResult } from '../../native/oauth-login.js';

export interface LoginScreenProps {
  home: string;
  gateway: string;
  auth: NativeGatewayAuth;
  onDone: (result: LoginResult) => void;
  loginGateway?: typeof defaultLoginGateway;
}

/**
 * The newest URL and code from LiteLLM's printed output.
 *
 * Two shapes, because the two providers print differently: ChatGPT's is a
 * four-line block (chatgpt/authenticator.py:162-168), Copilot's a single line
 * (github_copilot/authenticator.py:358). Never re-derive these URLs from
 * constants of our own -- one LiteLLM upgrade and we would point users at the
 * wrong page.
 */
export function latestCode(lines: string[]): { url?: string; code?: string } {
  let url: string | undefined;
  let code: string | undefined;
  for (const line of lines) {
    const oneLine = /visit (\S+) and enter code (\S+?)(?:\s+to authenticate)?[\s.]*$/i.exec(line);
    if (oneLine) { url = oneLine[1]; code = oneLine[2]; continue; }
    const visit = /Visit (\S+)/.exec(line);
    if (visit) url = visit[1];
    const enter = /Enter code:\s*(\S+)/i.exec(line);
    if (enter) code = enter[1];
  }
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

export function LoginScreen({ home, gateway, auth, onDone, loginGateway = defaultLoginGateway }: LoginScreenProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(60);
  const [superseded, setSuperseded] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const previousCode = useRef<string | undefined>(undefined);
  const onDoneRef = useRef(onDone);
  const { url, code } = latestCode(lines);

  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    const activeController = new AbortController();
    controller.current = activeController;
    let mounted = true;
    void loginGateway({
      home,
      gateway,
      auth,
      progress: { line: (text) => setLines((current) => [...current, text]) },
      signal: activeController.signal,
    }).then(
      (result) => { if (mounted) onDoneRef.current(result); },
      () => { if (mounted) onDoneRef.current({ ok: false, problem: 'login failed' }); },
    );
    return () => {
      mounted = false;
      activeController.abort();
    };
  }, [auth, gateway, home, loginGateway]);

  useEffect(() => {
    if (code === undefined || code === previousCode.current) return;
    setSuperseded(previousCode.current !== undefined);
    previousCode.current = code;
    setSeconds(60);
  }, [code]);

  useEffect(() => {
    if (auth !== 'copilot-oauth' || code === undefined) return;
    const timer = setInterval(() => setSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => clearInterval(timer);
  }, [auth, code]);

  useInput((_, key) => {
    if (key.escape) controller.current?.abort();
  });

  const warning = lines.find((line) => line.includes('Device codes are a common phishing target.'));

  return (
    <Box flexDirection="column">
      {url !== undefined && <Text>Open {url} in your browser, then the code below</Text>}
      {code !== undefined && <Text bold color="cyan">{code}</Text>}
      {auth === 'copilot-oauth' && code !== undefined && <Text>{seconds}s remaining</Text>}
      {superseded && <Text color="yellow">A new code was issued — use the one above.</Text>}
      {warning !== undefined && <Text>{warning}</Text>}
      {code === undefined && <Text dimColor>Waiting for a device code...</Text>}
      <Text dimColor>Esc to cancel</Text>
    </Box>
  );
}
