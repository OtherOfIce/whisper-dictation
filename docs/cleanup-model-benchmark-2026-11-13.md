# Cleanup model benchmark

Measured on 2026-11-13 from the UK. The question was why Local Whisper waits about 1.36 s from stop to paste when Wispr Flow now waits about 0.4 s, and whether a faster cleanup model closes the gap.

## Where the time went

Local Whisper's 31 dictations on 13 November had a median stop-to-paste wait of 1,356 ms: about 210 ms transcription, 1,070 ms Luna Fast cleanup, and 45 ms paste. Wispr Flow's nine dictations that day (v1.6.872) had a median `e2eLatency` of 402 ms, down from 483 ms in September.

A streamed Luna Fast request split as follows:

| Dictation | First token | Generation | Total |
| --- | ---: | ---: | ---: |
| Short, 37 output tokens | ~620 ms | ~265 ms | ~905 ms |
| Long, ~110 output tokens | ~690 ms | ~510 ms | ~1,200 ms |

The system prompt was already 99.8% cached, so prompt processing was not the bottleneck. The fixed time to first token dominated. Streaming partial transcripts into cleanup cannot remove it, and MAI's last segment always finalised after stop (159 of 159 recent sessions), so a speculative "cleanup ready at stop" approach would never hit. OpenAI predicted outputs gave no measurable gain through OpenRouter.

## Candidates

Latency used the production request shape with the user's dictionary as vocabulary, three synthetic dictations, and 6 to 8 interleaved rounds.

| Route | First token | Median | p90 | Notes |
| --- | ---: | ---: | ---: | --- |
| DeepSeek V4.1 Flash Fast, Vercel | 255 ms | 296 ms | 396 ms | Worst 433 ms, no errors |
| Qwen 3.8 27B, Cerebras via Vercel | 282 ms | 313 ms | 511 ms | No 429s in 24 requests |
| Qwen 3.8 27B, Cerebras via OpenRouter | 299 ms | 340 ms | 712 ms | Repeated upstream 429s |
| DeepSeek V4 Flash, Fireworks via OpenRouter | 114 ms | 348 ms | 696 ms | Copied insertion context |
| gpt-oss-120b, Cerebras via OpenRouter | ~420 ms | ~440 ms | ~760 ms | Weak cleanup, hidden reasoning |
| Llama 3.3 70B, Groq | 294 ms | 438 ms | 639 ms | Lower quality |
| Luna Fast (baseline) | ~620 ms | ~850-1,060 ms | ~1,500 ms | |
| GPT-6.1 Sol, OpenAI ultrafast | ~1,000-2,300 ms | 1,140-2,450 ms | | Fast generation, slow first token, reasoning mandatory |

Mercury 2, 2.5 and 3, Claude Haiku 5.5, Gemini 3.1/3.5 Flash Lite, GLM 5.3 Flash, MiniMax M3.1 Flash and Nemotron 3.5 Lightning were all slower than 430 ms or dropped words.

## Prompt tuning

Smaller models acted as assistants with the Luna prompt: they answered dictated questions and translated dictated "translate this" requests. They also skipped punctuation on raw input and left "scratch that" in place. Each fast model therefore gets its own prompt:

- `shared/cleanup/luna-cleanup-prompt.txt` stays unchanged and is shared with Android.
- `shared/cleanup/deepseek-cleanup-prompt.txt` adds a text-filter role, an always-clean rule for unpunctuated input, British spelling, list and line-break commands, discard phrases, and stricter insertion rules.

Prompts were tuned on `tools/cleanup-eval/cases/tuning.json`. Results are reported on the built-in suite and on `tools/cleanup-eval/cases/holdout.json`, which was not used for tuning. Two holdout checks were corrected after the first baseline because they were scoring bugs, not model behaviour.

| Model and prompt | Built-in suite | Holdout | Cleanup median |
| --- | ---: | ---: | ---: |
| Luna Fast, Luna prompt | 164/166 | 148/168 | ~820 ms |
| Qwen 3.8 27B, Luna prompt | 161/166 | 133/166 | ~310 ms |
| Qwen 3.8 27B, tuned prompt | 166/166 | 165/168 | ~320 ms |
| DeepSeek V4.1 Flash, Luna-derived Qwen prompt | 163/164, 1 error | 161/168 | |
| DeepSeek V4.1 Flash Fast, shipped prompt, via Vercel | 166/166 | 166/168 | ~252 ms |

Run the production profile with:

```powershell
dotnet run --project tools/cleanup-eval -c Release -- --cleanup-mode deepseek --repeat 2
dotnet run --project tools/cleanup-eval -c Release -- --cleanup-mode deepseek --cases tools/cleanup-eval/cases/holdout.json --repeat 2
```

## Cost

Vercel reported about $0.00016 per cached DeepSeek request and $0.0016 for the first uncached one. Luna Fast cost $0.18 for the 618 cleanups in the 30 days to 13 November, about $0.00029 each. Qwen on Cerebras would have cost about $1.65 for the same month because Cerebras charges full price for cached input.

## Production behaviour

DeepSeek mode requires the Vercel AI Gateway key. Its timeout starts at 2.5 s and grows by 2 ms per transcript byte, up to the normal 15 s cleanup limit. If DeepSeek fails, times out or returns text that repeats the insertion context, the same cleanup is retried on Luna Fast when an OpenRouter key is saved; the fallback is recorded in the session metrics. Android does not offer DeepSeek yet and refuses that synced value, keeping its current cleanup setting.
