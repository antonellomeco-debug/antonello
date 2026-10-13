// Modelli di Claude che gli agenti possono usare, con i prezzi indicativi in $ per milione di token
// (input, output) per stimare la spesa API. Un modello che non è in elenco non si può scegliere.
export const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50],
};
export const MODELS = Object.keys(PRICES);
// Livelli di "impegno" accettati dall'API di Claude (output_config.effort).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
