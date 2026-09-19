<script>
  import { apiRequest } from '../lib/api.js';
  import { session } from '../lib/auth.js';

  export let goToLogin;

  let fullName = '';
  let email = '';
  let password = '';
  let role = 'student';
  let error = '';
  let loading = false;

  async function handleSubmit() {
    error = '';
    loading = true;
    try {
      const data = await apiRequest('/auth/register', {
        method: 'POST',
        body: { fullName, email, password, role },
      });
      session.set(data);
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="container narrow">
  <h1>Create an account</h1>

  <form class="panel" on:submit|preventDefault={handleSubmit}>
    <div class="field">
      <label for="fullName">Full name</label>
      <input id="fullName" bind:value={fullName} required />
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" bind:value={email} required />
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" type="password" bind:value={password} minlength="8" required />
    </div>
    <div class="field">
      <label for="role">Role</label>
      <select id="role" bind:value={role}>
        <option value="student">Student</option>
        <option value="staff">Staff</option>
        <option value="manager">Manager</option>
        <option value="admin">Admin</option>
      </select>
      <p class="muted role-note">
        In a real deployment only students self-register; staff/manager/admin accounts would be
        created by an administrator. This picker is here so the prototype can demo all four
        dashboards.
      </p>
    </div>

    {#if error}<p class="error-text">{error}</p>{/if}

    <button type="submit" disabled={loading}>{loading ? 'Creating account…' : 'Create account'}</button>
  </form>

  <p class="muted">
    Already have an account?
    <button class="secondary" type="button" on:click={goToLogin}>Log in</button>
  </p>
</div>

<style>
  .narrow {
    max-width: 420px;
  }
  .role-note {
    font-size: 0.8rem;
    margin-top: 0.4em;
  }
</style>
