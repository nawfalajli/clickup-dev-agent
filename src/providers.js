// Model providers for the Claude Code agent. Claude Code talks to any Anthropic-compatible
// endpoint (ANTHROPIC_BASE_URL + token), so the same allowlisted, headless agent can run on
// US or Chinese models. Endpoints and default models change often: each one can be overridden
// with <KEY>_BASE_URL in .env, and the model with LLM_MODEL / DECISION_MODEL.

export const PROVIDERS = {
  // ---- USA ----
  anthropic: { region: 'US', label: 'Anthropic Claude (logged-in Claude Code session or ANTHROPIC_API_KEY)' },
  openrouter: {
    region: 'US', label: 'OpenRouter: OpenAI GPT, Google Gemini, xAI Grok, Meta Llama, ... (and Chinese models)',
    key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api', model: 'openai/gpt-5',
  },
  // ---- China ----
  deepseek: {
    region: 'CN', label: 'DeepSeek', key: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat',
  },
  qwen: {
    region: 'CN', label: 'Alibaba Qwen (DashScope / Model Studio)', key: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic', model: 'qwen3-coder-plus',
  },
  kimi: {
    region: 'CN', label: 'Moonshot Kimi', key: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k2-turbo-preview',
  },
  glm: {
    region: 'CN', label: 'Zhipu GLM (Z.ai)', key: 'ZAI_API_KEY',
    baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6',
  },
  minimax: {
    region: 'CN', label: 'MiniMax', key: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2',
  },
  // ---- Anything else Anthropic-compatible (LiteLLM proxy for OpenAI / Gemini direct, self-hosted, ...) ----
  custom: { region: '', label: 'Custom Anthropic-compatible endpoint', key: 'CUSTOM_API_KEY', baseUrl: '', model: '' },
};

/**
 * Resolve a provider + model into the env overrides for the Claude Code child process.
 * `anthropic` changes nothing (Claude Code's own login / ANTHROPIC_API_KEY).
 */
export function resolveModel(env, providerName, model) {
  const name = providerName?.trim().toLowerCase() || 'anthropic';
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown model provider "${providerName}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  if (name === 'anthropic') return { provider: name, model: model?.trim() || '', env: {} };

  const baseUrl = env[p.key.replace(/_API_KEY$/, '_BASE_URL')]?.trim() || p.baseUrl;
  const token = env[p.key]?.trim();
  const id = model?.trim() || p.model;
  const missing = [!token && p.key, !baseUrl && p.key.replace(/_API_KEY$/, '_BASE_URL'), !id && 'LLM_MODEL'].filter(Boolean);
  if (missing.length) throw new Error(`Provider ${name} needs in .env: ${missing.join(', ')}`);

  return {
    provider: name,
    model: id,
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_API_KEY: undefined, // never send the Anthropic key to another provider
      ANTHROPIC_MODEL: id,
      // Claude Code's background calls use the haiku/sonnet/opus aliases: map them all to this model.
      ANTHROPIC_DEFAULT_OPUS_MODEL: id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: id,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
      ANTHROPIC_SMALL_FAST_MODEL: id,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
}

export const describeModel = ({ provider, model }) => `${provider}${model ? `/${model}` : ''}`;
