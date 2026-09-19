<script>
  import { onMount, onDestroy } from 'svelte';
  import { apiRequest } from '../lib/api.js';
  import { session } from '../lib/auth.js';
  import { getSocket } from '../lib/socket.js';

  export let embedded = false; // true when rendered inside ManagementView
  export let allowStaffAssignment = false; // NFR-10: only manager/admin can reassign staff

  let board = [];
  let counters = [];
  let staffList = [];
  let error = '';

  $: token = $session?.token;

  const NEXT_STATUS = {
    received: 'preparing',
    preparing: 'ready',
    ready: 'completed',
  };

  async function loadBoard() {
    try {
      board = await apiRequest('/orders/board', { token });
    } catch (err) {
      error = err.message;
    }
  }

  async function loadCounters() {
    try {
      counters = await apiRequest('/counters', { token });
    } catch (err) {
      error = err.message;
    }
  }

  async function loadStaffList() {
    if (!allowStaffAssignment) return;
    try {
      staffList = await apiRequest('/users?role=staff', { token });
    } catch (err) {
      error = err.message;
    }
  }

  async function advanceOrder(order) {
    const next = NEXT_STATUS[order.status];
    if (!next) return;
    try {
      await apiRequest(`/orders/${order.id}/status`, { method: 'PATCH', token, body: { status: next } });
      await loadBoard();
    } catch (err) {
      error = err.message;
    }
  }

  async function toggleCounter(counter) {
    try {
      await apiRequest(`/counters/${counter.id}`, {
        method: 'PATCH',
        token,
        body: { isOpen: !counter.is_open },
      });
      await loadCounters();
    } catch (err) {
      error = err.message;
    }
  }

  async function assignStaff(counter, event) {
    const staffId = event.target.value ? Number(event.target.value) : null;
    try {
      await apiRequest(`/counters/${counter.id}`, {
        method: 'PATCH',
        token,
        body: { isOpen: counter.is_open, assignedStaffId: staffId },
      });
      await loadCounters();
    } catch (err) {
      error = err.message;
    }
  }

  let socket;
  onMount(() => {
    loadBoard();
    loadCounters();
    loadStaffList();
    socket = getSocket();
    socket.on('orders:new', loadBoard);
    socket.on('orders:statusChanged', loadBoard);
    socket.on('counters:updated', loadCounters);
  });
  onDestroy(() => {
    if (socket) {
      socket.off('orders:new', loadBoard);
      socket.off('orders:statusChanged', loadBoard);
      socket.off('counters:updated', loadCounters);
    }
  });
</script>

<div class={embedded ? '' : 'container'}>
  {#if error}<p class="error-text">{error}</p>{/if}

  <section class="panel">
    <h2>Order board</h2>
    {#if board.length === 0}
      <p class="muted">No active orders right now.</p>
    {:else}
      <ul class="list">
        {#each board as order}
          <li class="list-item row-between">
            <div>
              <span class="mono">#{order.id}</span> — {order.student_name}
              <span class="badge badge-amber status-badge">{order.status}</span>
            </div>
            {#if NEXT_STATUS[order.status]}
              <button on:click={() => advanceOrder(order)}>
                Mark {NEXT_STATUS[order.status]}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="panel">
    <h2>Counters</h2>
    <ul class="list">
      {#each counters as counter}
        <li class="list-item row-between">
          <div>
            <strong>{counter.name}</strong>
            {#if !allowStaffAssignment && counter.staff_name}
              <span class="muted"> — {counter.staff_name}</span>
            {/if}
          </div>
          <div class="row">
            {#if allowStaffAssignment}
              <select
                class="assign-select"
                value={counter.assigned_staff_id ?? ''}
                on:change={(e) => assignStaff(counter, e)}
              >
                <option value="">Unassigned</option>
                {#each staffList as staffMember}
                  <option value={staffMember.id}>{staffMember.full_name}</option>
                {/each}
              </select>
            {/if}
            <span class="badge {counter.is_open ? 'badge-green' : 'badge-clay'}">
              {counter.is_open ? 'open' : 'closed'}
            </span>
            <button class="secondary" on:click={() => toggleCounter(counter)}>
              {counter.is_open ? 'Close' : 'Open'}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .status-badge {
    margin-left: 0.5em;
  }
  .assign-select {
    width: auto;
    max-width: 160px;
  }
</style>
