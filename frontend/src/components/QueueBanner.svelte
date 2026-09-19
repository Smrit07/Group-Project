<script>
  // ---------------------------------------------------------------------------
  // The always-visible live queue banner (FR-02, FR-03, FR-04, FR-15).
  // ---------------------------------------------------------------------------
  // This is the one number the whole project exists to show, so the banner is
  // explicit about how good it is. Three states that the previous version
  // collapsed into one:
  //
  //   * simulated   — the DES engine answered. High confidence, shown plainly.
  //   * approximate — the engine was unreachable and this is queue ÷ counters.
  //                   Still useful, but the user is told (NFR-09).
  //   * stale       — the socket has dropped, so the number may be minutes old.
  //                   Silently showing a stale queue length is worse than
  //                   showing none, because the entire value is currency.
  // ---------------------------------------------------------------------------
  import { onMount, onDestroy } from 'svelte';
  import { apiRequest } from '../lib/api.js';
  import { subscribe, socketConnected } from '../lib/socket.js';

  let data = null;
  let errored = false;
  let lastUpdated = null;

  async function refresh() {
    try {
      // Short timeout: this fires on a timer and on every socket event, so a
      // hung request must not pile up behind the next one.
      data = await apiRequest('/queue', { timeoutMs: 8000 });
      lastUpdated = Date.now();
      errored = false;
    } catch {
      // FR-04 / NFR-09: degrade, never break the page.
      errored = true;
    }
  }

  let pollTimer;
  let unsubscribe;

  // When the socket is down the banner is the only thing that notices, so it
  // polls faster to compensate rather than leaving the user with a frozen
  // number.
  $: pollInterval = $socketConnected ? 20000 : 7000;

  $: if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, pollInterval);
  }

  onMount(() => {
    refresh();
    pollTimer = setInterval(refresh, pollInterval);
    unsubscribe = subscribe(['orders:new', 'orders:statusChanged', 'counters:updated'], refresh);

    // Phones suspend timers in a backgrounded tab, so a user returning to the
    // app would otherwise read a number from whenever they last looked.
    document.addEventListener('visibilitychange', onVisible);
  });

  function onVisible() {
    if (document.visibilityState === 'visible') refresh();
  }

  onDestroy(() => {
    clearInterval(pollTimer);
    if (unsubscribe) unsubscribe();
    document.removeEventListener('visibilitychange', onVisible);
  });
</script>

<div class="queue-banner" role="status" aria-live="polite">
  {#if errored}
    <span class="muted">Live queue is unavailable right now.</span>
  {:else if data === null}
    <span class="muted">Loading queue…</span>
  {:else}
    <span class="mono queue-count">{data.queueLength}</span>
    <span class="muted">in queue</span>
    <span class="dot">·</span>
    <span class="muted">
      {data.openCounters} counter{data.openCounters === 1 ? '' : 's'} open
    </span>
    <span class="dot">·</span>

    {#if data.estimatedWaitMinutes === null}
      <span class="badge badge-clay">no counters open</span>
    {:else}
      <span class="badge badge-amber">~{data.estimatedWaitMinutes} min wait (estimate)</span>
      {#if data.p90WaitMinutes}
        <span class="muted tiny">most people under {data.p90WaitMinutes} min</span>
      {/if}
    {/if}

    {#if data.source === 'live_count'}
      <!-- The DES engine is down. Say so rather than passing off the fallback
           arithmetic as a simulated prediction. -->
      <span class="muted tiny" title={data.note}>approximate — simulation offline</span>
    {/if}

    {#if !$socketConnected}
      <span class="badge badge-clay tiny">reconnecting…</span>
    {/if}
  {/if}
</div>

<style>
  .queue-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0.6rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 1.25rem;
  }
  .queue-count {
    font-size: 1.1rem;
    font-weight: 500;
  }
  .dot {
    color: var(--border);
  }
  .tiny {
    font-size: 0.78rem;
  }
</style>
