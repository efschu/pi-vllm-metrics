import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

interface VllmMetrics {
  promptThroughput: number | null;
  generationThroughput: number | null;
  kvCacheUsage: number | null;
  requestsRunning: number | null;
  requestsWaiting: number | null;
}

interface CounterSnapshot {
  promptTokens: number;
  generationTokens: number;
  timestamp: number;
}

interface PluginConfig {
  vllmUrl: string;
  pollInterval: number;
}

// ── Prometheus parser ────────────────────────────────────────────────────────

function parsePrometheus(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.includes(" ")) continue;
    const idx = line.lastIndexOf(" ");
    const key = line.slice(0, idx);
    const val = parseFloat(line.slice(idx + 1));
    if (!Number.isNaN(val)) {
      map.set(key, val);
    }
  }
  return map;
}

interface RawMetrics {
  promptTokens: number | null;
  generationTokens: number | null;
  kvCacheUsage: number | null;
  requestsRunning: number | null;
  requestsWaiting: number | null;
}

function extractRaw(raw: Map<string, number>): RawMetrics {
  return {
    promptTokens: findGauge(raw, "vllm:prompt_tokens_total"),
    generationTokens: findGauge(raw, "vllm:generation_tokens_total"),
    kvCacheUsage: findGauge(raw, "vllm:kv_cache_usage_perc"),
    requestsRunning: findGauge(raw, "vllm:num_requests_running"),
    requestsWaiting: findGauge(raw, "vllm:num_requests_waiting"),
  };
}

// ── Status line formatting ───────────────────────────────────────────────────

function formatStatus(m: VllmMetrics): string {
  const parts: string[] = [];

  if (m.promptThroughput !== null) {
    parts.push(`P:${m.promptThroughput.toFixed(0)}/s`);
  }
  if (m.generationThroughput !== null) {
    parts.push(`G:${m.generationThroughput.toFixed(0)}/s`);
  }
  if (m.kvCacheUsage !== null) {
    parts.push(`KV:${(m.kvCacheUsage * 100).toFixed(1)}%`);
  }
  if (m.requestsRunning !== null || m.requestsWaiting !== null) {
    const r = m.requestsRunning ?? 0;
    const w = m.requestsWaiting ?? 0;
    parts.push(`Q:${r}+${w}`);
  }

  return parts.length > 0 ? parts.join("  ") : "";
}

// ── Polling ──────────────────────────────────────────────────────────────────

async function fetchRaw(url: string): Promise<RawMetrics> {
  const resp = await fetch(`${url}/metrics`);
  if (!resp.ok) {
    throw new Error(`vLLM /metrics returned ${resp.status}`);
  }
  const text = await resp.text();
  const raw = parsePrometheus(text);
  return extractRaw(raw);
}

function computeMetrics(
  prev: CounterSnapshot | null,
  curr: RawMetrics,
): VllmMetrics {
  const now = Date.now();
  const result: VllmMetrics = {
    promptThroughput: null,
    generationThroughput: null,
    kvCacheUsage: curr.kvCacheUsage,
    requestsRunning: curr.requestsRunning,
    requestsWaiting: curr.requestsWaiting,
  };

  if (prev !== null && curr.promptTokens !== null && curr.generationTokens !== null) {
    const dt = (now - prev.timestamp) / 1000;
    if (dt > 0) {
      const dp = curr.promptTokens - prev.promptTokens;
      const dg = curr.generationTokens - prev.generationTokens;
      if (dp >= 0) result.promptThroughput = dp / dt;
      if (dg >= 0) result.generationThroughput = dg / dt;
    }
  }

  return result;
}

function startPolling(
  config: PluginConfig,
  update: (metrics: VllmMetrics, error: string | null) => void,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = true;
  let prev: CounterSnapshot | null = null;

  async function tick() {
    try {
      const raw = await fetchRaw(config.vllmUrl);
      const metrics = computeMetrics(prev, raw);
      if (raw.promptTokens !== null && raw.generationTokens !== null) {
        prev = {
          promptTokens: raw.promptTokens,
          generationTokens: raw.generationTokens,
          timestamp: Date.now(),
        };
      }
      update(metrics, null);
    } catch (err) {
      update(
        {
          promptThroughput: null,
          generationThroughput: null,
          kvCacheUsage: null,
          requestsRunning: null,
          requestsWaiting: null,
        },
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  tick();
  timer = setInterval(() => {
    if (running) tick();
  }, config.pollInterval);

  return () => {
    running = false;
    if (timer !== null) clearInterval(timer);
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export default function (pi: HookAPI) {
  let stopPolling: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const vllmUrl = process.env.VLLM_METRICS_URL || "http://192.168.0.11:8010";
    const pollInterval = parseInt(process.env.VLLM_METRICS_POLL_MS || "3000", 10);

    // Clear previous status
    ctx.ui.setStatus("vllm-metrics", undefined);

    stopPolling = startPolling({ vllmUrl, pollInterval }, (metrics, error) => {
      if (error) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
          "vllm-metrics",
          theme.fg("error", `vLLM: ${error}`),
        );
        return;
      }

      const text = formatStatus(metrics);
      if (!text) {
        ctx.ui.setStatus("vllm-metrics", undefined);
        return;
      }

      const theme = ctx.ui.theme;
      ctx.ui.setStatus("vllm-metrics", theme.fg("muted", `vLLM: ${text}`));
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (stopPolling) {
      stopPolling();
      stopPolling = null;
    }
    ctx.ui.setStatus("vllm-metrics", undefined);
  });
}
