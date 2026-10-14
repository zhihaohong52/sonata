import { describe, it, expect } from 'vitest';
import { planEndpointFor, sharedPlanFor, PLAN_ENDPOINTS } from '../src/plans.js';

describe('planEndpointFor', () => {
  // One base URL per plan, as models.dev publishes it (2026-10-14), plus the
  // older OpenCode Go path. Each must resolve to a plan.
  it.each([
    ['https://opencode.ai/zen/go/v1', 'OpenCode Go'],
    ['https://opencode.ai/inference/go/v1', 'OpenCode Go'],
    ['https://api.z.ai/api/coding/paas/v4', 'Z.ai GLM Coding Plan'],
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'Zhipu GLM Coding Plan'],
    ['https://api.kimi.com/coding/v1', 'Kimi For Coding'],
    ['https://api.kimi.ai/coding/v1', 'Kimi For Coding'],
    ['https://coding-intl.dashscope.aliyuncs.com/v1', 'Alibaba Coding Plan'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'Alibaba Coding Plan'],
    ['https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'Alibaba Token Plan'],
    ['https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'Alibaba Token Plan'],
    ['https://ark.cn-beijing.volces.com/api/coding/v3', 'Volcengine Ark Coding Plan'],
    ['https://ark.cn-beijing.volces.com/api/plan/v3', 'Volcengine Ark Coding Plan'],
    ['https://api.lkeap.cloud.tencent.com/coding/v3', 'Tencent Coding Plan'],
    ['https://api.lkeap.cloud.tencent.com/plan/v3', 'Tencent Coding Plan'],
    ['https://token-plan-sgp.xiaomimimo.com/v1', 'Xiaomi Token Plan'],
    ['https://token-plan-ams.xiaomimimo.com/v1', 'Xiaomi Token Plan'],
    ['https://api.stepfun.ai/step_plan/v1', 'StepFun Step Plan'],
    ['https://api.stepfun.com/step_plan/v1', 'StepFun Step Plan'],
    ['https://coding-plan-endpoint.kuaecloud.net/v1', 'KUAE Cloud Coding Plan'],
  ])('%s is %s', (url, plan) => {
    expect(planEndpointFor(url)?.plan).toBe(plan);
  });

  // The metered sibling of each, which must NOT read as a plan: that would
  // hide real spend from `[budget]`.
  it.each([
    'https://opencode.ai/zen/v1',
    'https://opencode.ai/inference/v1',
    'https://api.z.ai/api/paas/v4',
    'https://open.bigmodel.cn/api/paas/v4',
    'https://api.moonshot.ai/v1',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'https://ark.cn-beijing.volces.com/api/v3',
    'https://api.xiaomimimo.com/v1',
    'https://api.stepfun.ai/v1',
    'https://api.minimax.io/v1',
    // Documented for the Coding Plan but not stated to be plan-only.
    'https://api.z.ai/api/anthropic',
  ])('%s is metered', (url) => {
    expect(planEndpointFor(url)).toBeUndefined();
  });

  it('matches the hostname exactly, over https, and the path as a prefix segment', () => {
    expect(planEndpointFor('https://api.z.ai.evil.example/api/coding/paas/v4')).toBeUndefined();
    expect(planEndpointFor('https://evil.example/api/coding/paas/v4')).toBeUndefined();
    expect(planEndpointFor('http://api.z.ai/api/coding/paas/v4')).toBeUndefined();
    expect(planEndpointFor('https://opencode.ai/zen/gopher/v1')).toBeUndefined();
    expect(planEndpointFor('https://API.Z.AI/api/coding/paas/v4')?.plan).toBe('Z.ai GLM Coding Plan');
    expect(planEndpointFor('not a url')).toBeUndefined();
    expect(planEndpointFor(undefined)).toBeUndefined();
  });

  it('names a plan for every entry', () => {
    for (const entry of PLAN_ENDPOINTS) expect(entry.plan.length).toBeGreaterThan(0);
  });
});

describe('sharedPlanFor', () => {
  it('names a host that serves a plan and a metered API on one endpoint', () => {
    expect(sharedPlanFor('https://api.minimax.io/anthropic')).toBe('MiniMax Token Plan');
    expect(sharedPlanFor('https://api.synthetic.new/openai/v1')).toBe('Synthetic');
    expect(sharedPlanFor('https://ollama.com/v1')).toBe('Ollama Cloud');
    expect(sharedPlanFor('https://api.deepseek.com/v1')).toBeUndefined();
    expect(sharedPlanFor(undefined)).toBeUndefined();
  });
});
