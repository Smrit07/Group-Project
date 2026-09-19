// Wraps the browser Notification API with a graceful fallback: if the
// user hasn't granted permission (or their browser doesn't support it),
// callers should also show an in-page toast — see StudentView.svelte.
export async function notifyOrderReady(orderId) {
  if (!('Notification' in window)) return false;

  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission === 'granted') {
    new Notification('Your order is ready!', {
      body: `Order #${orderId} is ready for pickup.`,
      tag: `order-${orderId}`, // avoids duplicate notifications for the same order
    });
    return true;
  }
  return false;
}
