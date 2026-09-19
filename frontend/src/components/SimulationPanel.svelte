<script>
  // ---------------------------------------------------------------------------
  // What-if staffing simulation (FR-12, FR-13).
  // ---------------------------------------------------------------------------
  // The old version posted the form and dumped JSON.stringify(results) into a
  // <pre>. That is not a decision-support tool — it is a debugging aid that
  // happened to ship. A cafeteria manager needs to read an answer, not parse
  // one, so this panel does three things the raw dump could not:
  //
  //   1. Checks the engine is up *before* the form is used, so an unavailable
  //      engine is a greyed-out panel with an instruction, not a failed submit.
  //   2. Renders the headline figures with their confidence intervals, because
  //      a simulated mean without an interval invites more confidence than the
  //      number deserves (and FR-04 requires estimates to be labelled as such).
  //   3. Offers side-by-side comparison, which is the question the manager
  //      interview in Section 4.1 actually asked: not "how bad is today" but
  //      "is it better to open another counter or add a second person here".
  // ---------------------------------------------------------------------------
  import { onMount } from 'svelte';
  import { apiRequest, ApiError } from '../lib/api.js';
  import { session } from '../lib/auth.js';

  $: token = $session?.token;

  // --- engine availability -------------------------------------------------
  let engine = { available: null, message: '' };

  async function checkEngine() {
    try {
      const status = await apiRequest('/simulations/engine', { token });
      engine = {
        available: status.available,
        modelVersion: status.modelVersion,
        message: status.available ? '' : status.message || 'The simulation engine is not running.',
      };
    } catch (err) {
      engine = { available: false, message: err.message };
    }
  }

  // --- single scenario -----------------------------------------------------
  let scenario = {
    scenarioName: '',
    countersOpen: 2,
    staffCount: 3,
    arrivalRatePerHour: 55,
    preorderShare: 0.35,
  };

  let result = null;
  let error = '';
  let running = false;

  async function runScenario() {
    error = '';
    result = null;
    running = true;
    try {
      const response = await apiRequest('/simulations', {
        method: 'POST',
        token,
        // A scenario run can legitimately take 20s or more: the engine keeps
        // adding replications until the confidence interval is tight enough.
        // The default 30s client timeout would abort a perfectly healthy run.
        timeoutMs: 40000,
        body: scenario,
      });
      result = response;
      await loadHistory();
    } catch (err) {
      error = err.message;
      // A 503 here means the engine died between the availability check and
      // the submit — worth re-checking so the panel updates rather than
      // leaving the user to guess.
      if (err instanceof ApiError && err.isServiceUnavailable) await checkEngine();
    } finally {
      running = false;
    }
  }

  // --- comparison ----------------------------------------------------------
  let comparison = null;
  let comparing = false;
  let compareError = '';

  /**
   * Build the three options a manager actually chooses between, all anchored on
   * whatever they have typed into the form. Under the hood the engine runs
   * these with common random numbers, so the differences below are caused by
   * the configuration and not by one option getting a quieter simulated day.
   */
  function buildComparisonSet() {
    const base = {
      arrivalRatePerHour: scenario.arrivalRatePerHour,
      preorderShare: scenario.preorderShare,
    };
    return [
      {
        label: `${scenario.countersOpen} counters, ${scenario.staffCount} staff (as entered)`,
        countersOpen: scenario.countersOpen,
        staffCount: scenario.staffCount,
        ...base,
      },
      {
        label: `${scenario.countersOpen + 1} counters, ${scenario.staffCount + 1} staff`,
        countersOpen: scenario.countersOpen + 1,
        staffCount: scenario.staffCount + 1,
        ...base,
      },
      {
        label: `Same counters, ${scenario.staffCount + 2} staff`,
        countersOpen: scenario.countersOpen,
        staffCount: scenario.staffCount + 2,
        ...base,
      },
      {
        label: 'As entered, but 60% pre-order',
        countersOpen: scenario.countersOpen,
        staffCount: scenario.staffCount,
        arrivalRatePerHour: scenario.arrivalRatePerHour,
        preorderShare: 0.6,
      },
    ];
  }

  async function runComparison() {
    compareError = '';
    comparison = null;
    comparing = true;
    try {
      comparison = await apiRequest('/simulations/compare', {
        method: 'POST',
        token,
        timeoutMs: 40000,
        body: { scenarios: buildComparisonSet() },
      });
    } catch (err) {
      compareError = err.message;
    } finally {
      comparing = false;
    }
  }

  // --- history -------------------------------------------------------------
  let history = [];

  async function loadHistory() {
    try {
      history = await apiRequest('/simulations?limit=8', { token });
    } catch {
      history = [];
    }
  }

  async function deleteScenario(id) {
    try {
      await apiRequest(`/simulations/${id}`, { method: 'DELETE', token });
      await loadHistory();
    } catch (err) {
      error = err.message;
    }
  }

  function ratingClass(rating) {
    if (rating === 'comfortable') return 'badge-green';
    if (rating === 'acceptable') return 'badge-amber';
    return 'badge-clay';
  }

  function formatCi(metric) {
    if (!metric || metric.mean === null) return '—';
    return `${metric.mean} (95% CI ${metric.ci_low}–${metric.ci_high})`;
  }

  onMount(() => {
    checkEngine();
    loadHistory();
  });
