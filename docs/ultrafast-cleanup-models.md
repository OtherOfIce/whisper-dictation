# Ultra-fast cleanup model options

Checked on 2026-09-15. The current Luna Standard baseline is about 1.1 to 1.5 seconds end to end for our short cleanup calls.

## Answer

Yes. There are credible ways to get below Luna's current latency. The strongest public evidence points to a roughly 0.5 to 0.7 second target, with a possible enterprise route near 0.2 seconds.

I would test these in this order:

1. **Cerebras `gpt-oss-120b`**, pinned through OpenRouter or called directly. OpenRouter's current traffic data shows about 0.24 seconds to first token and 0.62 seconds end to end on Cerebras. Cerebras advertises roughly 3,000 generated tokens per second. OpenAI describes the model as a strong instruction follower. The drawback is that its lowest reasoning setting is `low`, not `none`.
2. **Cerebras Qwen 3.8 27B with reasoning disabled**, called directly. Cerebras advertises about 1,850 tokens per second and explicitly supports `reasoning_effort: "none"`. That combination is unusually well suited to a short rewrite. There is no public short-request latency measurement yet, so it is a strong benchmark candidate rather than a proven sub-second option.
3. **Inception Mercury 2 with `reasoning_effort: "instant"`**, preferably through Inception's direct API. Inception designed instant mode for reflex-speed responses and says Mercury 2 decodes above 1,000 tokens per second. Its production voice material reports median model response latency close to 170 milliseconds, but that number comes from a voice workload with provisioned capacity. It is not a promise for the public text endpoint.
4. **Inception Mercury 2.5**, direct rather than through OpenRouter. Inception advertises 1,107 tokens per second and quality comparable to Luna Low. The current OpenRouter route is much less impressive at about 0.68 seconds to first token and 65 tokens per second, so the direct route is the interesting one.
5. **Groq `gpt-oss-20b`**, ideally on its enterprise Performance tier. Groq advertises about 1,000 tokens per second. The enterprise tier targets low p99 time to first token and includes a 99.9% availability SLA, but Groq does not publish a fixed TTFT number. Current OpenRouter traffic shows the Groq route taking around 1.5 seconds end to end, so ordinary Groq routing may not beat Luna for this particular short request.

The first benchmark should be Cerebras `gpt-oss-120b`. It has the cleanest evidence of a large improvement on the same kind of non-streamed API call we make today. Mercury instant is the more exciting experiment, but its sub-200 millisecond result is tied to Inception's voice setup and may require direct or enterprise access.

## Why token speed is not enough

Our completion is short. At 1,000 tokens per second, generating 30 tokens takes about 30 milliseconds. The rest is queueing, prompt processing, network time, reasoning tokens, and response handling. A model advertised at 3,000 tokens per second can still lose to one at 500 tokens per second if its first token arrives later.

For that reason, the selection metric must be client-observed end-to-end latency from this app in the UK. Provider throughput is only a screening signal.

## Evidence

| Candidate | Published or observed speed | Reasoning control | Operational note | What remains unproved |
| --- | --- | --- | --- | --- |
| Cerebras `gpt-oss-120b` | Cerebras advertises about 3,000 tokens/s. OpenRouter currently observes 0.24 s TTFT, 689 tokens/s, and 0.62 s average end to end on the Cerebras route. | `low`, `medium`, or `high`; cannot be disabled | Public production model. Direct enterprise endpoints can use a private-preview priority tier. | Our cleanup quality and latency from the UK |
| Cerebras Qwen 3.8 27B | Cerebras advertises about 1,850 tokens/s. | `none`, `low`, `medium`, or `high`; `none` disables reasoning | Public shared tier. | Client-observed TTFT, end-to-end latency, and cleanup quality |
| Mercury 2 instant | Inception advertises over 1,000 tokens/s. A production voice customer reports p50 under 0.2 s, and Inception reports latency close to 170 ms for that workload. | `instant`, `low`, `medium`, `high` | Direct API is OpenAI-compatible. Inception offers higher-throughput capacity for workload tests. | Whether public text cleanup reaches anything close to 170 ms |
| Mercury 2.5 | Inception advertises 1,107 tokens/s. OpenRouter currently observes 0.68 s TTFT and 65 tokens/s. | Tunable reasoning, but public material does not document a true `none` mode | New production model, available through Inception, Baseten, and OpenRouter. OpenRouter has one upstream route. | Direct API latency and conservative editing quality |
| Groq `gpt-oss-20b` | Groq advertises about 1,000 tokens/s. OpenRouter currently observes around 1.5 s average end to end on Groq. | `low`, `medium`, or `high`; cannot be disabled | Production model. Enterprise Performance tier has 99.9% availability SLA and a contractual latency guarantee. | Whether Performance tier or direct routing beats Luna enough to justify another provider |
| Groq Qwen 3.8 27B | Groq advertises 450+ tokens/s. | Supports non-thinking instruct mode | Preview model, $0.80/M input and $4/M output | Quality, TTFT, and production stability |
| OpenAI Fast mode | OpenAI says GPT-5.6 Sol is up to 2.5 times faster than Standard and offers pay-as-you-go Fast routing. | Model-dependent | Same vendor as Luna. Published SLA is throughput-based, not a sub-second TTFT promise. | A larger model may still be slower than Luna for a tiny rewrite |

