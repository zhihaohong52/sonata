/**
 * Flat-rate plans reached with an ordinary API key, recognised by endpoint.
 *
 * A coding or token plan bills a monthly fee against a usage allowance rather
 * than per token, and several vendors sell one beside a metered API on the
 * same account: Z.ai's GLM Coding Plan beside its pay-as-you-go API, Kimi For
 * Coding beside Moonshot's API, OpenCode Go beside OpenCode Zen. The key
 * alone does not say which is which. Where the plan has an endpoint of its
 * own, the base URL does, and that is the only thing this table matches on.
 *
 * Plans that share their metered sibling's endpoint and differ only by key —
 * MiniMax's Token Plan, Synthetic, Chutes, NanoGPT, Ollama Cloud, Cerebras
 * Code, Umans AI — are deliberately absent: no URL rule can tell their two
 * kinds of key apart, and guessing would either hide metered spend from
 * `[budget]` or report subscription work as billed. A gateway on one of those
 * says so itself with `billing = "subscription"`.
 *
 * Sourced from models.dev's provider list (the catalogue opencode reads its
 * providers from), checked 2026-10-14: every entry below is a models.dev
 * provider whose `api` URL differs from its metered sibling's, and whose
 * models it lists at $0 because the plan, not the token, is what is paid for.
 * Endpoints that could not be confirmed as plan-only are left out — Z.ai's
 * `/api/anthropic` (documented for the Coding Plan, but not stated to be
 * plan-only) and SCNet's `/api/llm` (no metered sibling to compare against).
 *
 * No imports, so `config.ts`, `pricing.ts` and `init` can all read it.
 */

export interface PlanEndpoint {
  /** The plan's name, as its vendor writes it. Shown by `sonata doctor`. */
  plan: string;
  /** An exact hostname, or a pattern for a family of regional hosts. */
  host: string | RegExp;
  /** The path prefix the plan is served under; absent means the whole host. */
  path?: RegExp;
  /**
   * The models.dev provider that lists these models at their metered rate.
   *
   * models.dev lists plan providers at $0, so pricing a plan gateway from its
   * own entry would value its work at nothing. Covered work is valued at
   * list, which is the metered sibling's rate. Absent where models.dev has no
   * metered sibling with the same model ids.
   */
  listProvider?: string;
}

export const PLAN_ENDPOINTS: readonly PlanEndpoint[] = [
  // OpenCode Go is the one plan models.dev prices at real rates: its
  // allowance is a dollar amount per model, metered at those rates. Both the
  // older `/zen/go` and the current `/inference/go` path answer.
  { plan: 'OpenCode Go', host: 'opencode.ai', path: /^\/(zen|inference)\/go(\/|$)/ },
  { plan: 'Z.ai GLM Coding Plan', host: 'api.z.ai', path: /^\/api\/coding(\/|$)/, listProvider: 'zai' },
  { plan: 'Zhipu GLM Coding Plan', host: 'open.bigmodel.cn', path: /^\/api\/coding(\/|$)/, listProvider: 'zhipuai' },
  // No list provider: the plan's ids (`k3`, `kimi-for-coding`) are not the
  // ids Moonshot's metered API lists (`kimi-k3`), so it would price nothing.
  { plan: 'Kimi For Coding', host: 'api.kimi.com', path: /^\/coding(\/|$)/ },
  { plan: 'Kimi For Coding', host: 'api.kimi.ai', path: /^\/coding(\/|$)/ },
  { plan: 'Alibaba Coding Plan', host: 'coding-intl.dashscope.aliyuncs.com', listProvider: 'alibaba' },
  { plan: 'Alibaba Coding Plan', host: 'coding.dashscope.aliyuncs.com', listProvider: 'alibaba-cn' },
  { plan: 'Alibaba Token Plan', host: /^token-plan\.[a-z0-9-]+\.maas\.aliyuncs\.com$/, listProvider: 'alibaba' },
  { plan: 'Volcengine Ark Coding Plan', host: 'ark.cn-beijing.volces.com', path: /^\/api\/(coding|plan)(\/|$)/, listProvider: 'volcengine' },
  { plan: 'Tencent Coding Plan', host: 'api.lkeap.cloud.tencent.com', path: /^\/(coding|plan)(\/|$)/ },
  { plan: 'Xiaomi Token Plan', host: /^token-plan-[a-z0-9-]+\.xiaomimimo\.com$/, listProvider: 'xiaomi' },
  { plan: 'StepFun Step Plan', host: 'api.stepfun.ai', path: /^\/step_plan(\/|$)/, listProvider: 'stepfun-ai' },
  { plan: 'StepFun Step Plan', host: 'api.stepfun.com', path: /^\/step_plan(\/|$)/, listProvider: 'stepfun' },
  { plan: 'KUAE Cloud Coding Plan', host: 'coding-plan-endpoint.kuaecloud.net' },
];

/**
 * The plan a base URL is served by, or undefined for a metered endpoint.
 *
 * Exact hostname match (never a suffix: `api.z.ai.example` is not Z.ai), on
 * https only, then the path prefix. A URL that does not parse is no plan.
 */
export function planEndpointFor(baseUrl: string | undefined): PlanEndpoint | undefined {
  if (baseUrl === undefined) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  return PLAN_ENDPOINTS.find((entry) => (
    (typeof entry.host === 'string' ? entry.host === host : entry.host.test(host))
    && (entry.path === undefined || entry.path.test(url.pathname))
  ));
}

/**
 * Hosts serving a flat-rate plan and a metered API on one endpoint, where only
 * the key says which a gateway uses. `sonata doctor` names a gateway on one of
 * these that has not stated its `billing`, since nothing else can tell: left
 * alone it is read as metered, which counts plan work toward `[budget]`.
 */
export const SHARED_PLAN_HOSTS: Readonly<Record<string, string>> = {
  'api.minimax.io': 'MiniMax Token Plan',
  'api.minimax.cn': 'MiniMax Token Plan',
  'api.minimaxi.com': 'MiniMax Token Plan',
  'api.synthetic.new': 'Synthetic',
  'llm.chutes.ai': 'Chutes',
  'nano-gpt.com': 'NanoGPT',
  'ollama.com': 'Ollama Cloud',
  'api.cerebras.ai': 'Cerebras Code',
  'api.code.umans.ai': 'Umans AI Coding Plan',
};

/** The shared-endpoint plan a base URL might be, or undefined. */
export function sharedPlanFor(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try { return SHARED_PLAN_HOSTS[new URL(baseUrl).hostname.toLowerCase()]; } catch { return undefined; }
}
