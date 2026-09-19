<script>
  import { onMount } from 'svelte';
  import { apiRequest } from '../lib/api.js';
  import { session } from '../lib/auth.js';

  export let goBack;

  $: token = $session?.token;

  let profile = null;
  let fullName = '';
  let currentPassword = '';
  let newPassword = '';
  let error = '';
  let passwordError = '';
  let saved = false;
  let saving = false;

  async function loadProfile() {
    profile = await apiRequest('/users/me', { token });
    fullName = profile.full_name;
  }

  async function saveName() {
    error = '';
    saved = false;
    try {
      profile = await apiRequest('/users/me', { method: 'PATCH', token, body: { fullName } });
      saved = true;
      // Keep the top bar's name in sync without forcing a re-login.
      session.update((s) => ({ ...s, user: { ...s.user, fullName: profile.full_name } }));
    } catch (err) {
      error = err.message;
    }
  }

  async function changePassword() {
    passwordError = '';
    saving = true;
    try {
      await apiRequest('/users/me', {
        method: 'PATCH',
        token,
        body: { currentPassword, newPassword },
      });
      currentPassword = '';
      newPassword = '';
      passwordError = '__success__'; // reuse the slot below for a success message
    } catch (err) {
      passwordError = err.message;
    } finally {
      saving = false;
    }
  }

  onMount(loadProfile);
</script>

<div class="container narrow">
  <button class="secondary back-btn" on:click={goBack}>&larr; Back</button>
  <h1>Your profile</h1>
  <p class="muted">
    This page only shows your own account details — per the project's privacy requirement (FR-18),
    no one else's information appears here, and managers/admins cannot see this page's contents
    for other users.
  </p>

  {#if profile}
    <section class="panel">
      <h2>Account details</h2>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" value={profile.email} disabled />
      </div>
      <div class="field">
        <label for="role">Role</label>
        <input id="role" value={profile.role} disabled />
      </div>
      <div class="field">
        <label for="memberSince">Member since</label>
        <input id="memberSince" value={new Date(profile.created_at).toLocaleDateString()} disabled />
      </div>

      <div class="field">
        <label for="fullName">Full name</label>
        <input id="fullName" bind:value={fullName} />
      </div>
      {#if error}<p class="error-text">{error}</p>{/if}
      {#if saved}<p class="muted">Saved.</p>{/if}
      <button on:click={saveName}>Save name</button>
    </section>

    <section class="panel">
      <h2>Change password</h2>
      <div class="field">
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" type="password" bind:value={currentPassword} />
      </div>
      <div class="field">
        <label for="newPassword">New password</label>
        <input id="newPassword" type="password" bind:value={newPassword} minlength="8" />
      </div>
      {#if passwordError === '__success__'}
        <p class="muted">Password updated.</p>
      {:else if passwordError}
        <p class="error-text">{passwordError}</p>
      {/if}
      <button on:click={changePassword} disabled={saving || !currentPassword || !newPassword}>
        {saving ? 'Updating…' : 'Update password'}
      </button>
    </section>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .narrow {
    max-width: 480px;
  }
  .back-btn {
    margin-bottom: 1rem;
  }
</style>
