// Standard list prices in USD per million tokens, checked 1 November 2026.
// Direct Meta, Claude and ChatGPT rates are the vendor's standard price (the short-context
// rate where a model has a higher long-context tier). OpenRouter rates are the prompt and
// completion prices published at https://openrouter.ai/api/v1/models. A saved model's own
// price still wins. DeepSeek, Mistral and GLM are selected through OpenRouter.
// Meta: https://dev.meta.ai/docs/pricing-rate-limits
// Claude: https://platform.claude.com/docs/en/about-claude/pricing
// ChatGPT: https://developers.openai.com/api/docs/pricing
export const MODEL_CATALOG=[
  {provider:'meta',family:'Meta',model:'muse-spark-1.3',label:'Muse Spark 1.3',input:1.25,output:4.25},
  {provider:'meta',family:'Meta',model:'muse-spark-1.3-contributor',label:'Muse Spark 1.3 Contributor',input:0.1,output:0.2,note:'Meta may use what you send to train models.'},
  {provider:'meta',family:'Meta',model:'muse-wonder-1.0',label:'Muse Wonder',input:4,output:20},
  {provider:'anthropic',family:'Claude',model:'claude-haiku-5-5',label:'Claude Haiku 5.5',input:0.1,output:0.5},
  {provider:'anthropic',family:'Claude',model:'claude-sonnet-5-5',label:'Claude Sonnet 5.5',input:2,output:10},
  {provider:'anthropic',family:'Claude',model:'claude-opus-5-5',label:'Claude Opus 5.5',input:4,output:20},
  {provider:'anthropic',family:'Claude',model:'claude-fable-5-1',label:'Claude Fable 5.1',input:10,output:50},
  {provider:'openai',family:'ChatGPT',model:'gpt-6-luna',label:'GPT-6 Luna',input:0.1,output:0.5},
  {provider:'openai',family:'ChatGPT',model:'gpt-6.1-terra',label:'GPT-6.1 Terra',input:1,output:5},
  {provider:'openai',family:'ChatGPT',model:'gpt-6.1-sol',label:'GPT-6.1 Sol',input:2,output:10},
  {provider:'openai',family:'ChatGPT',model:'gpt-5.5',label:'GPT-5.5',input:5,output:30},
  {provider:'openai',family:'ChatGPT',model:'gpt-6-astra',label:'GPT-6 Astra',input:10,output:50},
  {provider:'openrouter',family:'Free',model:'openrouter/free',label:'OpenRouter Free',input:0,output:0},
  {provider:'openrouter',family:'Meta',model:'meta/muse-spark-1.3',label:'Muse Spark 1.3',input:1.25,output:4.25},
  {provider:'openrouter',family:'Meta',model:'meta/muse-spark-1.3-contributor',label:'Muse Spark 1.3 Contributor',input:0.1,output:0.2,note:'Meta may use what you send to train models.'},
  {provider:'openrouter',family:'Meta',model:'meta/muse-wonder',label:'Muse Wonder',input:4,output:20},
  {provider:'openrouter',family:'Claude',model:'anthropic/claude-haiku-5.5',label:'Claude Haiku 5.5',input:0.1,output:0.5},
  {provider:'openrouter',family:'Claude',model:'anthropic/claude-sonnet-5.5',label:'Claude Sonnet 5.5',input:2,output:10},
  {provider:'openrouter',family:'Claude',model:'anthropic/claude-opus-5.5',label:'Claude Opus 5.5',input:4,output:20},
  {provider:'openrouter',family:'Claude',model:'anthropic/claude-fable-5.1',label:'Claude Fable 5.1',input:10,output:50},
  {provider:'openrouter',family:'ChatGPT',model:'openai/gpt-6-luna',label:'GPT-6 Luna',input:0.1,output:0.5},
  {provider:'openrouter',family:'ChatGPT',model:'openai/gpt-6.1-terra',label:'GPT-6.1 Terra',input:1,output:5},
  {provider:'openrouter',family:'ChatGPT',model:'openai/gpt-6.1-sol',label:'GPT-6.1 Sol',input:2,output:10},
  {provider:'openrouter',family:'ChatGPT',model:'openai/gpt-5.5',label:'GPT-5.5',input:5,output:30},
  {provider:'openrouter',family:'ChatGPT',model:'openai/gpt-6-astra',label:'GPT-6 Astra',input:10,output:50},
  {provider:'openrouter',family:'DeepSeek',model:'deepseek/deepseek-v4.1-flash',label:'DeepSeek V4.1 Flash',input:0.045,output:0.5},
  {provider:'openrouter',family:'DeepSeek',model:'deepseek/deepseek-v4.1-flash-1017',label:'DeepSeek V4.1 Flash 1017',input:0.15,output:0.6},
  {provider:'openrouter',family:'Mistral',model:'mistralai/ministral-14b-2512',label:'Ministral 3 14B',input:0.2,output:0.2},
  {provider:'openrouter',family:'Mistral',model:'mistralai/mistral-small-2603',label:'Mistral Small 4',input:0.15,output:0.6},
  {provider:'openrouter',family:'Mistral',model:'mistralai/mistral-large-4-0',label:'Mistral Large 4',input:0.7,output:2.1},
  {provider:'openrouter',family:'GLM',model:'z-ai/glm-5.3-flash',label:'GLM 5.3 Flash',input:0.0285,output:0.0923},
  {provider:'openrouter',family:'GLM',model:'z-ai/glm-5.3-flashx',label:'GLM 5.3 FlashX',input:0.37,output:1.25},
  {provider:'openrouter',family:'GLM',model:'z-ai/glm-5v-turbo',label:'GLM 5V Turbo',input:1.2,output:4},
];
export function catalogEntry(provider,model){
  const id=String(model??'').trim();
  return MODEL_CATALOG.find(entry=>entry.provider===provider&&entry.model===id)||null;
}
export function catalogModels(provider){return MODEL_CATALOG.filter(entry=>entry.provider===provider);}
