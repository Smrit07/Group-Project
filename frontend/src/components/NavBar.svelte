<script>
  import { session, logout } from '../lib/auth.js';
  import { currentView } from '../lib/view.js';
</script>

<header class="nav">
  <div class="row-between container nav-inner">
    <div class="brand">Smart Cafeteria</div>
    {#if $session}
      <div class="row">
        <span class="muted">{$session.user.fullName} · {$session.user.role}</span>
        <button class="secondary" on:click={() => currentView.set('profile')}>Profile</button>
        <button class="secondary" on:click={() => { logout(); currentView.set('dashboard'); }}>Log out</button>
      </div>
    {/if}
  </div>
</header>

<style>
  .nav {
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .nav-inner {
    padding-top: 0.9rem;
    padding-bottom: 0.9rem;
    max-width: 880px;
  }
  .brand {
    font-weight: 700;
    font-size: 1.05rem;
  }
</style>