OpenRouter's live metrics are useful because they reflect real routed traffic. They are rolling observations, not SLAs, and can change with load. OpenRouter says its `latency` field is time to first token. Its provider routing can sort by latency and use fallbacks, but direct provider calls remove one gateway from the path.

## Capability fit

`gpt-oss-120b` has the best capability case among the high-speed options. OpenAI says it has strong instruction following, and that it reaches near-parity with o4-mini on core reasoning evaluations. That does not establish cleanup quality, but it makes a catastrophic quality drop less likely than switching to a tiny generic model.

Mercury is unusually well matched to rewriting. Inception publishes instruction-following results for Mercury 2 and says its `low` setting beats GPT-4.1 on IFBench. `instant` gives up some intelligence for speed. Mercury 2.5 raises claimed general quality by 40 percent over Mercury 2, but the current public material does not show our exact conservative-editing task.

Groq's 20B option is probably capable enough for ordinary punctuation and false-start removal. It is the riskiest of the main three for subtle spoken corrections because it is the smallest model. Groq Qwen 3.8 is interesting because reasoning can be disabled, but preview status makes it a poor default today.

## Benchmark design

Run each candidate on the same eight reviewed Wispr examples and five exact insertion cases. Use at least 30 interleaved repetitions per model, because a one-off median hides cold starts and queues.

Record:

- end-to-end p50, p90, and p99 from the app;
- provider-reported TTFT where available;
- exact insertion pass rate and micro-WER;
- context-copy and over-editing failures;
- reasoning tokens and total output tokens;
- provider errors and fallback route;
- warm and cold behavior separately.

For OpenRouter, pin Cerebras first. A latency-sorted fallback policy can follow after quality is established. For direct providers, cap output tightly and keep the static system prompt first so provider prompt caching can work where supported.

I would treat a p50 below 700 milliseconds and p90 below one second, with no material quality regression, as enough to replace Luna. If Mercury instant gets close to 200 milliseconds on our workload, it changes the feel of the product and is worth paying for.

## Measured Cerebras benchmark

We added evaluator-only model, provider, reasoning-effort, and completion-budget overrides, then pinned `openai/gpt-oss-120b` to the OpenRouter provider slug `cerebras` with provider fallbacks disabled. The production Luna configuration was not changed.

The first synthetic run used low reasoning. It was extremely fast at a 239 ms median, but it failed two context insertions, missed a self-correction, and answered a dictated question with a refusal. Low reasoning is not safe for this cleanup prompt.

Medium reasoning fixed the refusal and context-copy failures. It scored 31 of 36 checks with a 418 ms median on the ten synthetic cases. Luna previously scored 32 of 36 on the same cases. GPT-OSS still missed one self-correction and one exact mid-sentence casing result.

The comparable reviewed benchmark uses the eight approved MAI Clean transcripts with saved insertion context. Each model was called once per sample, so these latency figures are useful measurements rather than stable distributions.

| Cleanup configuration | Successful | Median | Observed p90 | Clean micro-WER | Exact matches | Reasoning tokens | Total cleanup cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Luna Standard, reasoning off | 8/8 | 1,310 ms | 2,266 ms | 9.7% | 1/8 | 0 | $0.000985 |
| GPT-OSS 120B on Cerebras, low | 8/8 | 399 ms | 873 ms | 14.4% | 0/8 | 834 | $0.002066 |
| GPT-OSS 120B on Cerebras, medium | 8/8 | 618 ms | 1,165 ms | 11.7% | 0/8 | 3,004 | $0.003682 |

Medium GPT-OSS roughly halved both median and observed p90 latency, but its text was less accurate than Luna and it cost 3.7 times as much on this run. The difference is still tiny in absolute money. The material problem is quality, not cost. Low reasoning is fast enough to feel immediate, but its instruction-following failures rule it out. Medium reasoning is credible enough for model-specific prompt work, but it should not replace Luna on the current evidence.

