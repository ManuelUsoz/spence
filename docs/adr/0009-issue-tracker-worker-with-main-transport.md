# 0009. Run Issue tracker adapters in a worker with a main-process HTTP transport

Status: accepted

Spence's **Git hosts** subsystem runs its adapters, HTTP client, `Semaphore(4)`, and ETag state in Electron main and offloads only CPU-bound diff parsing and snapshot assembly to `pr-worker`. By contrast, Issue tracker work—especially Azure DevOps batch hydration, HTML-to-Markdown conversion, and 200-summary/30-detail cache assembly—can stall the main event loop and degrade chat latency, while moving raw `fetch` into a Node worker would lose Electron `net.fetch` OS proxy/PAC/NTLM and certificate-store support and expose credentials outside main.

We run Issue tracker adapters, request building, `Semaphore(4)`, coalescing, ETag/delta sync, rate-limit tracking, HTML-to-Markdown conversion, normalization, snapshot bounding, and in-memory cache assembly in a dedicated `issue-worker` thread (`worker_threads`), and bridge outbound requests over a `MessagePort` to a single thin `Transport.execute(requestSpec)` handler in Electron main that attaches `Authorization` via `TrackerAuth` and executes `net.fetch`.

This pattern deliberately diverges from **Git hosts**: `issue-worker` never sees tokens or Electron handles, main stays free for chat and performs only token attachment, `net.fetch`, atomic `Store` writes, and window focus forwarding, and every Issue tracker adapter must be written against the worker-side `Transport` seam rather than calling `net.fetch` directly.
