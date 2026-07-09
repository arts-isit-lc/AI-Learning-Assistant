// Hardcoded LLM model configurations
// This data structure contains the currently supported LLM models

export const LLM_MODELS = {
  LLAMA_70B: {
    id: 'meta.llama3-70b-instruct-v1:0',
    name: 'Llama 3 70B Instruct',
    provider: 'Meta',
    description: 'Large language model optimized for instruction following and educational conversations'
  },
  CLAUDE_SONNET_4_5: {
    // Geo-US cross-Region inference profile id (kept in sync with the backend
    // catalog in text_generation/src/constants/llm_models.py).
    id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    description: 'High-capability model with strong reasoning, coding, and safety features'
  }
};

// Default model ID for new courses and the Settings dropdown. Llama 3 70B stays
// selectable pending a future replacement decision.
export const DEFAULT_LLM_MODEL_ID = LLM_MODELS.CLAUDE_SONNET_4_5.id;

// Helper function to get model options for dropdowns
export const getLLMModelOptions = () => {
  return Object.values(LLM_MODELS).map(model => ({
    value: model.id,
    label: model.name,
    provider: model.provider,
    description: model.description
  }));
};

// Helper function to get model name by ID
export const getModelNameById = (modelId) => {
  const model = Object.values(LLM_MODELS).find(m => m.id === modelId);
  return model ? model.name : 'Unknown Model';
};