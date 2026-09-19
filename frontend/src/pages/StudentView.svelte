<script>
  import { onMount, onDestroy } from 'svelte';
  import { apiRequest } from '../lib/api.js';
  import { session } from '../lib/auth.js';
  import { getSocket } from '../lib/socket.js';
  import { notifyOrderReady } from '../lib/notify.js';

  let menu = [];
  let orders = [];
  let cart = {}; // { [menuItemId]: quantity }
  let placingOrder = false;
  let orderError = '';
  let loadError = '';
  let toastMessage = '';

  $: token = $session?.token;

  async function loadMenu() {
    try {
      menu = await apiRequest('/menu', { token });
    } catch (err) {
      loadError = err.message;
    }
  }

  async function loadOrders() {
    try {
      orders = await apiRequest('/orders/mine', { token });
    } catch (err) {
      loadError = err.message;
    }
  }

  function changeQuantity(itemId, delta) {
    const current = cart[itemId] || 0;
    const next = Math.max(0, current + delta);
    cart = { ...cart, [itemId]: next };
  }

  $: cartItems = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([itemId, qty]) => {
      const item = menu.find((m) => m.id === Number(itemId));
      return item ? { ...item, quantity: qty } : null;
    })
    .filter(Boolean);

  $: cartTotal = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

  async function placeOrder() {
    orderError = '';
    if (cartItems.length === 0) return;
    placingOrder = true;
    try {
      await apiRequest('/orders', {
        method: 'POST',
        token,
        body: { items: cartItems.map((i) => ({ menuItemId: i.id, quantity: i.quantity })) },
      });
      cart = {};
      await loadOrders();
    } catch (err) {
      orderError = err.message;
    } finally {
      placingOrder = false;
    }
  }

  function statusBadgeClass(status) {
    if (status === 'ready') return 'badge-green';
    if (status === 'completed') return 'badge-clay';
    return 'badge-amber';
  }

  async function handleStatusChanged({ orderId, status }) {
    const isMyOrder = orders.some((o) => o.id === orderId);
    await loadOrders();
    if (isMyOrder && status === 'ready') {
      const notified = await notifyOrderReady(orderId);
      if (!notified) {
        toastMessage = `Order #${orderId} is ready for pickup!`;
        setTimeout(() => (toastMessage = ''), 6000);
      }
    }
  }

  let socket;
  onMount(() => {
    loadMenu();
    loadOrders();
    socket = getSocket();
    socket.on('orders:statusChanged', handleStatusChanged);
  });
  onDestroy(() => {
    if (socket) socket.off('orders:statusChanged', handleStatusChanged);
  });
</script>

<div class="container">
  {#if toastMessage}
    <div class="panel toast" role="status">{toastMessage}</div>
  {/if}
  {#if loadError}<p class="error-text">{loadError}</p>{/if}

  <section class="panel">
    <h2>Today's menu</h2>
    <ul class="list">
      {#each menu as item}
        <li class="list-item row-between">
          <div>
            <strong>{item.name}</strong>
            {#if item.description}<div class="muted">{item.description}</div>{/if}
            <div class="mono muted">Rs. {item.price}</div>
          </div>
          <div class="row">
            <button class="secondary qty-btn" on:click={() => changeQuantity(item.id, -1)}>−</button>
            <span class="mono">{cart[item.id] || 0}</span>
            <button class="secondary qty-btn" on:click={() => changeQuantity(item.id, 1)}>+</button>
          </div>
        </li>
      {/each}
    </ul>
  </section>

  {#if cartItems.length > 0}
    <section class="panel">
      <h2>Your order</h2>
      <ul class="list">
        {#each cartItems as item}
          <li class="list-item row-between">
            <span>{item.quantity} × {item.name}</span>
            <span class="mono">Rs. {(item.price * item.quantity).toFixed(2)}</span>
          </li>
        {/each}
      </ul>
      <div class="row-between total-row">
        <strong>Total</strong>
        <strong class="mono">Rs. {cartTotal.toFixed(2)}</strong>
      </div>
      {#if orderError}<p class="error-text">{orderError}</p>{/if}
      <button on:click={placeOrder} disabled={placingOrder}>
        {placingOrder ? 'Placing order…' : 'Place pre-order'}
      </button>
    </section>
  {/if}

  <section class="panel">
    <h2>Your orders</h2>
    {#if orders.length === 0}
      <p class="muted">No orders yet — place one above and it will show up here.</p>
    {:else}
      <ul class="list">
        {#each orders as order}
          <li class="list-item">
            <div class="row-between">
              <span class="mono">Order #{order.id}</span>
              <span class="badge {statusBadgeClass(order.status)}">{order.status}</span>
            </div>
            <div class="muted">
              {order.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}
            </div>
            {#if order.estimated_pickup_time}
              <div class="muted">
                Estimated pickup: {new Date(order.estimated_pickup_time).toLocaleTimeString()}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .qty-btn {
    padding: 0.3em 0.7em;
  }
  .total-row {
    padding-top: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .toast {
    border-color: var(--green);
    background: var(--green-bg);
    color: var(--green);
    font-weight: 500;
  }
</style>