</script>

<section class="panel">
  <div class="row-between">
    <h2>Staffing simulation</h2>
    {#if engine.available === true}
      <span class="badge badge-green">engine ready</span>
    {:else if engine.available === false}
      <span class="badge badge-clay">engine offline</span>
    {/if}
  </div>

  {#if engine.available === false}
    <!-- NFR-09: degrade with an instruction, not a stack trace. -->
    <p class="error-text">{engine.message}</p>
    <p class="muted small">
      Start it from the project root: <code>cd des-engine</code> then
      <code>python app.py</code> — or run <code>deploy/start-smart-cafeteria.bat</code>,
      which starts the API and the engine together. Everything else on this page
      keeps working without it.
    </p>
    <button type="button" on:click={checkEngine}>Check again</button>
  {:else}
    <p class="muted small">
      Runs a discrete-event simulation of the 09:00–10:00 break with the
      configuration below. Figures are simulation estimates, not guaranteed
      times.
    </p>

    <form on:submit|preventDefault={runScenario}>
      <div class="field">
        <label for="scenarioName">Scenario name</label>
        <input
          id="scenarioName"
          bind:value={scenario.scenarioName}
          placeholder="e.g. Exam week — 3 counters"
          required
        />
      </div>
      <div class="row">
        <div class="field">
          <label for="countersOpen">Counters open</label>
          <input id="countersOpen" type="number" min="1" max="20" bind:value={scenario.countersOpen} />
        </div>
        <div class="field">
          <label for="staffCount">Staff on duty</label>
          <input id="staffCount" type="number" min="1" max="60" bind:value={scenario.staffCount} />
        </div>
        <div class="field">
          <label for="arrivalRate">Students / hour</label>
          <input
            id="arrivalRate"
            type="number"
            min="1"
            max="3000"
            bind:value={scenario.arrivalRatePerHour}
          />
        </div>
        <div class="field">
          <label for="preorder">Pre-ordering ({Math.round(scenario.preorderShare * 100)}%)</label>
          <input
            id="preorder"
            type="range"
            min="0"
            max="1"
            step="0.05"
            bind:value={scenario.preorderShare}
          />
        </div>
      </div>

      {#if scenario.staffCount < scenario.countersOpen}
        <!-- Caught here rather than silently corrected by the model, because a
             manager who types this has made a planning error worth seeing. -->
        <p class="warn-text">
          {scenario.countersOpen} counters need at least {scenario.countersOpen} staff. The
          model will only run {scenario.staffCount} of them.
        </p>
      {/if}

      {#if error}<p class="error-text">{error}</p>{/if}

      <div class="row">
        <button type="submit" disabled={running || comparing}>
          {running ? 'Simulating…' : 'Run scenario'}
        </button>
        <button type="button" class="secondary" on:click={runComparison} disabled={running || comparing}>
          {comparing ? 'Comparing…' : 'Compare four options'}
        </button>
      </div>
    </form>
  {/if}

  {#if result}
    {@const r = result.results}
    <div class="result">
      <div class="row-between">
        <h3>{result.scenarioName}</h3>
        <span class="badge {ratingClass(r.verdict?.rating)}">{r.verdict?.rating}</span>
      </div>

      <p class="headline">{r.verdict?.headline}</p>

      <div class="stat-grid">
        <div>
          <div class="mono stat-value">{r.avgWaitMinutes}</div>
          <div class="muted small">avg wait (min)</div>
        </div>
        <div>
          <div class="mono stat-value">{r.p90WaitMinutes}</div>
          <div class="muted small">9 in 10 served within</div>
        </div>
        <div>
          <div class="mono stat-value">{r.maxQueueLength}</div>
          <div class="muted small">longest queue</div>
        </div>
        <div>
          <div class="mono stat-value">{r.counterUtilisationPercent}%</div>
          <div class="muted small">counter busy time</div>
        </div>
        <div>
          <div class="mono stat-value">{r.balkRatePercent}%</div>
          <div class="muted small">walk away unserved</div>
        </div>
        <div>
          <div class="mono stat-value">{r.throughputPerHour}</div>
          <div class="muted small">served per hour</div>
        </div>
      </div>

      {#if r.verdict?.reasons?.length}
        <ul class="reasons">
          {#each r.verdict.reasons as reason}
            <li>{reason}</li>
          {/each}
        </ul>
      {/if}

      {#if r.sensitivity?.length}
        <h4>One counter either way</h4>
        <ul class="reasons">
          {#each r.sensitivity as variant}
            <li>
              {variant.countersOpen} counters → {variant.meanWaitMinutes} min
              <span class="muted">
                ({variant.deltaVsBaseMinutes > 0 ? '+' : ''}{variant.deltaVsBaseMinutes} min vs this
                scenario)
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      <details>
        <summary class="muted small">Model detail and confidence intervals</summary>
        <table class="detail-table">
          <tbody>
            <tr><th>Mean wait (min)</th><td class="mono">{formatCi(r.metrics?.meanWaitMinutes)}</td></tr>
            <tr><th>90th percentile wait</th><td class="mono">{formatCi(r.metrics?.p90WaitMinutes)}</td></tr>
            <tr><th>Longest queue</th><td class="mono">{formatCi(r.metrics?.maxQueueLength)}</td></tr>
            <tr><th>Replications</th><td class="mono">{r.run?.replications}</td></tr>
            <tr><th>Precision</th><td class="mono">{r.run?.precisionNote}</td></tr>
            <tr><th>Peak offered load</th><td class="mono">{r.scenario?.peakOfferedLoad}</td></tr>
            <tr><th>Service time source</th><td class="mono">{r.calibration?.source}</td></tr>
            <tr><th>Random seed</th><td class="mono">{r.run?.seed}</td></tr>
          </tbody>
        </table>
        <p class="muted small">{r.calibration?.note}</p>
      </details>

      <p class="muted small">{r.disclaimer}</p>
    </div>
  {/if}

  {#if compareError}<p class="error-text">{compareError}</p>{/if}

  {#if comparison}
    <div class="result">
      <h3>Options compared</h3>
      <p class="muted small">
        All four were run against the same simulated students, so the differences
        are caused by the configuration rather than by a quieter day.
      </p>
      <table class="detail-table">
        <thead>
          <tr>
            <th>Option</th>
            <th>Avg wait</th>
            <th>Longest queue</th>
            <th>Walk away</th>
            <th>vs best</th>
          </tr>
        </thead>
        <tbody>
          {#each comparison.scenarios as row}
            <tr class:best={row.label === comparison.recommended}>
              <td>{row.label}</td>
              <td class="mono">{row.avgWaitMinutes} min</td>
              <td class="mono">{row.maxQueueLength}</td>
              <td class="mono">{row.balkRatePercent}%</td>
              <td class="mono">
                {row.deltaVsBestMinutes === 0 ? 'best' : `+${row.deltaVsBestMinutes} min`}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if history.length}
    <h4>Recent scenarios</h4>
    <table class="detail-table">
      <thead>
        <tr><th>Scenario</th><th>Avg wait</th><th>Rating</th><th>Run by</th><th></th></tr>
      </thead>
      <tbody>
        {#each history as item}
          <tr>
            <td>{item.scenarioName}</td>
            <td class="mono">{item.headline?.avgWaitMinutes ?? '—'} min</td>
            <td>
              {#if item.headline?.rating}
                <span class="badge {ratingClass(item.headline.rating)}">{item.headline.rating}</span>
              {:else}—{/if}
            </td>
            <td class="muted small">{item.createdByName ?? '—'}</td>
            <td>
              <button type="button" class="link" on:click={() => deleteScenario(item.id)}>Remove</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .result {
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  .headline {
    margin: 0.35rem 0 1rem;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .stat-value {
    font-size: 1.4rem;
  }
  .reasons {
    margin: 0 0 1rem;
    padding-left: 1.1rem;
  }
  .reasons li {
    margin-bottom: 0.3rem;
  }
  .detail-table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.5rem 0 1rem;
  }
  .detail-table th,
  .detail-table td {
    text-align: left;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .detail-table tr.best td {
    font-weight: 500;
  }
  .small {
    font-size: 0.85rem;
  }
  .warn-text {
    color: var(--amber, #a06a00);
    font-size: 0.9rem;
  }
  button.link {
    background: none;
    border: none;
    padding: 0;
    width: auto;
    text-decoration: underline;
    cursor: pointer;
    font-size: 0.85rem;
  }
  button.secondary {
    background: var(--surface);
    color: inherit;
    border: 1px solid var(--border);
  }
</style>
