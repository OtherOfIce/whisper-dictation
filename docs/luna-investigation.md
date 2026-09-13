# Luna cleanup investigation

Checked on 2026-09-11.

## Recommendation

Use `openai/gpt-5.6-luna` through OpenRouter for both modes. Standard mode sends `service_tier: "default"`. Fast mode sends `service_tier: "priority"`. There is no separate Luna Fast model ID.

Use `reasoning_effort: "none"` and a completion limit that scales with transcript length. Transcript cleanup is short and latency-sensitive. OpenAI lists `none` as a supported Luna reasoning effort, while OpenRouter lists `reasoning_effort` and `max_completion_tokens` among the model's supported request fields. Do not send `temperature` or `top_p`; OpenRouter's current model record does not list either field for Luna.

The application should fail open. If cleanup times out or OpenRouter rejects the request, paste the original transcript. A 15 second cleanup timeout keeps an upstream delay from blocking dictation indefinitely. This timeout is an application choice, not a provider guarantee.

## Model and pricing

| Mode | Model | Request field | Input per 1M tokens | Cached input | Output per 1M tokens |
| --- | --- | --- | ---: | ---: | ---: |
| Standard | `openai/gpt-5.6-luna` | `service_tier: "default"` | $0.20 | $0.02 | $1.20 |
| Fast | `openai/gpt-5.6-luna` | `service_tier: "priority"` | $0.40 | $0.04 | $2.40 |

OpenRouter says it bills the tier that actually served the request and returns that tier as a top-level `service_tier` field. Its current Luna provider page labels the premium endpoint `OpenAI Fast` and prices it at twice the standard OpenAI endpoint. OpenAI also describes Fast mode as `service_tier: "fast"` or `"priority"`, with responses reporting `priority`. OpenRouter documents `priority` in its accepted values, so the integration uses that spelling.

At 200 prompt tokens and 50 output tokens, one cleanup costs about $0.00010 on Standard and $0.00020 on Fast. Actual cost depends on the shared system prompt, transcript length, output length, cache use, and any hidden reasoning tokens. OpenRouter's response usage or generation metadata is the authority for a billed request.

The model has a 1,050,000 token context window and a 128,000 token maximum output. Inputs over 272,000 tokens trigger higher rates, which is irrelevant to normal dictation but matters if this service is reused for documents.

## Chat Completions request

Send a JSON request to `POST https://openrouter.ai/api/v1/chat/completions` with the saved key as `Authorization: Bearer <key>` and `Content-Type: application/json`.

```json
{
  "model": "openai/gpt-5.6-luna",
  "service_tier": "default",
  "reasoning_effort": "none",
  "max_completion_tokens": 512,
  "messages": [
    { "role": "system", "content": "<shared cleanup prompt>" },
    { "role": "user", "content": "<raw transcript>" }
  ]
}
```

The example limit is for short text. Production uses UTF-8 byte length plus 256, bounded to 512 through 16,384 tokens, and rejects length-truncated output.

For Fast, change only `service_tier` to `priority`. Read the cleaned text from `choices[0].message.content`. Record `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`, and the response's top-level `service_tier`. OpenRouter may also return `usage.cost`; tolerate its absence. Reject an empty content field and use the original transcript.

## What the benchmark measures

The bounded evaluator runs each representative transcript once on Standard and once on Fast in alternating order. It captures wall-clock latency, the tier actually served, token counts, reported cost when present, and the output. Alternating order reduces warm-up and short-term load bias. Five cases are enough for an initial product decision, but they are not a latency study. Provider load changes minute by minute.

The OpenRouter model page's provider dashboard illustrated that volatility when checked. Its displayed p50 values were 2.50 seconds for OpenAI Standard and 3.62 seconds for OpenAI Fast, despite Fast's premium positioning. Those dashboard figures can change and do not predict this application's short requests. Use the paired local results before paying twice the rate.

## Initial paired run

The first run used five synthetic dictation cases on 2026-09-11. The prompt was subsequently amended to preserve surrounding text when correcting a name or recipient, and the output budget was expanded. These figures describe the earlier prompt, not a validation of the revised version. These are smoke tests for self-correction, spoken punctuation and formatting, filler removal, fact preservation, and keeping a dictated question as content. They are not recordings from the user's Wispr history. The subsequent real-sample comparison and compact production prompt are documented in [Luna on Wispr examples](luna-wispr-investigation.md).

| Mode | Successful requests | Median latency | Mean latency | Reported cost for 5 requests | Human-acceptable outputs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Standard | 5/5 | 893 ms | 1,646 ms | $0.0002692 | 5/5 |
| Fast | 5/5 | 690 ms | 745 ms | $0.0005360 | 4/5 |

Fast cut the median by 203 ms and the mean by 901 ms in this run. One slow 3,661 ms Standard request inflated the mean, so the median is the better summary. Fast cost 1.99 times as much, consistent with the listed 2x token rates.

The failed Fast quality case dropped the corrected recipient from `Send this to Sarah, no wait, send this to Sam, colon, the build is ready for review, full stop.` It returned only `The build is ready for review.` Standard returned `Sam: The build is ready for review.` Since both tiers run the same model and each case ran only once per tier, this result shows a prompt or sampling risk, not evidence that Fast has lower quality. All other outputs preserved the intended content. The original mechanical checker also undercounted `4 p.m.` because it expected the word `four`; the human score above treats both forms as correct, and the runner now accepts either representation through content-neutral checks.

The raw machine-readable run is in [`artifacts/cleanup-eval-luna.json`](../artifacts/cleanup-eval-luna.json). To repeat it with the locally saved DPAPI key:

```powershell
dotnet run --project tools/cleanup-eval/CleanupEval.csproj -c Release -- --output artifacts/cleanup-eval-luna.json
```

The runner loads `Settings.LoadKey()`, calls the same `CleanupService` and shared prompt as the application, and never prints the key.

## Sources

- [OpenRouter Luna model and provider pricing](https://openrouter.ai/openai/gpt-5.6-luna-20260709)
- [OpenRouter service tiers](https://openrouter.ai/docs/guides/features/service-tiers)
- [OpenRouter Chat Completions request fields](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [OpenRouter Models API](https://openrouter.ai/docs/guides/overview/models)
- [OpenAI GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [OpenAI Responses API service tier description](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
