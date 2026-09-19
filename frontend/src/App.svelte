<script>
  import { session } from './lib/auth.js';
  import { currentView } from './lib/view.js';
  import NavBar from './components/NavBar.svelte';
  import QueueBanner from './components/QueueBanner.svelte';
  import Login from './pages/Login.svelte';
  import Register from './pages/Register.svelte';
  import Profile from './pages/Profile.svelte';
  import StudentView from './pages/StudentView.svelte';
  import StaffView from './pages/StaffView.svelte';
  import ManagementView from './pages/ManagementView.svelte';

  let authPage = 'login'; // 'login' | 'register'
</script>

<NavBar />

{#if !$session}
  <div class="container auth-wrap">
    {#if authPage === 'login'}
      <Login goToRegister={() => (authPage = 'register')} />
    {:else}
      <Register goToLogin={() => (authPage = 'login')} />
    {/if}
  </div>
{:else if $currentView === 'profile'}
  <Profile goBack={() => currentView.set('dashboard')} />
{:else}
  <div class="container">
    <QueueBanner />
  </div>

  {#if $session.user.role === 'student'}
    <StudentView />
  {:else if $session.user.role === 'staff'}
    <StaffView />
  {:else}
    <!-- manager and admin share the same management dashboard -->
    <ManagementView />
  {/if}
{/if}

<style>
  .auth-wrap {
    padding-top: 3rem;
  }
</style>
