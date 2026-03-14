# Local Inference Scripts

Scripts for setting up and benchmarking local MLX models as an alternative to
cloud-based LLM inference in the bug automation pipeline.

## Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4)
- Python 3.11+
- ~50 GB free disk space (for model downloads)
- `jq` installed (`brew install jq`)

## Scripts

### setup-mlx.sh

Install MLX-LM dependencies and download candidate models.

```bash
./setup-mlx.sh
```

Downloads three models to `~/models/` (override with `MODELS_DIR`):

| Model | Directory | Size |
|-------|-----------|------|
| Qwen3-Coder-30B-A3B-4bit | `~/models/qwen3-coder-30b` | ~18 GB |
| Devstral-Small-2-24B-Instruct-2512-4bit | `~/models/devstral-small-2` | ~14.1 GB |
| Qwen3.5-27B-4bit | `~/models/qwen3.5-27b` | ~14-17 GB |

### serve-model.sh

Start or stop the MLX-LM OpenAI-compatible server.

```bash
# Start serving a model
./serve-model.sh ~/models/qwen3-coder-30b

# Check server status
./serve-model.sh --status

# Stop the server
./serve-model.sh --stop
```

The server runs at `http://localhost:8080/v1/` (override with `MLX_PORT` and
`MLX_HOST`). A PID file is written to `/tmp/mlx-server.pid`.

### benchmark-models.sh

Run the full benchmark suite across all candidate models.

```bash
./benchmark-models.sh
./benchmark-models.sh --models-dir /path/to/models
```

For each model, the benchmark:

1. Starts the MLX server
2. Sends 3 test prompts (bug-fix, content-edit, multi-step)
3. Measures tool-call success/accuracy, tokens/sec, and peak memory
4. Stops the server
5. Moves to the next model

Results are written to `Scripts/sdk/state/training/benchmark-results.json`.

**Exit codes:**
- `0` — All benchmarks passed, at least one model achieved 3/3 tool-call successes
- `1` — Error (missing models, server failure, etc.)
- `2` — Blocker: no model achieved 3/3 tool-call successes

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODELS_DIR` | `~/models` | Directory containing downloaded models |
| `MLX_PORT` | `8080` | Server port |
| `MLX_HOST` | `127.0.0.1` | Server bind address |
| `MLX_HEALTH_TIMEOUT` | `120` | Seconds to wait for server health check |

## Output Schema

`benchmark-results.json` contains:

```json
{
  "models": [
    {
      "model": "Model-Name",
      "model_dir": "directory-name",
      "tool_call_successes": "3/3",
      "tool_call_accuracies": "2/3",
      "avg_tokens_per_sec": 12.5,
      "peak_memory_mb": 8192,
      "prompts": [...]
    }
  ],
  "selection": {
    "primary": "Best-Model",
    "primary_dir": "best-dir",
    "backup": "Second-Model",
    "backup_dir": "second-dir",
    "blocker": false,
    "rationale": "..."
  },
  "benchmark_start": "2026-03-13T...",
  "benchmark_end": "2026-03-13T..."
}
```
