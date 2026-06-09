import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

interface VllmMetrics {
  promptThroughput: number | null;
  generationThroughput: number | null;
  kvCacheUsage: number | null;
  kvGrowthRate: number | null;
  requestsRunning: number | null;
  requestsWaiting: number | null;
}

interface CounterSnapshot {
  promptTokens: number;
  generationTokens: number;
  kvCacheTokens: number;
  timestamp: number;
}


interface PluginConfig {
  vllmUrl: string;
  pollInterval: number;
  maxContextTokens: number;
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

function findGauge(map: Map<string, number>, name: string): number | null {
  for (const [key, val] of map) {
    if (key.startsWith(name) && (key.length === name.length || key[name.length] === "{")) {
      return val;
    }
  }
  return null;
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
    const kv = (m.kvCacheUsage * 100).toFixed(1);
    if (m.kvGrowthRate !== null) {
      parts.push(`KV:${kv}% +${m.kvGrowthRate.toFixed(1)}/s`);
    } else {
      parts.push(`KV:${kv}%`);
    }
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
  maxContextTokens: number,
): VllmMetrics {
  const now = Date.now();
  const result: VllmMetrics = {
    promptThroughput: null,
    generationThroughput: null,
    kvCacheUsage: curr.kvCacheUsage,
    kvGrowthRate: null,
    requestsRunning: curr.requestsRunning,
    requestsWaiting: curr.requestsWaiting,
  };

  if (prev !== null) {
    const dt = (now - prev.timestamp) / 1000;
    if (dt > 0) {
      if (curr.promptTokens !== null) {
        const dp = curr.promptTokens - prev.promptTokens;
        if (dp >= 0) result.promptThroughput = dp / dt;
      }
      if (curr.generationTokens !== null) {
        const dg = curr.generationTokens - prev.generationTokens;
        if (dg >= 0) result.generationThroughput = dg / dt;
      }
      if (prev.kvCacheTokens !== null && curr.kvCacheUsage !== null) {
        const currKvTokens = curr.kvCacheUsage * maxContextTokens;
        const dkv = currKvTokens - prev.kvCacheTokens;
        if (dkv >= 0) result.kvGrowthRate = dkv / dt;
      }
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
      const metrics = computeMetrics(prev, raw, config.maxContextTokens);
      if (raw.promptTokens !== null && raw.generationTokens !== null) {
        const kvTokens = raw.kvCacheUsage !== null
          ? raw.kvCacheUsage * config.maxContextTokens
          : null;
        prev = {
          promptTokens: raw.promptTokens,
          generationTokens: raw.generationTokens,
          kvCacheTokens: kvTokens ?? prev?.kvCacheTokens ?? 0,
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
          kvGrowthRate: null,
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

export default function (pi: ExtensionAPI) {
  let stopPolling: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const vllmUrl = process.env.VLLM_METRICS_URL || "http://192.168.0.11:8010";
    const pollInterval = parseInt(process.env.VLLM_METRICS_POLL_MS || "3000", 10);
    const maxContextTokens = parseInt(process.env.VLLM_METRICS_MAX_CTX || "218000", 10);

    // Clear previous status
    ctx.ui.setStatus("vllm-metrics", undefined);

    stopPolling = startPolling({ vllmUrl, pollInterval, maxContextTokens }, (metrics, error) => {
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
