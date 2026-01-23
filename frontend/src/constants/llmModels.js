export const LLM_MODELS = [
  {
    id: "meta.llama3-70b-instruct-v1:0",
    name: "Llama 3 70B Instruct",
    description: "Best for complex reasoning and detailed responses"
  },
  {
    id: "meta.llama3-8b-instruct-v1:0", 
    name: "Llama 3 8B Instruct",
    description: "Faster responses, good for general conversations"
  },
  {
    id: "anthropic.claude-3-sonnet-20240229-v1:0",
    name: "Claude 3 Sonnet", 
    description: "Balanced performance and speed"
  },
  {
    id: "anthropic.claude-3-haiku-20240307-v1:0",
    name: "Claude 3 Haiku",
    description: "Fastest responses, good for simple tasks"
  }
];

export const DEFAULT_LLM_MODEL = "meta.llama3-70b-instruct-v1:0";