The medium reviewed run uses a 2,048-token completion ceiling. GPT-OSS counts hidden reasoning inside the completion limit, and one earlier long sample exhausted the production-style 512-token minimum. Raising this ceiling does not force extra tokens; it prevents otherwise valid cleanup from being truncated.

### Example-led prompt trial

An Astra low-effort pass produced three short prompts with positive and negative examples. We screened all three on the ten synthetic cases using Cerebras GPT-OSS 120B at medium reasoning.

| Prompt | Successful | Checks | Median | Cost |
| --- | ---: | ---: | ---: | ---: |
| Current app prompt | 10/10 | 31/36 | 418 ms | $0.002335 |
| `minimal-edit-examples` | 10/10 | 33/36 | 466 ms | $0.002963 |
| `ordered-edit-contract` | 10/10 | 33/36 | 612 ms | $0.003668 |
| `insertion-first` | 9/10 | 31/34 | 427 ms | $0.002780 reported |
| `cleanroom-three-gates`, run 1 | 10/10 | 33/36 | 658 ms | $0.002811 |
| `cleanroom-three-gates`, run 2 | 10/10 | 33/36 | 912 ms | $0.002818 |

`minimal-edit-examples` was the best screen result, but it regressed on the eight reviewed Wispr cases. Clean micro-WER rose from 11.7% with the current prompt to 14.1%, while median latency was similar at 588 ms and total cleanup cost was $0.003537. The examples improved the narrow behaviors in the synthetic set but did not improve general cleanup. Keep the current production prompt and expand the benchmark before another prompt iteration.

The clean-room three-gate prompt also failed the reviewed set. Clean micro-WER rose to 18.1%, median latency rose to 1,814 ms, and the observed p90 was 3,412 ms. It aggressively rewrote longer passages despite an explicit instruction not to paraphrase. Its first synthetic run also deleted `Send this to` from one correction case while satisfying the old loose checks, so that assertion now requires the complete phrase. The current production prompt remains the best GPT-OSS prompt tested.

Reproduction commands:

```powershell
dotnet run --project tools\cleanup-eval -c Release -- --tier standard --model openai/gpt-oss-120b --provider cerebras --reasoning-effort medium --output artifacts\cleanup-eval-gpt-oss-120b-cerebras-medium.json

dotnet run --project tools\wispr-cleanup-eval -c Release -- --input artifacts\transcribe-eval-luna-candidates-mai-clean.json --context-source artifacts\wispr-corpus\luna-review --tier standard --model openai/gpt-oss-120b --provider cerebras --reasoning-effort medium --minimum-completion-tokens 2048 --output artifacts\cleanup-eval-gpt-oss-120b-cerebras-medium-2048-wispr.json
```

Private reports:

- `artifacts/cleanup-eval-gpt-oss-120b-cerebras.json`
- `artifacts/cleanup-eval-gpt-oss-120b-cerebras-medium.json`
- `artifacts/cleanup-eval-gpt-oss-120b-cerebras-wispr.json`
- `artifacts/cleanup-eval-gpt-oss-120b-cerebras-medium-2048-wispr.json`

## Sources

- [OpenRouter `gpt-oss-120b` provider measurements](https://openrouter.ai/openai/gpt-oss-120b)
- [OpenRouter `gpt-oss-20b` provider measurements](https://openrouter.ai/openai/gpt-oss-20b/apps)
- [OpenRouter Mercury 2.5 provider measurements](https://openrouter.ai/inception/mercury-2.5)
- [OpenRouter provider routing and rolling metrics](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Cerebras supported models and advertised speed](https://inference-docs.cerebras.ai/models/overview)
- [Cerebras reasoning controls](https://inference-docs.cerebras.ai/capabilities/reasoning)
- [Cerebras service tiers](https://inference-docs.cerebras.ai/capabilities/service-tiers)
- [Groq GPT-OSS 20B model page](https://console.groq.com/docs/model/openai/gpt-oss-20b)
- [Groq Performance tier](https://console.groq.com/docs/performance-tier)
- [Groq service tiers](https://console.groq.com/docs/service-tiers)
- [Groq Qwen 3.8 27B model page](https://console.groq.com/docs/model/qwen/qwen3.8-27b)
- [Inception Mercury 2 latency and reasoning modes](https://www.inceptionlabs.ai/blog/mercury-2-the-first-reasoning-model-fast-enough-to-pick-up-the-phone)
- [Inception Mercury 2.5 announcement](https://www.inceptionlabs.ai/blog/introducing-mercury-2-5)
- [Inception API rate limits and load warning](https://docs.inceptionlabs.ai/get-started/rate-limits)
- [OpenAI GPT-OSS release and instruction-following claims](https://openai.com/index/introducing-gpt-oss/)
- [OpenAI Fast mode](https://openai.com/api-fast-mode/)
