<script>
  import { apiRequest } from '../lib/api.js';
  import { session } from '../lib/auth.js';

  export let goToRegister;

  let email = '';
  let password = '';
  let error = '';
  let loading = false;

  async function handleSubmit() {
    error = '';
    loading = true;
    try {
      const data = await apiRequest('/auth/login', { method: 'POST', body: { email, password } });
      session.set(data);
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="container narrow">
  <h1>Log in</h1>
  <p class="muted">Use your student, staff, manager or admin account.</p>

  <form class="panel" on:submit|preventDefault={handleSubmit}>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" bind:value={email} required />
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" type="password" bind:value={password} required />
    </div>

    {#if error}<p class="error-text">{error}</p>{/if}

    <button type="submit" disabled={loading}>{loading ? 'Logging in…' : 'Log in'}</button>
  </form>

  <p class="muted">
    No account yet?
    <button class="secondary" type="button" on:click={goToRegister}>Register</button>
  </p>
</div>

<style>
  .narrow {
    max-width: 420px;
  }
</style>
