import type { HookAPI } from "@oh-my-pi/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

interface VllmMetrics {
  promptThroughput: number | null;
  generationThroughput: number | null;
  kvCacheUsage: number | null;
  requestsRunning: number | null;
  requestsWaiting: number | null;
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

function extractMetrics(raw: Map<string, number>): VllmMetrics {
  return {
    promptThroughput: findGauge(raw, "vllm:avg_prompt_throughput_toks_per_s"),
    generationThroughput: findGauge(raw, "vllm:avg_generation_throughput_toks_per_s"),
    kvCacheUsage: findGauge(raw, "vllm:gpu_cache_usage_perc"),
    requestsRunning: findGauge(raw, "vllm:num_requests_running"),
    requestsWaiting: findGauge(raw, "vllm:num_requests_waiting"),
  };
}

function findGauge(map: Map<string, number>, name: string): number | null {
  // Prometheus labels use {…} syntax; strip them for matching
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

async function fetchMetrics(url: string): Promise<VllmMetrics> {
  const resp = await fetch(`${url}/metrics`);
  if (!resp.ok) {
    throw new Error(`vLLM /metrics returned ${resp.status}`);
  }
  const text = await resp.text();
  const raw = parsePrometheus(text);
  return extractMetrics(raw);
}

function startPolling(
  config: PluginConfig,
  update: (metrics: VllmMetrics, error: string | null) => void,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = true;

  async function tick() {
    try {
      const m = await fetchMetrics(config.vllmUrl);
      update(m, null);
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
