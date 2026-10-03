import './lib/styles.css';
import App from './App.svelte';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Register relative to the page so the worker scope follows the app path.
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
