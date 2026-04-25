if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(err => {
    console.error("Eclipse CDN service worker failed to register:", err);
  });
}
