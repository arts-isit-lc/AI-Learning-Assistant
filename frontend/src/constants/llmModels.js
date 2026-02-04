// Hardcoded LLM model configurations
// This data structure contains the currently supported LLM models

export const LLM_MODELS = {
  LLAMA_70B: {
    id: 'meta.llama3-70b-instruct-v1:0',
    name: 'Llama 3 70B Instruct',
    provider: 'Meta',
    description: 'Large language model optimized for instruction following and educational conversations'
  },
  CLAUDE_3_SONNET: {
    id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', // Try Claude 3.5 Sonnet if available
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    description: 'Advanced model with strong reasoning capabilities and safety features'
  }
};

// Default model ID
export const DEFAULT_LLM_MODEL_ID = LLM_MODELS.LLAMA_70B.id;

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