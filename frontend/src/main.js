import './lib/styles.css';
import App from './App.svelte';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Registered relative to the page, not from '/'. The app may be served
    // from a htdocs subdirectory under XAMPP, and an absolute '/sw.js' would
    // either 404 or register with a scope covering the whole server.
    const swUrl = new URL('sw.js', document.baseURI).href;
    navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

const app = new App({
  target: document.getElementById('app'),
});

export default app;
