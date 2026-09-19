<script>
  import { onMount } from 'svelte';
  import { apiRequest } from '../lib/api.js';
  import { session } from '../lib/auth.js';
  import StaffView from './StaffView.svelte';
  import SimulationPanel from '../components/SimulationPanel.svelte';

  $: token = $session?.token;

  // --- Menu management ---
  let menu = [];
  let newItem = { name: '', description: '', price: '' };
  let menuError = '';

  async function loadMenu() {
    menu = await apiRequest('/menu', { token });
  }

  async function addMenuItem() {
    menuError = '';
    try {
      await apiRequest('/menu', {
        method: 'POST',
        token,
        body: { ...newItem, price: Number(newItem.price) },
      });
      newItem = { name: '', description: '', price: '' };
      await loadMenu();
    } catch (err) {
      menuError = err.message;
    }
  }

  async function toggleAvailability(item) {
    await apiRequest(`/menu/${item.id}`, {
      method: 'PUT',
      token,
      body: { isAvailable: !item.is_available },
    });
    await loadMenu();
  }

  async function removeMenuItem(item) {
    await apiRequest(`/menu/${item.id}`, { method: 'DELETE', token });
    await loadMenu();
  }

  // --- Reports ---
  let summary = null;
  let reportError = '';
  let reportPeriod = 'weekly';

  async function loadSummary() {
    try {
      summary = await apiRequest(`/reports/summary?period=${reportPeriod}`, { token });
    } catch (err) {
      reportError = err.message;
    }
  }

  onMount(() => {
    loadMenu();
    loadSummary();
  });
</script>

<div class="container">
  <section class="panel">
    <div class="row-between">
      <h2>Summary</h2>
      <select bind:value={reportPeriod} on:change={loadSummary} class="period-select">
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
        <option value="semester">Semester</option>
      </select>
    </div>
    {#if reportError}
      <p class="error-text">{reportError}</p>
    {:else if summary}
      <div class="stat-grid">
        <div>
          <div class="mono stat-value">{summary.avgWaitMinutes ?? '—'}</div>
          <div class="muted">avg. wait (min)</div>
        </div>
        <div>
          <div class="mono stat-value">{summary.maxQueueLength ?? '—'}</div>
          <div class="muted">peak queue length</div>
        </div>
        <div>
          <div class="mono stat-value">{summary.totalOrders}</div>
          <div class="muted">orders</div>
        </div>
        <div>
          <div class="mono stat-value">{summary.openCounters}/{summary.totalCounters}</div>
          <div class="muted">counters open</div>
        </div>
        <div>
          <div class="mono stat-value">{summary.staffOnDuty}</div>
          <div class="muted">staff on duty</div>
        </div>
      </div>
    {:else}
      <p class="muted">Loading…</p>
    {/if}
  </section>

  <StaffView embedded={true} allowStaffAssignment={true} />

  <section class="panel">
    <h2>Menu management</h2>
    <ul class="list">
      {#each menu as item}
        <li class="list-item row-between">
          <div>
            <strong>{item.name}</strong>
            <span class="mono muted"> — Rs. {item.price}</span>
          </div>
          <div class="row">
            <span class="badge {item.is_available ? 'badge-green' : 'badge-clay'}">
              {item.is_available ? 'available' : 'hidden'}
            </span>
            <button class="secondary" on:click={() => toggleAvailability(item)}>
              {item.is_available ? 'Hide' : 'Show'}
            </button>
            <button class="danger" on:click={() => removeMenuItem(item)}>Delete</button>
          </div>
        </li>
      {/each}
    </ul>

    <hr class="divider" />

    <h3>Add item</h3>
    <form on:submit|preventDefault={addMenuItem}>
      <div class="field">
        <label for="itemName">Name</label>
        <input id="itemName" bind:value={newItem.name} required />
      </div>
      <div class="field">
        <label for="itemDesc">Description</label>
        <input id="itemDesc" bind:value={newItem.description} />
      </div>
      <div class="field">
        <label for="itemPrice">Price (Rs.)</label>
        <input id="itemPrice" type="number" step="0.01" bind:value={newItem.price} required />
      </div>
      {#if menuError}<p class="error-text">{menuError}</p>{/if}
      <button type="submit">Add to menu</button>
    </form>
  </section>

  <SimulationPanel />
</div>

<style>
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1rem;
  }
  .stat-value {
    font-size: 1.4rem;
  }
  .period-select {
    width: auto;
  }
</style>
