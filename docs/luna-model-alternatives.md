# Luna model alternatives

Checked on 2026-09-15. Prices and endpoint health change, so the OpenRouter APIs linked below are the source of truth.

## Short answer

Luna remains the sensible default. It already performs well on the reviewed cleanup set, accepts `reasoning_effort: "none"`, and OpenRouter can route it across OpenAI, Azure, and Amazon Bedrock endpoints. Nothing in the public material proves that a cheaper model will clean these transcripts better.

Four models are worth a controlled benchmark if latency becomes important:

1. `google/gemini-2.5-flash-lite` is the best first comparison. It costs $0.10 per million input tokens and $0.40 per million output tokens, has a 1M context window, and disables thinking by default. When checked, OpenRouter's live performance view showed roughly 0.26 to 0.53 seconds of provider latency and 1.07 to 1.31 seconds end to end on its better routes. Luna's OpenAI route was around 2.50 seconds on the same live view. These figures move with traffic, but they make Gemini a credible latency candidate.
2. `inception/mercury-2.5` is the more aggressive latency experiment. Inception reports 1,107 generated tokens per second, and explicitly lists voice among its latency-sensitive production workloads. OpenRouter currently charges a promotional $0.04 per million input tokens and $0.15 per million output tokens. It accepts reasoning effort `none`. The catch is operational: OpenRouter currently lists one provider endpoint, so it has less fallback depth than Luna.
3. `mistralai/mistral-small-2603` is the conservative non-OpenAI option. It costs $0.15 per million input tokens and $0.60 per million output tokens, accepts reasoning effort `none`, and has a 256K context window. OpenRouter currently lists four endpoints across Mistral and Venice, including a zero-data-retention Mistral endpoint. Its live page showed roughly 0.38 to 0.45 seconds of provider latency and 1.22 to 1.42 seconds end to end on the better routes.
4. `mistralai/mistral-small-3.2-24b-instruct` is older, but unusually well matched to this job on paper. OpenRouter describes it as optimized for instruction following and repetition reduction. It costs $0.075 per million input tokens and $0.20 per million output tokens. The live page showed a best provider median latency of 0.46 seconds, 37 tokens per second, three providers, and 99.95% routed availability over three days.

`qwen/qwen3.8-flash` is cheap, but its current OpenRouter end-to-end latency starts around 4.43 seconds. That rules it out as a latency candidate for now. It also has only one Alibaba endpoint and does not advertise `none` as a supported reasoning effort.

I would benchmark Gemini first, then Mercury and the two Mistral models. That is enough to answer the question without turning a cheap cleanup call into a model tournament.

## Verified facts

| Model | OpenRouter input / output per 1M tokens | Context | Reasoning off advertised | Current OpenRouter endpoint situation |
| --- | ---: | ---: | --- | --- |
| `openai/gpt-5.6-luna` | $0.20 / $1.20 | 1.05M | Yes, `none` | Seven listed endpoints across OpenAI, Azure, and Amazon Bedrock; OpenRouter showed 99.82% availability over three days |
| `google/gemini-2.5-flash-lite` | $0.10 / $0.40 | 1.05M | Yes, thinking is off by default | Five listed endpoints across Google Vertex and AI Studio variants |
| `inception/mercury-2.5` | $0.04 / $0.15 promotional | 260K | Yes, `none` | One Inception endpoint, reporting 100% uptime over the preceding day when checked |
| `mistralai/mistral-small-2603` | $0.15 / $0.60 | 262K | Yes, `none` | Four endpoints; all reported at least 99.93% uptime over the preceding day when checked |
| `mistralai/mistral-small-3.2-24b-instruct` | $0.075 / $0.20 | 256K | Non-reasoning model | Three providers; OpenRouter showed 99.95% routed availability over three days |
| `qwen/qwen3.8-flash` | $0.15 / $0.47 | 1M | Not advertised as an effort option | One Alibaba endpoint, reporting 99.79% uptime over the preceding day when checked |
| `nvidia/nemotron-3.5-lightning` | $0.08 / $0.20 model-list price | 262K | Model is not reasoning-mandatory, but `none` is not advertised as an effort option | Four providers; three reported at least 99.77% uptime over the preceding day, while one endpoint had a poor recent snapshot |
| `openai/gpt-4o-mini` | $0.15 / $0.60 | 128K | Non-reasoning model | Three endpoints across OpenAI and Azure |

The Luna price above is the standard model-list price used for the current comparison. OpenRouter also lists a cheaper OpenAI Flex endpoint at $0.10 input and $0.60 output and a priority endpoint at $0.40 input and $2.40 output. Flex trades away latency guarantees, so it is not a useful way to optimize an interactive paste path.

Mercury's $0.04 / $0.15 rate is explicitly an 80% launch promotion. It may return to Inception's stated $0.20 / $0.75 list price. The recommendation does not depend on the discount because even the list price stays within Luna's current rate.

OpenRouter says its default provider routing prioritizes providers without recent outages, then weights the cheapest stable candidates more heavily, and keeps the rest as fallbacks. It also supports explicit routing by latency or throughput. That means endpoint count matters, but it is not a reliability guarantee. The uptime figures above are a point-in-time API snapshot, not an SLA.

## What is recommendation rather than fact

No public benchmark measures our job: short dictation cleanup, conservative editing, spoken correction handling, and exact insertion fitting. General reasoning, coding, or chat scores would be weak evidence here. The only defensible way to decide is to run the same reviewed corpus and context cases through each candidate.

For that comparison, record:

- exact pass rate on the five insertion cases;
- micro-WER on the eight reviewed Wispr examples;
- instruction-following failures, especially lost qualifications or over-editing;
- context-copy validation failures;
- end-to-end median, p90, and p99 latency over repeated interleaved runs;
- errors and provider endpoint used;
- actual reported cost and reasoning-token count.

Interleave models instead of running one complete model at a time. That reduces bias from temporary provider load. Keep reasoning off and use the same prompt and output cap. A model should replace Luna only if it preserves cleanup quality and materially improves tail latency. Saving a fraction of a cent across many dictations is pleasant, but it is not worth one extra bad paste.

## Sources

- [OpenRouter models API](https://openrouter.ai/api/v1/models), used for current prices, context sizes, supported parameters, and reasoning metadata.
- [OpenRouter Luna endpoint API](https://openrouter.ai/api/v1/models/openai/gpt-5.6-luna-20260709/endpoints)
- [OpenRouter Luna live model page](https://openrouter.ai/openai/gpt-5.6-luna-20260709)
- [OpenRouter Gemini 2.5 Flash-Lite performance](https://openrouter.ai/google/gemini-2.5-flash-lite/performance)
- [OpenRouter Mercury 2.5 endpoint API](https://openrouter.ai/api/v1/models/inception/mercury-2.5-20260908/endpoints)
- [OpenRouter Mistral Small 4 endpoint API](https://openrouter.ai/api/v1/models/mistralai/mistral-small-2603/endpoints)
- [OpenRouter Mistral Small 4 live pricing and performance](https://openrouter.ai/mistralai/mistral-small-2603/pricing)
- [OpenRouter Mistral Small 3.2 live model page](https://openrouter.ai/mistralai/mistral-small-3.2-24b-instruct)
- [OpenRouter Qwen3.8 Flash endpoint API](https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash-20260826/endpoints)
- [OpenRouter Nemotron 3.5 Lightning endpoint API](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-lightning-20260807/endpoints)
- [OpenRouter GPT-4o mini endpoint API](https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Inception's Mercury 2.5 announcement](https://www.inceptionlabs.ai/blog/introducing-mercury-2-5)
- [Mistral Small 4 documentation](https://docs.mistral.ai/models/mistral-small-4-0-26-03)
- [Qwen3.8 Flash announcement](https://www.alibabacloud.com/blog/qwen-3-8-flash-next-a-new-architecture-towards-ultimate-cost-efficiency_603501)
- [NVIDIA Nemotron 3.5 Lightning documentation](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html)
